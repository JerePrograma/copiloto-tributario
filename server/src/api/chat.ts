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
import {
  getOrCreateAgentSession,
  saveAgentSession,
  type AgentMessage as SessionMessage,
} from "../lib/session-store";
import type { CoreMessage } from "ai";
import { LEX, norm } from "../nlp/lexicon";
import {
  detectIntent,
  detectJurisdiccion,
  buildAnchorGroups,
  type Intent,
  type AnchorGroups,
} from "../nlp/intent";
import { buildSystemPrompt } from "../system/buildSystemPrompt";
import type { BuildSystemPromptOpts } from "../types/prompt";

// ---------- schema
const requestSchema = z.object({
  sessionId: z.string().min(1).max(128).optional(),
  authUserId: z.string().cuid().optional(),
  passcode: z.string().min(3).max(64).optional(),
  name: z.string().min(2).max(120).optional(), // NUEVO: identidad desde payload (usar email)
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string().min(1),
      })
    )
    .min(1),
});

// ---------- SSE utils
type SSESender = (event: string, data: unknown) => void;
function sseSend(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ---------- auth messaging
const UNAUTH_MSG =
  "Usuario no autenticado. Decí: 'Soy <email>, código <passcode>' o enviá { name, passcode } en el payload.";

function redactSecrets(text: string): string {
  if (!text) return text;
  return text.replace(
    /\b(passcode|c(?:ó|o)digo|clave)\s*(?:es|:)?\s*[A-Za-z0-9-]{3,64}\b/gi,
    "$1 ******"
  );
}

function buildTopicGroupsFromQuestion(q: string): AnchorGroups {
  const t = norm(q);
  const topics: AnchorGroups = [];
  if (LEX.automotor.some((w) => t.includes(norm(w))))
    topics.push(LEX.automotor);
  if (LEX.iibb.some((w) => t.includes(norm(w)))) topics.push(LEX.iibb);
  if (LEX.iva.some((w) => t.includes(norm(w)))) topics.push(LEX.iva);
  if (LEX.ganancias.some((w) => t.includes(norm(w))))
    topics.push(LEX.ganancias);
  if (LEX.monotributo.some((w) => t.includes(norm(w))))
    topics.push(LEX.monotributo);
  if (LEX.pyme.some((w) => t.includes(norm(w)))) topics.push(LEX.pyme);
  return topics;
}

function buildAnchorGroupsByIntent(
  q: string,
  jur?: string[]
): { intent: Intent; groups: AnchorGroups; minHits: number } {
  const t = norm(q);
  const intent = detectIntent(q);
  const groups: AnchorGroups = [];
  const topics = buildTopicGroupsFromQuestion(q);

  const addJurisdictionGroups = () => {
    if (jur?.includes("AR-BA")) groups.push(LEX.pba);
    if (jur?.includes("AR-CABA")) groups.push(LEX.caba);
    if (jur?.includes("AR-CBA")) groups.push(LEX.cba);
  };
  const computeFocusedMinHits = () =>
    Math.min(2 + Math.min(1, topics.length), 3);

  let minHits = 1;

  switch (intent) {
    case "adhesion_rs": {
      groups.push(LEX.adhesion, LEX.iibb);
      if (topics.length) groups.push(...topics);
      addJurisdictionGroups();
      if (LEX.pyme.some((w) => t.includes(norm(w)))) groups.push(LEX.pyme);
      minHits = computeFocusedMinHits();
      break;
    }
    case "base_alicuota": {
      groups.push([...LEX.base, ...LEX.alicuota]);
      if (topics.length) groups.push(...topics);
      addJurisdictionGroups();
      minHits = computeFocusedMinHits();
      break;
    }
    case "exenciones": {
      groups.push(LEX.exencion);
      if (topics.length) groups.push(...topics);
      addJurisdictionGroups();
      minHits = computeFocusedMinHits();
      break;
    }
    default: {
      if (topics.length) groups.push(...topics);
      addJurisdictionGroups();
      if (LEX.adhesion.some((w) => t.includes(norm(w))))
        groups.push(LEX.adhesion);
      if (LEX.pyme.some((w) => t.includes(norm(w)))) groups.push(LEX.pyme);
      minHits = 1;
    }
  }

  return { intent, groups, minHits };
}

function hasCooccurrence(text: string, groups: AnchorGroups, minGroupsHit = 2) {
  const t = norm(text);
  let hits = 0;
  for (const g of groups) if (g.some((w) => t.includes(norm(w)))) hits++;
  return hits >= minGroupsHit;
}

function filterByCooccurrence<T extends { content: string }>(
  chunks: T[],
  groups: AnchorGroups,
  minGroupsHit = 2
): T[] {
  if (groups.length === 0) return chunks;
  const effectiveMin =
    groups.length === 1
      ? 1
      : Math.max(1, Math.min(minGroupsHit, groups.length));
  return chunks.filter((c) => hasCooccurrence(c.content, groups, effectiveMin));
}

export const __TESTING = { buildAnchorGroupsByIntent };

function rewriteQueryStrict(groups: AnchorGroups): string {
  if (!groups.length) return "";
  return groups
    .map((g) => "(" + g.map((w) => `"${w}"`).join(" OR ") + ")")
    .join(" ");
}

function rewriteQueryExpanded(groups: AnchorGroups): string {
  if (!groups.length) return "";
  const flat = [...new Set(groups.flat())];
  return flat.map((w) => `"${w}"`).join(" OR ");
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

// cerca de formatCitations / buildCoreMessages
function boostProcedural<T extends { content: string; similarity?: number }>(
  chunks: T[]
) {
  return chunks
    .map((c) => {
      const t = c.content;
      let s = c.similarity ?? 0;
      if (/^##\s*pasos/im.test(t)) s += 0.08;
      if (/^##\s*errores\s*comunes?/im.test(t)) s += 0.06;
      if (/\balta\b|\badhesi[oó]n\b|\brecategorizaci[oó]n\b/i.test(t))
        s += 0.04;
      return { ...c, _score: s };
    })
    .sort((a: any, b: any) => (b._score ?? 0) - (a._score ?? 0));
}

function groupTopByDoc<T extends { title?: string }>(chunks: T[], perDoc = 3) {
  const byTitle = new Map<string, T[]>();
  for (const c of chunks) {
    const k = (c.title ?? "sin-titulo").trim();
    const arr = byTitle.get(k) ?? [];
    if (arr.length < perDoc) arr.push(c);
    byTitle.set(k, arr);
  }
  // elegí el doc con más chunks “procedimentales”
  const ranked = [...byTitle.entries()].sort(
    ([, a], [, b]) => b.length - a.length
  );
  return ranked.length ? ranked[0][1] : chunks.slice(0, 3);
}

function extractSections(md: string) {
  const sec = (name: string) => {
    const re = new RegExp(
      `^##\\s*${name}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|\\Z)`,
      "im"
    );
    return md.match(re)?.[1]?.trim();
  };
  return {
    descripcion: sec("Descripci[oó]n"),
    pasos: sec("Pasos"),
    errores: sec("Errores\\s*comunes?|Errores"),
    refs: sec("Referencias"),
  };
}

function toCoreMessage(
  role: "system" | "user" | "assistant",
  text: string
): CoreMessage {
  return { role, content: text };
}

function buildCoreMessages(
  contextText: string | undefined,
  userMessage: string,
  fullHistory: Array<{ role: "system" | "user" | "assistant"; content: string }>
): CoreMessage[] {
  const historyLimit = 8;
  const trimmedHistory = fullHistory
    .slice(-historyLimit)
    .filter((e) => e.role !== "system");

  const messages: CoreMessage[] = [];
  for (const entry of trimmedHistory) {
    if (entry.role === "user" && entry.content.trim() === userMessage.trim())
      continue;
    messages.push(toCoreMessage(entry.role, entry.content));
  }

  const parts: string[] = [];
  parts.push(`Pregunta: ${userMessage.trim()}`);
  if (contextText?.trim()) {
    parts.push(
      ["", "<CONTEXT>", contextText.trim(), "</CONTEXT>", ""].join("\n")
    );
    parts.push("Elabora la respuesta apoyándote solo en ese contexto.");
  }

  messages.push(toCoreMessage("user", parts.join("\n\n")));
  return messages;
}

// ---------- retrieval multi-fase
async function retrieveWithAnchors(
  userQuery: string,
  k: number,
  baseOpts: Record<string, any>,
  groups: AnchorGroups,
  minHits: number
) {
  // Fase 1: léxica estricta
  const qStrict = rewriteQueryStrict(groups) || userQuery;
  let result = await searchDocuments(qStrict, Math.max(k, 10), {
    ...baseOpts,
    rerankMode: "lexical",
    perDoc: Math.min(5, Math.max(3, Math.floor(k / 2))),
    minSim: 0.3,
    phase: "lexical-strict",
  });
  let filtered = filterByCooccurrence(result.chunks, groups, minHits);
  if (filtered.length > 0) {
    result.chunks = filtered;
    result.metrics.phase = "lexical-strict";
    return result;
  }

  // Fase 2: expandida + MMR
  const qExpanded = `${rewriteQueryExpanded(groups)} ${userQuery}`.trim();
  result = await searchDocuments(
    qExpanded.length ? qExpanded : userQuery,
    Math.max(k, 12),
    {
      ...baseOpts,
      rerankMode: "mmr",
      perDoc: Math.min(5, Math.max(3, Math.floor(k / 2))),
      minSim: 0.28,
      phase: "mmr-expanded",
    }
  );
  filtered = filterByCooccurrence(
    result.chunks,
    groups,
    Math.max(1, minHits - 1)
  );
  if (filtered.length > 0) {
    result.chunks = filtered;
    result.metrics.phase = "mmr-expanded";
    return result;
  }

  // Fase 3: relajada (solo primer grupo)
  const relaxedGroups: AnchorGroups = groups.length ? [groups[0]] : [];
  const qRelaxed = rewriteQueryStrict(relaxedGroups) || userQuery;
  result = await searchDocuments(qRelaxed, Math.max(k, 12), {
    ...baseOpts,
    rerankMode: "lexical",
    perDoc: Math.min(5, Math.max(3, Math.floor(k / 2))),
    minSim: 0.25,
    phase: "relaxed",
  });
  filtered = filterByCooccurrence(result.chunks, relaxedGroups, 1);
  if (filtered.length > 0) {
    result.chunks = filtered;
    result.metrics.phase = "relaxed";
    result.metrics.relaxed = true;
    return result;
  }

  // Fase 4: vectorial sin restricciones
  result = await searchDocuments(userQuery, Math.max(k, 12), {
    ...baseOpts,
    rerankMode: "mmr",
    perDoc: Math.min(5, Math.max(3, Math.floor(k / 2))),
    minSim: 0.2,
    phase: "vector-fallback",
  });
  result.metrics.vectorFallback = true;
  return result;
}

function buildQuerySuggestion(
  question: string,
  citations: { title: string }[]
): string | undefined {
  const normalizedQuestion = question.replace(/\s+/g, " ").trim();
  if (!normalizedQuestion) return undefined;

  const articleMatch = normalizedQuestion.match(/art[íi]culo\s+\d+[a-z]?/i);
  const normaMatch = normalizedQuestion.match(
    /(resoluci[oó]n(?:\s+normativa)?\s+n[ºo]?\s*\d+\/\d{4}|ley\s+n[ºo]?\s*\d+(?:\.\d+)?|decreto\s+n[ºo]?\s*\d+\/\d{4})/i
  );
  const jurisdictionMatch = normalizedQuestion.match(
    /(arba|afip|agip|buenos\s+aires|caba|c[oó]rdoba)/i
  );
  const mainCitationTitle = citations[0]?.title?.replace(/\s+/g, " ").trim();

  const parts = [
    articleMatch?.[0],
    normaMatch?.[0],
    mainCitationTitle ? `"${mainCitationTitle}"` : undefined,
    jurisdictionMatch?.[0]?.toUpperCase(),
  ].filter(Boolean) as string[];

  if (!parts.length) {
    const fallbackTokens = normalizedQuestion
      .split(/[\s,.;:()]+/)
      .filter((token) => token.length > 3 || /\d/.test(token))
      .slice(0, 6);
    if (!fallbackTokens.length) return undefined;
    parts.push(...fallbackTokens);
  }

  return `Intenta ingresar algo como '${parts.join(" ")}'.`;
}

function fallbackByIntent(
  intent: Intent,
  citations: { title: string }[],
  question: string
) {
  const citeList = citations.map((c, i) => `[[${i + 1}]] ${c.title}`);
  const citeLine = citeList.length
    ? `No encontré una respuesta directa, pero estas fuentes podrían ayudar: ${citeList.join(
        ", "
      )}.\n`
    : "No encontré una respuesta directa ni fragmentos citables para esta consulta.\n";
  const suggestion = buildQuerySuggestion(question, citations);
  const suggestionLine = suggestion ? `${suggestion}\n` : "";

  switch (intent) {
    case "base_alicuota":
    case "alicuotas":
      return `${citeLine}${suggestionLine}Revisá “Determinación / Base imponible / Valuación” y “Alícuotas” en la norma aplicable o ampliá el corpus.`;
    case "exenciones":
      return `${citeLine}${suggestionLine}Acotá al capítulo “Exenciones” y, si aplica, resoluciones o decretos complementarios.`;
    case "adhesion_rs":
      return `${citeLine}${suggestionLine}Indicá el trámite de adhesión al RS en la jurisdicción y el canal (web, formulario, clave fiscal).`;
    case "alta_rg":
      return `${citeLine}${suggestionLine}Precisá “Alta en IIBB Régimen General” y organismo (ARBA/AGIP/etc.) para localizar guía y requisitos.`;
    case "recategorizacion_rs":
      return `${citeLine}${suggestionLine}Indicá período y canal de recategorización RS en la jurisdicción.`;
    case "explicar_boleta":
      return `${citeLine}${suggestionLine}Subí una boleta o indicá los campos a interpretar, más jurisdicción.`;
    case "generico":
    default:
      return `${citeLine}${suggestionLine}Refiná términos, indicá tributo y jurisdicción, o ampliá el corpus.`;
  }
}

// ---------- auth helpers
function extractPasscode(text: string): string | null {
  const t = norm(text); // asume que norm quita acentos
  const m =
    /\b(passcode|codigo|c[oó]digo|clave)\s*(?:es|:)?\s*([A-Za-z0-9-]{3,64})\b/i.exec(
      t
    );
  return m ? m[2].trim() : null;
}

function extractIdentity(text: string): string | null {
  // 1) email
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  if (email) return email.trim();
  // 2) nombre libre (no se usa para DB salvo que agregues fullName)
  const t = norm(text);
  const m =
    /\b(soy|me llamo|nombre)\s+([a-záéíóúñ][a-záéíóúñ\s.'-]{1,60})/i.exec(t);
  return m?.[2]?.trim() ?? null;
}

// hacé que "looksLikePureAuth" pida email si no habilitás nombre
function looksLikePureAuth(utterance: string): boolean {
  const t = norm(utterance);
  const hasPass = /\b(passcode|codigo|c[oó]digo|clave)\b/i.test(t);
  const hasQuestion = /[¿?]/.test(utterance);
  const hasTaxWords =
    /\b(ingresos|brutos|adhesi[oó]n|exenci[oó]n|al[ií]cuota|base|arba|agip|afip|caba|buenos\s+aires|c[oó]rdoba)\b/i.test(
      t
    );
  return hasPass && !hasQuestion && !hasTaxWords && t.length <= 200;
}

// ---------- tipos locales de eventos para tipar el stream
type TextStartEvent = { type: "text-start" };
type TextDeltaEvent = { type: "text-delta"; textDelta: string };
type TextEndEvent = { type: "text-end" };
type ToolCallEvent = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: unknown;
};
type ToolResultEvent = {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  result: unknown;
};
type ToolErrorEvent = {
  type: "tool-error";
  toolCallId: string;
  toolName: string;
  error?: { message?: string };
};
type ErrorEvent = { type: "error"; error?: { message?: string } };
type AnyStreamEvent =
  | TextStartEvent
  | TextDeltaEvent
  | TextEndEvent
  | ToolCallEvent
  | ToolResultEvent
  | ToolErrorEvent
  | ErrorEvent;

// ---------- endpoint
export async function chat(req: IncomingMessage, res: ServerResponse) {
  if (req.method === "OPTIONS") {
    const origin = env.FRONTEND_ORIGIN ?? (req.headers.origin as string) ?? "*";
    const reqHeaders =
      (req.headers["access-control-request-headers"] as string) ?? "";

    res.writeHead(204, {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers":
        reqHeaders || "content-type, authorization, x-session-id",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    });
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
    // body
    const chunks: Buffer[] = [];
    for await (const chunk of req)
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");

    let payload: unknown;
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON payload" }));
      return;
    }

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

    const sessionHeader = req.headers["x-session-id"];
    const sessionIdFromHeader = Array.isArray(sessionHeader)
      ? sessionHeader[0]
      : sessionHeader;
    const requestedSessionId =
      typeof sessionIdFromHeader === "string" &&
      sessionIdFromHeader.trim().length
        ? sessionIdFromHeader.trim()
        : parsed.sessionId?.trim();

    const { session } = await getOrCreateAgentSession(requestedSessionId);
    const sessionId = session.id;

    session.history = parsed.messages.map(
      (m) => ({ role: m.role, content: m.content } as SessionMessage)
    );
    await saveAgentSession(session);

    const persistSessionAuth = async (
      userId?: string,
      email?: string | null
    ) => {
      session.authenticatedUser = userId
        ? { id: userId, email: email ?? null }
        : null;
      await saveAgentSession(session);
    };

    const persistSessionAuthSafe = (userId?: string, email?: string | null) => {
      persistSessionAuth(userId, email).catch((err) =>
        console.error("session save error", err)
      );
    };

    // auth baseline
    let authenticated = false;
    let authenticatedUserId: string | undefined;
    let authenticatedUserName: string | undefined;

    // 1) Auth por ID
    if (parsed.authUserId) {
      const invited = await prisma.invitedUser.findUnique({
        where: { id: parsed.authUserId },
        select: { id: true, email: true },
      });
      if (invited) {
        authenticated = true;
        authenticatedUserId = invited.id;
        authenticatedUserName = invited.email ?? undefined; // no redeclarar 'let'
        await persistSessionAuth(invited.id, invited.email);
      } else {
        await persistSessionAuth(undefined);
      }
    } else if (session.authenticatedUser) {
      authenticated = true;
      authenticatedUserId = session.authenticatedUser.id;
      authenticatedUserName = session.authenticatedUser.email ?? undefined;
    }

    // último mensaje de usuario
    const lastUserMessage = [...parsed.messages]
      .reverse()
      .find((m) => m.role === "user");
    if (!lastUserMessage) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing user message" }));
      return;
    }

    const requestId = randomUUID();
    const telemetry = createTelemetry();

    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Session-Id": sessionId,
      "Access-Control-Allow-Origin": env.FRONTEND_ORIGIN ?? "*",
      Vary: "Origin",
    });

    // keepalive
    const keepalive = setInterval(() => {
      try {
        sseSend(res, "ping", { t: Date.now() });
      } catch {
        // ignore
      }
    }, 15000);

    const send: SSESender = (event, data) => sseSend(res, event, data);
    send("ready", { requestId });
    send("session", { id: sessionId });

    // -------- Identidad + passcode desde payload o frase
    const identityFromPayload = parsed.name?.trim();
    const identityFromText = extractIdentity(lastUserMessage.content); // puede devolver nombre o email
    const idCandidate = identityFromPayload ?? identityFromText ?? null;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const allowNameAuth = Boolean(env.ALLOW_NAME_AUTH);
    const isEmail = !!idCandidate && emailRegex.test(idCandidate);
    const identity = isEmail ? idCandidate : allowNameAuth ? idCandidate : null;
    const passFromPayload = parsed.passcode?.trim();
    const passFromText = extractPasscode(lastUserMessage.content);

    const passcode = passFromPayload ?? passFromText ?? null;

    if (!authenticated && identity && passcode) {
      let invited: { id: string; email: string | null } | null = null;

      if (isEmail) {
        invited = await prisma.invitedUser.findFirst({
          where: { passcode, email: { equals: identity, mode: "insensitive" } },
          select: { id: true, email: true },
        });
      } else if (allowNameAuth) {
        try {
          invited = await prisma.invitedUser.findFirst({
            where: {
              passcode,
              name: { equals: identity, mode: "insensitive" },
            },
            select: { id: true, email: true },
          });
        } catch (e: any) {
          if (/InvitedUser\.name/.test(String(e?.message))) invited = null;
          else throw e;
        }
      }

      if (invited) {
        authenticated = true;
        authenticatedUserId = invited.id;
        const authEmail = invited.email ?? identity ?? undefined;
        authenticatedUserName = authEmail ?? undefined;
        await persistSessionAuth(invited.id, authEmail ?? null);
        const authEventId = randomUUID();
        send("tool", {
          id: authEventId,
          name: "verify_passcode",
          status: "success",
          detail: {
            valid: true,
            userId: invited.id,
            email: authEmail ?? undefined,
          },
        });

        if (looksLikePureAuth(lastUserMessage.content)) {
          send("amendment", { reason: "fast_auth", method: "name+passcode" });
          send("token", {
            text: "Usuario verificado. Decime tu consulta tributaria.",
          });
          const snapshotAuth = telemetry.snapshot();
          send("metrics", snapshotAuth);
          send("done", {});
          clearInterval(keepalive);
          res.end();
          void recordPromptAudit({
            requestId,
            userId: invited.id,
            passcodeValid: true,
            question: redactSecrets(lastUserMessage.content),
            response: "Verificado por name+passcode.",
            citations: [],
            metrics: snapshotAuth as unknown as Record<string, unknown>,
            jurisdiction: undefined,
          }).catch((e) => console.error("audit error", e));
          return;
        }
      } else if (looksLikePureAuth(lastUserMessage.content)) {
        await persistSessionAuth(undefined);
        const authEventId = randomUUID();
        send("tool", {
          id: authEventId,
          name: "verify_passcode",
          status: "error",
          detail: { valid: false },
        });
        send("amendment", { reason: "auth_failed_name_passcode" });
        const msg =
          "Credenciales no válidas. Formato: 'Soy <email>, código <passcode>'.";
        send("token", { text: msg });
        const snapshot = telemetry.snapshot();
        send("metrics", snapshot);
        send("done", {});
        clearInterval(keepalive);
        res.end();
        void recordPromptAudit({
          requestId,
          userId: undefined,
          passcodeValid: false,
          question: redactSecrets(lastUserMessage.content),
          response: msg,
          citations: [],
          metrics: snapshot as unknown as Record<string, unknown>,
          jurisdiction: undefined,
        }).catch((e) => console.error("audit error", e));
        return;
      }
    }

    // Si llegó SOLO passcode o SOLO name y el mensaje es puro login, avisar falta del otro
    if (!authenticated && looksLikePureAuth(lastUserMessage.content)) {
      if ((passFromPayload || passFromText) && !identity) {
        send("amendment", { reason: "identity_missing" });
        send("token", {
          text: "Falta identidad. Indicá tu email junto al passcode.",
        });
      } else if (identityFromPayload || identityFromText) {
        send("amendment", { reason: "passcode_missing" });
        send("token", { text: "Falta passcode. Decí 'código <passcode>'." });
      } else {
        send("amendment", { reason: "credentials_missing" });
        send("token", {
          text: "Formato: 'Soy <email>, código <passcode>' o enviá { name, passcode } en el payload.",
        });
      }
      const snapshot = telemetry.snapshot();
      send("metrics", snapshot);
      send("done", {});
      clearInterval(keepalive);
      res.end();
      void recordPromptAudit({
        requestId,
        userId: undefined,
        passcodeValid: false,
        question: redactSecrets(lastUserMessage.content),
        response: "Faltan credenciales completas.",
        citations: [],
        metrics: snapshot as unknown as Record<string, unknown>,
        jurisdiction: undefined,
      }).catch((e) => console.error("audit error", e));
      return;
    }

    // --- GATE DURO: si NO está autenticado, cortar acá siempre
    if (!authenticated) {
      send("amendment", { reason: "auth_required" });
      send("token", { text: UNAUTH_MSG });
      send("claimcheck", { claims: [] });
      const snapshot = telemetry.snapshot();
      send("metrics", snapshot);
      send("done", {});
      clearInterval(keepalive);
      res.end();
      return;
    }

    const LOW_INFO = /^(hola|buenas|hey|hello|qué tal|que tal|test|ping)\b/i;
    const userText = lastUserMessage.content.trim();
    if (LOW_INFO.test(userText)) {
      if (!authenticated) {
        send("amendment", { reason: "auth_required_greeting" });
        send("token", { text: UNAUTH_MSG });
      } else {
        send("amendment", { reason: "greeting_low_signal" });
        send("token", {
          text: "Listo. Indicá tributo y jurisdicción. Ej: “ARBA IIBB RS adhesión”. Decí “mostrar citas” para ver fuentes.",
        });
      }
      const snapshot = telemetry.snapshot();
      send("metrics", snapshot);
      send("done", {});
      clearInterval(keepalive);
      res.end();
      return;
    }

    const toolset = createToolset({
      ensureAuthenticated: () => {
        if (!authenticated) throw new Error("Usuario no autenticado");
        return { userId: authenticatedUserId };
      },
      setAuthenticated: (userId: string | undefined, email?: string | null) => {
        authenticated = Boolean(userId);
        authenticatedUserId = userId;
        authenticatedUserName = userId
          ? email ?? authenticatedUserName
          : undefined;
        persistSessionAuthSafe(userId, email ?? null);
      },
    });

    const detectedJur = detectJurisdiccion(lastUserMessage.content);
    const pathLike = detectedJur?.includes("AR-BA")
      ? "provincial/ar-ba-%"
      : detectedJur?.includes("AR-CABA")
      ? "provincial/ar-caba-%"
      : detectedJur?.includes("AR-CBA")
      ? "provincial/ar-cba-%"
      : detectedJur?.includes("AR-NACION")
      ? "nacional/%"
      : undefined;

    const { groups: anchorGroups, minHits } = buildAnchorGroupsByIntent(
      lastUserMessage.content,
      detectedJur
    );

    // RAG multi-fase
    const baseOpts = {
      authenticated,
      pathLike,
      phaseWeights: {
        "mmr-expanded": { vectorWeight: 0.65, textWeight: 0.35 },
      },
    };
    const searchResult = await retrieveWithAnchors(
      lastUserMessage.content,
      12,
      baseOpts,
      anchorGroups,
      minHits
    );

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
      vectorWeight: searchResult.metrics.vectorWeight,
      textWeight: searchResult.metrics.textWeight,
      weightSource: searchResult.metrics.weightSource,
      phase: searchResult.metrics.phase,
      relaxed: searchResult.metrics.relaxed,
      vectorFallback: searchResult.metrics.vectorFallback,
    });

    const citations = formatCitations(searchResult);
    const boosted = boostProcedural(searchResult.chunks);
    const bestDocChunks = groupTopByDoc(boosted, 3);
    const joined = bestDocChunks.map((c) => c.content).join("\n\n");
    const sec = extractSections(joined);
    const contextPayload =
      [
        sec.descripcion ? `## Descripción\n${sec.descripcion}` : "",
        sec.pasos ? `## Pasos\n${sec.pasos}` : "",
        sec.errores ? `## Errores comunes\n${sec.errores}` : "",
        sec.refs ? `## Referencias\n${sec.refs}` : "",
      ]
        .filter(Boolean)
        .join("\n\n") || undefined;

    // contexto al front
    send("context", { citations });

    // ---------- FAST-PATH: "mostrar fuentes/citas"
    const showOnlySources =
      /\b(mostrar|ver)\b.*\b(citas|fuentes|evidencias?)\b/i.test(
        lastUserMessage.content
      );
    if (showOnlySources) {
      const list = citations
        .map((c) => `• [[${c.id}]] ${c.title} — ${c.href || "sin-link"}`)
        .join("\n");
      send("amendment", { reason: "sources_only" });
      send("token", { text: `Fuentes recuperadas:\n${list || "(ninguna)"}\n` });
      const snapshot = telemetry.snapshot();
      send("metrics", snapshot);
      send("done", {});
      clearInterval(keepalive);
      res.end();
      void recordPromptAudit({
        requestId,
        userId: authenticatedUserId,
        passcodeValid: authenticated,
        question: lastUserMessage.content,
        response: `Fuentes listadas (${citations.length}).`,
        citations,
        metrics: snapshot as unknown as Record<string, unknown>,
        jurisdiction: citations.find((c) => c.jurisdiccion)?.jurisdiccion,
      }).catch((e) => console.error("audit error", e));
      return;
    }

    // === utils locales ===
    const normNoAccents = (s: string) =>
      s
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

    function hasMdSection(text: string, heads: string[]): boolean {
      if (!text) return false;
      const t = normNoAccents(text);
      return heads.some((h) => {
        const hh = normNoAccents(h);
        // ^##\s*pasos  |  ^###\s*errores  |  ^##\s*checklist
        const re = new RegExp(`^#{1,4}\\s*${hh}\\b`, "im");
        return re.test(t);
      });
    }

    function deriveProceduralMode(
      contextPayload?: string,
      chunks?: Array<{ content: string }>
    ): boolean {
      const HEADS = [
        "pasos",
        "errores",
        "errores comunes",
        "checklist",
        "procedimiento",
      ];
      if (hasMdSection(contextPayload ?? "", HEADS)) return true;
      if (Array.isArray(chunks)) {
        for (const c of chunks) if (hasMdSection(c.content, HEADS)) return true;
      }
      return false;
    }

    type Jur = "AR-BA" | "AR-CABA" | "AR-CBA" | "AR-NAC";
    function deriveJurisdictionHint(
      detectedJur?: string[] | undefined,
      citations?: Array<{ jurisdiccion?: string }>
    ): Jur | undefined {
      const priority: Jur[] = ["AR-BA", "AR-CABA", "AR-CBA", "AR-NAC"];
      const fromDetected = priority.find((j) => detectedJur?.includes(j));
      if (fromDetected) return fromDetected;
      const fromCites = priority.find((j) =>
        citations?.some((c) => c.jurisdiccion === j)
      );
      return fromCites;
    }

    function pickPrimaryTitle(
      citations?: Array<{ title?: string }>
    ): string | undefined {
      return citations?.[0]?.title?.trim() || undefined;
    }

    // Opcional: si hay “Errores/Checklist”, pedimos “Validaciones previas” en el formato procedimental
    function wantsValidationLead(
      contextPayload?: string,
      chunks?: Array<{ content: string }>
    ): boolean {
      const HEADS = ["errores", "errores comunes", "checklist"];
      return (
        deriveProceduralMode(contextPayload, chunks) &&
        (hasMdSection(contextPayload ?? "", HEADS) ||
          (chunks ?? []).some((c) => hasMdSection(c.content, HEADS)))
      );
    }

    // === en tu handler, luego de obtener searchResult, citations, authenticated, detectedJur, lastUserMessage ===
    const intent = detectIntent(lastUserMessage.content);

    const proceduralMode = deriveProceduralMode(
      contextPayload, // el string <CONTEXT> que ya armaste
      searchResult?.chunks // acceso directo a los fragmentos
    );

    const jurisdictionHint = deriveJurisdictionHint(detectedJur, citations);

    const systemOpts: BuildSystemPromptOpts = {
      passcodeVerified: Boolean(authenticated),
      proceduralMode,
      jurisdictionHint,
      primaryDocTitle: pickPrimaryTitle(citations),
      intent: intent as BuildSystemPromptOpts["intent"],
      relaxed: Boolean(searchResult?.metrics?.relaxed),
      vectorFallback: Boolean(searchResult?.metrics?.vectorFallback),
    };

    // Hook: si queremos “validaciones como primer paso”, añadimos un *flag* ad-hoc en el prompt
    // (ver ajuste menor en buildSystemPrompt abajo)
    const forceValidationLead = wantsValidationLead(
      contextPayload,
      searchResult?.chunks
    );
    if (forceValidationLead) {
      (systemOpts as any).validationLead = true;
    }

    const systemPrompt = buildSystemPrompt(systemOpts);

    const coreMessages = buildCoreMessages(
      contextPayload,
      lastUserMessage.content,
      parsed.messages
    );

    // streaming LLM con aborto
    const ac = new AbortController();
    let modelId = "";
    let attempts = 0;

    // helpers, cerca del top
    function getHttpStatus(e: any): number | undefined {
      if (!e) return;
      if (typeof e.statusCode === "number") return e.statusCode;
      if (typeof e.code === "number") return e.code;
      if (typeof e?.data?.error?.code === "number") return e.data.error.code;
      if (typeof e?.lastError?.statusCode === "number")
        return e.lastError.statusCode;
      const tryList = Array.isArray(e?.errors) ? e.errors : [];
      for (const sub of tryList) {
        if (typeof sub?.statusCode === "number") return sub.statusCode;
        if (typeof sub?.code === "number") return sub.code;
        if (typeof sub?.data?.error?.code === "number")
          return sub.data.error.code;
        const body = String(sub?.responseBody ?? "");
        if (/\"code\"\s*:\s*429/.test(body)) return 429;
        if (/rate-?limited/i.test(body)) return 429;
      }
      const body = String(e?.responseBody ?? e?.message ?? "");
      if (/rate-?limited/i.test(body)) return 429;
    }

    function isRateLimited(e: any): boolean {
      const code = getHttpStatus(e);
      return code === 429;
    }

    let stream = await (async () => {
      try {
        const fb = await streamWithFallback({
          system: systemPrompt,
          messages: coreMessages,
          tools: toolset,
          temperature: 0.7,
          topP: 0.9,
          abortSignal: ac.signal,
        });
        modelId = fb.modelId;
        attempts = fb.attempts;
        telemetry.setLLMInfo({ modelId, attempts });
        return fb.stream;
      } catch (e: any) {
        const msg = String(e?.data?.error?.message ?? e?.message ?? "");
        const code = getHttpStatus(e);
        const is402 = code === 402 || /Insufficient credits/i.test(msg);
        const is429 = isRateLimited(e);
        const is401 = code === 401;
        const is403 = code === 403;
        const is5xx = typeof code === "number" && code >= 500;

        const degrade = (reason: string, text: string) => {
          send("amendment", { reason });
          send("token", { text });
          send("claimcheck", { claims: [] });
          const snap = telemetry.snapshot();
          send("metrics", snap);
          send("done", {});
          clearInterval(keepalive);
          res.end();
          void recordPromptAudit({
            requestId,
            userId: authenticatedUserId,
            passcodeValid: authenticated,
            question: lastUserMessage.content,
            response: text,
            citations,
            metrics: snap as unknown as Record<string, unknown>,
            jurisdiction: citations.find((c) => c.jurisdiccion)?.jurisdiccion,
          }).catch((err) => console.error("audit error", err));
        };

        if (is402) {
          const fbText = fallbackByIntent(
            intent,
            citations,
            lastUserMessage.content
          );
          degrade("provider_credit_exhausted", fbText);
          throw new Error("__handled_402__");
        } else if (is429) {
          const body =
            "El modelo está limitado por tasa. Te dejo un resumen breve.\n\n" +
            fallbackByIntent(intent, citations, lastUserMessage.content);
          degrade("provider_rate_limited", body);
          throw new Error("__handled_429__");
        } else if (is401 || is403) {
          const fbText =
            "No se pudo llamar al proveedor del modelo por credenciales del servicio. Verificá tus claves.";
          degrade("provider_auth_error", fbText);
          throw new Error("__handled_provider_auth__");
        } else if (is5xx) {
          const fbText =
            "Proveedor de modelo no disponible. Reintentá más tarde.";
          const body =
            fbText +
            "\n\n" +
            fallbackByIntent(intent, citations, lastUserMessage.content);
          degrade("provider_unavailable", body);
          throw new Error("__handled_5xx__");
        } else {
          throw e;
        }
      }
    })();

    // abort on client close
    req.once("close", () => {
      try {
        ac.abort();
      } catch {
        // ignore
      }
      clearInterval(keepalive);
    });

    // consumir stream tipado
    const toolTimings = new Map<string, number>();
    let responseText = "";
    let emittedAnyToken = false;

    for await (const ev of stream.fullStream as AsyncIterable<AnyStreamEvent>) {
      switch (ev.type) {
        case "text-start": {
          telemetry.markFirstToken();
          break;
        }
        case "text-delta": {
          const delta = ev.textDelta;
          if (!delta) break;
          if (responseText.length === 0) telemetry.markFirstToken();
          responseText += delta;
          emittedAnyToken = true;
          send("token", { text: delta });
          break;
        }
        case "tool-call": {
          const { toolCallId, toolName, input } = ev;
          toolTimings.set(toolCallId, Date.now());
          telemetry.addToolEvent({
            id: toolCallId,
            name: toolName,
            status: "start",
            detail: JSON.stringify(input),
          });
          send("tool", {
            id: toolCallId,
            name: toolName,
            status: "start",
            detail: input,
          });
          break;
        }
        case "tool-result": {
          const { toolCallId, toolName, result } = ev;
          const startedAt = toolTimings.get(toolCallId);
          const durationMs = startedAt ? Date.now() - startedAt : undefined;

          if (toolName === "verify_passcode" && result) {
            const valid = Boolean((result as { valid?: boolean }).valid);
            if (!valid) {
              authenticated = false;
              authenticatedUserId = undefined;
              if (looksLikePureAuth(lastUserMessage.content)) {
                send("amendment", { reason: "auth_failed" });
                const msg =
                  "Credenciales no válidas. Probá nuevamente o pedí acceso.";
                send("token", { text: msg });
                telemetry.markLLMFinished();
                const snapshot = telemetry.snapshot();
                send("metrics", snapshot);
                send("done", {});
                clearInterval(keepalive);
                try {
                  ac.abort();
                } catch {}
                res.end();
                void recordPromptAudit({
                  requestId,
                  userId: undefined,
                  passcodeValid: false,
                  question: lastUserMessage.content,
                  response: msg,
                  citations,
                  metrics: snapshot as unknown as Record<string, unknown>,
                  jurisdiction: citations.find((c) => c.jurisdiccion)
                    ?.jurisdiccion,
                }).catch((e) => console.error("audit error", e));
                throw new Error("__handled_auth_failed__");
              }
            }
          }
          telemetry.addToolEvent({
            id: toolCallId,
            name: toolName,
            status: "success",
            detail: JSON.stringify(result),
            durationMs,
          });
          send("tool", {
            id: toolCallId,
            name: toolName,
            status: "success",
            detail: result,
            durationMs,
          });
          break;
        }
        case "tool-error": {
          const { toolCallId, toolName, error } = ev;
          const startedAt = toolTimings.get(toolCallId);
          const durationMs = startedAt ? Date.now() - startedAt : undefined;
          telemetry.addToolEvent({
            id: toolCallId,
            name: toolName,
            status: "error",
            detail: error?.message,
            durationMs,
          });
          send("tool", {
            id: toolCallId,
            name: toolName,
            status: "error",
            detail: error?.message,
            durationMs,
          });
          break;
        }
        case "text-end": {
          telemetry.markLLMFinished();
          break;
        }
        case "error": {
          throw new Error(ev.error?.message ?? "LLM error");
        }
        default:
          break;
      }
    }

    // Claim-check y fallback honesto por intent
    const claimsRaw = claimCheck(responseText, searchResult.chunks);
    const claimItems: unknown[] = Array.isArray(claimsRaw)
      ? claimsRaw
      : (claimsRaw as any)?.items ?? [];
    const isSupported = (c: any) =>
      c?.supported === true ||
      c?.ok === true ||
      c?.status === "supported" ||
      c?.verdict === "supported" ||
      c?.result === "supported";
    const hasEvidenced =
      claimItems.some(isSupported) ||
      Number(
        (claimsRaw as any)?.supportedCount ??
          (claimsRaw as any)?.stats?.supported ??
          0
      ) > 0;

    send("claimcheck", {
      claims: Array.isArray(claimsRaw) ? claimsRaw : claimItems,
    });

    const lowSignalGeneric =
      intent === "generico" &&
      !/[¿?]/.test(lastUserMessage.content) &&
      lastUserMessage.content.trim().split(/\s+/).length < 6;
    const hasProceduralSections = Boolean(sec.pasos || sec.errores);

    if (!hasEvidenced) {
      if (hasProceduralSections && !lowSignalGeneric) {
        send("amendment", { reason: "procedural_fallback" });
        const cite = citations?.[0] ? `[[1]] ${citations[0].title}` : "";
        responseText = [
          "Resumen operativo desde el contexto:",
          sec.pasos ? `\n**Pasos**\n${sec.pasos}` : "",
          sec.errores ? `\n**Errores comunes**\n${sec.errores}` : "",
          cite ? `\n**Fuentes**: ${cite}` : "",
        ].join("\n");
      } else {
        responseText = fallbackByIntent(
          intent,
          citations,
          lastUserMessage.content
        );
        send("amendment", { reason: "low_signal_or_no_evidence", intent });
      }
    }

    if (!emittedAnyToken && responseText.trim().length > 0) {
      send("token", { text: `\n${responseText}` });
    }

    const snapshot = telemetry.snapshot();
    send("metrics", snapshot);
    send("done", {});
    clearInterval(keepalive);
    res.end();

    // audit fire-and-forget
    void recordPromptAudit({
      requestId,
      userId: authenticatedUserId,
      passcodeValid: authenticated,
      question: lastUserMessage.content,
      response: responseText,
      citations,
      metrics: snapshot as unknown as Record<string, unknown>,
      jurisdiction: citations.find((c) => c.jurisdiccion)?.jurisdiccion,
    }).catch((e) => console.error("audit error", e));
  } catch (error: any) {
    if (
      String(error?.message) === "__handled_402__" ||
      String(error?.message) === "__handled_429__" ||
      String(error?.message) === "__handled_provider_auth__" ||
      String(error?.message) === "__handled_5xx__" ||
      String(error?.message) === "__handled_auth_failed__"
    )
      return;
    console.error("chat error", error);
    const message =
      error instanceof z.ZodError
        ? error.message
        : (error as Error).message ?? "Unexpected error";
    if (res.headersSent) {
      try {
        sseSend(res, "error", { message });
        sseSend(res, "done", {});
      } finally {
        res.end();
      }
    } else {
      const status = error instanceof z.ZodError ? 400 : 500;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
  }
}
