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

type ParsedRequest = z.infer<typeof requestSchema>;

type SSESender = (event: string, data: unknown) => void;

function send(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function formatCitations(result: Awaited<ReturnType<typeof searchDocuments>>) {
  return result.chunks.map((chunk, index) => ({
    id: `${index + 1}`,
    title: chunk.title,
    href: chunk.href,
    similarity: chunk.similarity,
    hybridScore: chunk.hybridScore,
    jurisdiccion: chunk.jurisdiccion ?? undefined,
    tipo: chunk.tipo ?? undefined,
    anio: chunk.anio ?? undefined,
    snippet:
      chunk.content.length > 280
        ? `${chunk.content.slice(0, 280)}…`
        : chunk.content,
  }));
}

function buildSystemPrompt(passcodeVerified: boolean) {
  return `Eres el Copiloto Tributario de Laburen. Respondes en español rioplatense, citando fuentes con el formato [[n]] enlazadas a los fragmentos correspondientes. Prioriza precisión, lenguaje claro y decisiones trazables.

Instrucciones:
- Usa exclusivamente los fragmentos de normativa proporcionados en el contexto.
- Si falta evidencia suficiente, indícalo explícitamente.
- Las herramientas comerciales (leads, notas, follow-ups) solo pueden ejecutarse si el passcode es válido.
- Estado del passcode: ${passcodeVerified ? "VALIDADO" : "NO VALIDADO"}. Si no está validado, informa al usuario y evita ejecutar herramientas hasta verificarlo.
- Menciona las métricas relevantes si agregan valor (ej. tiempo de consulta, cantidad de evidencias).
- No inventes leyes, números ni artículos.`;
}

function enrichMessages(request: ParsedRequest, context: string, passcodeVerified: boolean) {
  const systemPrompt = buildSystemPrompt(passcodeVerified);
  const ragMessage = `Contexto recuperado (citar como [[n]]):\n${context}`;
  const prepared = [
    {
      role: "system" as const,
      content: [{ type: "text" as const, text: systemPrompt }],
    },
    {
      role: "system" as const,
      content: [{ type: "text" as const, text: ragMessage }],
    },
    ...request.messages.map((message) => ({
      role: message.role,
      content: [{ type: "text" as const, text: message.content }],
    })),
  ];
  return prepared;
}

export async function chat(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody || "{}");
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON payload" }));
      return;
    }
    const parsed = requestSchema.parse(payload);

    const lastUserMessage = [...parsed.messages]
      .reverse()
      .find((message) => message.role === "user");
    if (!lastUserMessage) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing user message" }));
      return;
    }

    const telemetry = createTelemetry();
    let authenticatedUserId: string | undefined;
    let authenticated = false;

    const toolset = createToolset({
      ensureAuthenticated: () => {
        if (!authenticated) {
          throw new Error("Passcode requerido");
        }
        return { userId: authenticatedUserId };
      },
      setAuthenticated: (userId) => {
        authenticated = Boolean(userId);
        authenticatedUserId = userId;
      },
    });
    const requestId = randomUUID();

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": env.FRONTEND_ORIGIN ?? "*",
    });

    const sendEvent: SSESender = (event, data) => send(res, event, data);
    sendEvent("ready", { requestId });

    if (parsed.passcode) {
      const invited = await prisma.invitedUser.findFirst({
        where: { passcode: parsed.passcode },
      });
      if (invited) {
        authenticated = true;
        authenticatedUserId = invited.id;
      }
    }

    const searchResult = await searchDocuments(lastUserMessage.content, 8, {
      authenticated,
      rerankMode: "mmr",
      rerankLimit: 6,
    });
    telemetry.setSearchMetrics({
      sqlMs: searchResult.metrics.sqlMs,
      embeddingMs: searchResult.metrics.embeddingMs,
      k: searchResult.metrics.k,
      similarityAvg: searchResult.metrics.similarityAvg,
      similarityMin: searchResult.metrics.similarityMin,
      ftsMs: searchResult.metrics.ftsMs,
      hybridAvg: searchResult.metrics.hybridAvg,
      hybridMin: searchResult.metrics.hybridMin,
      reranked: searchResult.metrics.reranked,
      restrictedCount: searchResult.metrics.restrictedCount,
    });
    const citations = formatCitations(searchResult);
    const contextPayload = searchResult.chunks
      .map(
        (chunk, index) =>
          `[[${index + 1}]] ${chunk.title} (${chunk.href})\n${chunk.content}`
      )
      .join("\n\n");
    sendEvent("context", { citations });

    const preparedMessages = enrichMessages(parsed, contextPayload, authenticated);

    const { stream, modelId, attempts } = await streamWithFallback(
      {
        messages: preparedMessages,
        tools: toolset,
        maxSteps: env.MAX_TOOL_ITERATIONS,
      }
    );
    telemetry.setLLMInfo({ modelId, attempts });

    const toolTimings = new Map<string, number>();
    let responseText = "";

    req.once("close", () => {
      stream.controller.abort();
    });

    for await (const event of stream.fullStream) {
      switch (event.type) {
        case "response-text-delta": {
          if (responseText.length === 0) {
            telemetry.markFirstToken();
          }
          responseText += event.textDelta;
          sendEvent("token", { text: event.textDelta });
          break;
        }
        case "tool-call": {
          const start = Date.now();
          toolTimings.set(event.toolCallId, start);
          telemetry.addToolEvent({
            id: event.toolCallId,
            name: event.toolName,
            status: "start",
            detail: JSON.stringify(event.args),
          });
          sendEvent("tool", {
            id: event.toolCallId,
            name: event.toolName,
            status: "start",
            detail: event.args,
          });
          break;
        }
        case "tool-result": {
          const startedAt = toolTimings.get(event.toolCallId);
          const durationMs = startedAt ? Date.now() - startedAt : undefined;
          if (event.toolName === "verify_passcode" && event.result) {
            const valid = Boolean((event.result as { valid?: boolean }).valid);
            if (!valid) {
              authenticated = false;
              authenticatedUserId = undefined;
            }
          }
          telemetry.addToolEvent({
            id: event.toolCallId,
            name: event.toolName,
            status: "success",
            detail: JSON.stringify(event.result),
            durationMs,
          });
          sendEvent("tool", {
            id: event.toolCallId,
            name: event.toolName,
            status: "success",
            detail: event.result,
            durationMs,
          });
          break;
        }
        case "tool-error": {
          const startedAt = toolTimings.get(event.toolCallId);
          const durationMs = startedAt ? Date.now() - startedAt : undefined;
          telemetry.addToolEvent({
            id: event.toolCallId,
            name: event.toolName,
            status: "error",
            detail: event.error?.message,
            durationMs,
          });
          sendEvent("tool", {
            id: event.toolCallId,
            name: event.toolName,
            status: "error",
            detail: event.error?.message,
            durationMs,
          });
          break;
        }
        case "response-text-done": {
          telemetry.markLLMFinished();
          break;
        }
        case "response-error": {
          throw new Error(event.error?.message ?? "LLM error");
        }
        default:
          break;
      }
    }

    const claims = claimCheck(responseText, searchResult.chunks);
    sendEvent("claimcheck", { claims });
    const snapshot = telemetry.snapshot();
    sendEvent("metrics", snapshot);
    sendEvent("done", {});
    res.end();

    await recordPromptAudit({
      requestId,
      userId: authenticatedUserId,
      passcodeValid: authenticated,
      question: lastUserMessage.content,
      response: responseText,
      citations,
      metrics: snapshot,
      jurisdiction: citations.find((c) => c.jurisdiccion)?.jurisdiccion,
    });
  } catch (error) {
    console.error("chat error", error);
    const message = error instanceof z.ZodError ? error.message : (error as Error).message;
    if (res.headersSent) {
      send(res, "error", { message: message ?? "Unexpected error" });
      send(res, "done", {});
      res.end();
    } else {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message ?? "Unexpected error" }));
    }
  }
}
