// src/api/chat.ts
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { env } from "../lib/env";
import { prisma } from "../lib/prisma";
import { createToolset } from "../tools";
import { searchDocuments } from "../rag/search";
import { claimCheck } from "../claimcheck/claim_checker";
import { createTelemetry } from "../metrics/telemetry";
import { streamWithFallback } from "../llm/retry";
import { recordPromptAudit } from "../metrics/audit";
import type { CoreMessage } from "ai";

// ---------- request schema
const requestSchema = z.object({
  passcode: z.string().min(4).optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string().min(1),
      })
    )
    .min(1),
});

// ---------- utils
type SSESender = (event: string, data: unknown) => void;

function sseSend(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function formatCitations(result: Awaited<ReturnType<typeof searchDocuments>>) {
  return result.chunks.map((chunk, index) => ({
    id: `${index + 1}`,
    title: chunk.title,
    href: chunk.href,
    similarity: chunk.similarity,
    hybridScore: (chunk as any).hybridScore ?? undefined,
    jurisdiccion: (chunk as any).jurisdiccion ?? undefined,
    tipo: (chunk as any).tipo ?? undefined,
    anio: (chunk as any).anio ?? undefined,
    snippet:
      chunk.content.length > 280
        ? `${chunk.content.slice(0, 280)}…`
        : chunk.content,
  }));
}

function buildSystemPrompt(passcodeVerified: boolean): string {
  return `Eres el Copiloto Tributario de Laburen.
Respondes SIEMPRE así, en este orden:

1) Respuesta directa: qué se puede afirmar con lo recuperado.
2) Lo que NO se puede afirmar: qué falta o no aparece.
3) Citas [[n]]: solo de los fragmentos recuperados.
4) Siguiente paso: cómo afinar la búsqueda (jurisdicción, año, tipo).

Reglas:
- Usa SOLO los fragmentos recuperados. Si no están, di: "no está en el corpus recuperado".
- Si la pregunta es sobre una exención muy específica y no aparece textual, di que no aparece.
- Puedes decir: "lo más cercano que encontré es X" y citarlo.
- Si el passcode no es válido, NO ejecutes herramientas comerciales.
- Estado del passcode: ${passcodeVerified ? "VALIDADO" : "NO VALIDADO"}.`;
}

function toCoreMessage(
  role: "system" | "user" | "assistant",
  text: string
): CoreMessage {
  return { role, content: text };
}

// detección barata y auditable
function detectJurisdiccionesFromText(text: string): string[] | undefined {
  const t = text.toLowerCase();
  const out = new Set<string>();

  if (
    t.includes("caba") ||
    t.includes("ciudad de buenos aires") ||
    t.includes("gcba")
  ) {
    out.add("AR-CABA");
  }
  if (
    t.includes("provincia de buenos aires") ||
    t.includes("pba") ||
    // ojo: esto también va a agarrar "buenos aires" genérico
    t.includes("buenos aires")
  ) {
    out.add("AR-BA");
  }
  if (t.includes("nación") || t.includes("nacion") || t.includes("argentina")) {
    out.add("AR-NACION");
  }

  return out.size ? Array.from(out) : undefined;
}

// orden correcto de mensajes
function buildCoreMessages(
  contextText: string | undefined,
  userMessage: string,
  fullHistory: Array<{ role: "system" | "user" | "assistant"; content: string }>
): CoreMessage[] {
  const msgs: CoreMessage[] = [];

  // 1) user actual
  msgs.push(toCoreMessage("user", userMessage));

  // 2) contexto RAG como assistant auxiliar
  if (contextText && contextText.trim().length > 0) {
    msgs.push(
      toCoreMessage(
        "assistant",
        `Contexto recuperado (citar como [[n]]). Si no alcanza, dilo.\n${contextText}`
      )
    );
  }

  // 3) resto del historial (menos el user actual que ya agregamos)
  for (const m of fullHistory) {
    if (m.role === "system") continue;
    if (m.role === "user" && m.content === userMessage) continue;
    msgs.push(toCoreMessage(m.role, m.content));
  }

  return msgs;
}

// ---------- endpoint
export async function chat(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
    // leer body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");

    let payload: unknown;
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON payload" }));
      return;
    }

    // saneo previo
    if (
      typeof payload === "object" &&
      payload !== null &&
      Array.isArray((payload as any).messages)
    ) {
      (payload as any).messages = (payload as any).messages
        .filter(
          (m: any) =>
            m &&
            typeof m.role === "string" &&
            typeof m.content === "string" &&
            m.content.trim().length > 0
        )
        .map((m: any) => ({ role: m.role, content: m.content.trim() }));
    }

    const parsed = requestSchema.parse(payload);

    // auth
    let authenticated = false;
    let authenticatedUserId: string | undefined;
    if (parsed.passcode) {
      const invited = await prisma.invitedUser.findFirst({
        where: { passcode: parsed.passcode },
      });
      if (invited) {
        authenticated = true;
        authenticatedUserId = invited.id;
      }
    }

    // último user
    const lastUserMessage = [...parsed.messages]
      .reverse()
      .find((m) => m.role === "user");
    if (!lastUserMessage) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing user message" }));
      return;
    }

    // telemetría + tools
    const telemetry = createTelemetry();
    const toolset = createToolset({
      ensureAuthenticated: () => {
        if (!authenticated) throw new Error("Passcode requerido");
        return { userId: authenticatedUserId };
      },
      setAuthenticated: (userId: string | undefined) => {
        authenticated = Boolean(userId);
        authenticatedUserId = userId;
      },
    });

    const requestId = randomUUID();

    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": env.FRONTEND_ORIGIN ?? "*",
    });

    const send: SSESender = (event, data) => sseSend(res, event, data);
    send("ready", { requestId });

    // detectar jurisdicción desde el texto del user
    const detectedJur = detectJurisdiccionesFromText(lastUserMessage.content);

    // RAG
    const searchResult = await searchDocuments(lastUserMessage.content, 8, {
      authenticated,
      rerankMode: "mmr",
      rerankLimit: 6,
      jurisdiccion: detectedJur,
    });

    telemetry.setSearchMetrics({
      sqlMs: searchResult.metrics.sqlMs,
      embeddingMs: searchResult.metrics.embeddingMs,
      k: searchResult.metrics.k,
      similarityAvg: searchResult.metrics.similarityAvg,
      similarityMin: searchResult.metrics.similarityMin,
      ftsMs: (searchResult.metrics as any).ftsMs ?? undefined,
      hybridAvg: (searchResult.metrics as any).hybridAvg ?? undefined,
      hybridMin: (searchResult.metrics as any).hybridMin ?? undefined,
      reranked: (searchResult.metrics as any).reranked ?? undefined,
      restrictedCount:
        (searchResult.metrics as any).restrictedCount ?? undefined,
    });

    const citations = formatCitations(searchResult);
    const contextPayload =
      searchResult.chunks
        .slice(0, 4)
        .map(
          (chunk, i) =>
            `[[${i + 1}]] ${chunk.title} (${
              chunk.href ?? "sin-link"
            })\n${chunk.content.slice(0, 600)}`
        )
        .join("\n\n") || undefined;

    // mandar contexto al front
    send("context", { citations });

    // mensajes → core
    const systemPrompt = buildSystemPrompt(authenticated);
    const coreMessages = buildCoreMessages(
      contextPayload,
      lastUserMessage.content,
      parsed.messages
    );

    // streaming LLM
    const { stream, modelId, attempts } = await streamWithFallback({
      system: systemPrompt,
      messages: coreMessages,
      tools: toolset,
      maxSteps: env.MAX_TOOL_ITERATIONS,
    });

    telemetry.setLLMInfo({ modelId, attempts });

    // abort on client close
    req.once("close", () => {
      stream.controller.abort();
    });

    // consumir stream
    const toolTimings = new Map<string, number>();
    let responseText = "";

    for await (const ev of stream.fullStream) {
      switch (ev.type) {
        case "response-text-delta": {
          if (responseText.length === 0) telemetry.markFirstToken();
          responseText += ev.textDelta;
          send("token", { text: ev.textDelta });
          break;
        }
        case "tool-call": {
          const start = Date.now();
          toolTimings.set(ev.toolCallId, start);
          telemetry.addToolEvent({
            id: ev.toolCallId,
            name: ev.toolName,
            status: "start",
            detail: JSON.stringify(ev.args),
          });
          send("tool", {
            id: ev.toolCallId,
            name: ev.toolName,
            status: "start",
            detail: ev.args,
          });
          break;
        }
        case "tool-result": {
          const startedAt = toolTimings.get(ev.toolCallId);
          const durationMs = startedAt ? Date.now() - startedAt : undefined;

          if (ev.toolName === "verify_passcode" && ev.result) {
            const valid = Boolean((ev.result as { valid?: boolean }).valid);
            if (!valid) {
              authenticated = false;
              authenticatedUserId = undefined;
            }
          }

          telemetry.addToolEvent({
            id: ev.toolCallId,
            name: ev.toolName,
            status: "success",
            detail: JSON.stringify(ev.result),
            durationMs,
          });
          send("tool", {
            id: ev.toolCallId,
            name: ev.toolName,
            status: "success",
            detail: ev.result,
            durationMs,
          });
          break;
        }
        case "tool-error": {
          const startedAt = toolTimings.get(ev.toolCallId);
          const durationMs = startedAt ? Date.now() - startedAt : undefined;
          telemetry.addToolEvent({
            id: ev.toolCallId,
            name: ev.toolName,
            status: "error",
            detail: ev.error?.message,
            durationMs,
          });
          send("tool", {
            id: ev.toolCallId,
            name: ev.toolName,
            status: "error",
            detail: ev.error?.message,
            durationMs,
          });
          break;
        }
        case "response-text-done": {
          telemetry.markLLMFinished();
          break;
        }
        case "response-error": {
          throw new Error(ev.error?.message ?? "LLM error");
        }
        default:
          break;
      }
    }

    // claimcheck + métricas + audit
    const claims = claimCheck(responseText, searchResult.chunks);
    send("claimcheck", { claims });

    const snapshot = telemetry.snapshot();
    send("metrics", snapshot);
    send("done", {});
    res.end();

    await recordPromptAudit({
      requestId,
      userId: authenticatedUserId,
      passcodeValid: authenticated,
      question: lastUserMessage.content,
      response: responseText,
      citations,
      metrics: snapshot as unknown as Record<string, unknown>,
      jurisdiction: citations.find((c) => c.jurisdiccion)?.jurisdiccion,
    });
  } catch (error) {
    console.error("chat error", error);
    const message =
      error instanceof z.ZodError
        ? error.message
        : (error as Error).message ?? "Unexpected error";

    if (res.headersSent) {
      sseSend(res, "error", { message });
      sseSend(res, "done", {});
      res.end();
    } else {
      const status = error instanceof z.ZodError ? 400 : 500;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
  }
}
