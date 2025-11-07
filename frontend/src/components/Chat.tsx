"use client";

import { FormEvent, useCallback, useMemo, useRef, useState } from "react";
import { startSSE, type SSEMessage, type SSEController } from "@/lib/sse";
import type {
  AuthState,
  ClaimCheckEntry,
  Citation,
  MetricsSnapshot,
  TimelineEvent,
} from "./types";

interface ChatProps {
  onMetrics: (metrics: MetricsSnapshot) => void;
  onTimeline: (updater: (prev: TimelineEvent[]) => TimelineEvent[]) => void;
  onCitations: (citations: Citation[]) => void;
  onClaims: (claims: ClaimCheckEntry[]) => void;
  authState: AuthState;
  onAuthStateChange: (state: AuthState) => void;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  error?: string;
}

interface ReadyEvent {
  requestId: string;
}

interface ToolEventPayload {
  id: string;
  name: string;
  status: "start" | "success" | "error";
  detail?: string;
  durationMs?: number;
}

type MetricsEventPayload = MetricsSnapshot;

interface ContextEventPayload {
  citations: Citation[];
}

interface ClaimEventPayload {
  claims: ClaimCheckEntry[];
}

const API_BASE = (
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001"
).replace(/\/$/, "");

const SESSION_STORAGE_KEY = "copiloto.sessionId";

// ===== Helpers a nivel módulo =====
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const NAME_RE =
  /\b(?:soy|me\s+llamo|nombre)\s+([a-záéíóúñ][a-záéíóúñ.' -]{1,60})\b/i;
const PASS_RE =
  /\b(código|codigo|passcode|clave)\s*[:=]?\s*([A-Za-z0-9-]{3,64})\b/i;
const PASSMASK_RE = /\b(código|codigo|passcode|clave)\s*[:=]?\s*\*{3,}\b/i; // detecta ****** literal
const REDACT_PASS_RE =
  /\b(código|codigo|passcode|clave)\s*[:=]?\s*[A-Za-z0-9-]{3,64}\b/gi;

export function parseAuthFields(text: string): {
  name?: string;
  passcode?: string;
} {
  const email = text.match(EMAIL_RE)?.[0]?.trim();
  const pass = text.match(PASS_RE)?.[2]?.trim();
  if (email && pass) return { name: email, passcode: pass };
  // fallback a nombre si no hay email y ALLOW_NAME_AUTH=true en backend
  const name = text.match(NAME_RE)?.[1]?.trim();
  if (name && pass) return { name, passcode: pass };
  return {};
}

export function redactSecrets(s: string): string {
  return s.replace(REDACT_PASS_RE, "$1 ******");
}

export function containsMaskedPass(text: string): boolean {
  return PASSMASK_RE.test(text);
}

export default function Chat({
  onMetrics,
  onTimeline,
  onCitations,
  onClaims,
  authState,
  onAuthStateChange,
}: ChatProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setStreaming] = useState(false);
  const controllerRef = useRef<SSEController | null>(null);
  const activeMessageId = useRef<string | null>(null);

  const chatEndpoint = useMemo(() => `${API_BASE}/api/chat`, []);

  const appendMessage = useCallback((message: ChatMessage) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  const updateMessage = useCallback(
    (id: string, updater: (msg: ChatMessage) => ChatMessage) => {
      setMessages((prev) =>
        prev.map((msg) => (msg.id === id ? updater(msg) : msg))
      );
    },
    []
  );

  const pushTimeline = useCallback(
    (event: TimelineEvent) => {
      onTimeline((prev) => {
        const index = prev.findIndex((item) => item.id === event.id);
        if (index >= 0) {
          const next = [...prev];
          next[index] = { ...next[index], ...event };
          return next;
        }
        return [...prev, event];
      });
    },
    [onTimeline]
  );

  const handleSSEEvent = useCallback(
    (event: SSEMessage) => {
      if (event.event === "ready") {
        const data = event.data as ReadyEvent;
        const assistantMessage: ChatMessage = {
          id: data.requestId,
          role: "assistant",
          content: "",
          streaming: true,
        };
        activeMessageId.current = assistantMessage.id;
        appendMessage(assistantMessage);
        setStreaming(true);
        return;
      }
      if (!activeMessageId.current) return;
      const currentId = activeMessageId.current;

      switch (event.event) {
        case "token": {
          const { text } = event.data as { text: string };
          updateMessage(currentId, (msg) => ({
            ...msg,
            content: msg.content + text,
          }));
          break;
        }
        case "context": {
          // Panel lateral: citas. No tocar el bubble.
          const { citations } = event.data as ContextEventPayload;
          onCitations(citations);
          break;
        }
        case "session": {
          const { id } = event.data as { id?: string };
          if (typeof id === "string" && id.trim().length > 0) {
            const normalized = id.trim();
            if (typeof window !== "undefined") {
              window.localStorage.setItem(SESSION_STORAGE_KEY, normalized);
            }
            setSessionId(normalized);
          }
          break;
        }
        case "claimcheck": {
          // Panel/overlay: claim-check. No tocar el bubble.
          const { claims } = event.data as ClaimEventPayload;
          onClaims(claims);
          break;
        }
        case "metrics": {
          onMetrics(event.data as MetricsEventPayload);
          break;
        }
        case "tool": {
          const payload = event.data as ToolEventPayload;
          const rawDetail = payload.detail as unknown;
          const detailString =
            rawDetail && typeof rawDetail !== "string"
              ? JSON.stringify(rawDetail, null, 2)
              : (rawDetail as string | undefined);
          if (payload.name === "verify_passcode") {
            if (payload.status === "success" && rawDetail) {
              const detail = rawDetail as {
                valid?: boolean;
                userId?: string;
                email?: string;
              };
              if (detail.valid && detail.userId) {
                onAuthStateChange({
                  status: "valid",
                  userId: detail.userId,
                  email: detail.email,
                });
              } else {
                onAuthStateChange({ status: "invalid" });
              }
            }
            if (payload.status === "error") {
              onAuthStateChange({ status: "invalid" });
            }
          }
          const statusMap: Record<
            ToolEventPayload["status"],
            TimelineEvent["status"]
          > = {
            start: "pending",
            success: "ok",
            error: "error",
          };
          pushTimeline({
            id: payload.id,
            label: payload.name,
            status: statusMap[payload.status],
            detail: detailString,
            durationMs: payload.durationMs,
          });
          break;
        }
        case "amendment": {
          const { reason } = event.data as { reason?: string };
          if (
            reason === "auth_required" ||
            reason === "auth_required_greeting"
          ) {
            onAuthStateChange({ status: "unknown" });
            onCitations([]);
            onClaims([]);
          }
          break;
        }
        case "error": {
          const { message } = event.data as { message: string };
          updateMessage(currentId, (msg) => ({
            ...msg,
            error: message,
            streaming: false,
          }));
          activeMessageId.current = null;
          setStreaming(false);
          break;
        }
        case "done": {
          updateMessage(currentId, (msg) => ({
            ...msg,
            streaming: false,
          }));
          setStreaming(false);
          activeMessageId.current = null;
          break;
        }
        default:
          break;
      }
    },
    [
      appendMessage,
      onClaims,
      onCitations,
      onMetrics,
      onAuthStateChange,
      setSessionId,
      pushTimeline,
      updateMessage,
    ]
  );

  const resetTimeline = useCallback(() => {
    onTimeline(() => []);
  }, [onTimeline]);

  const resetSession = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    activeMessageId.current = null;
    setStreaming(false);
    setMessages([]);
    onCitations([]);
    onClaims([]);
    onAuthStateChange({ status: "unknown" });

    // regenerar sessionId
    const newId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SESSION_STORAGE_KEY, newId);
    }
    setSessionId(newId);
  }, [onAuthStateChange, onCitations, onClaims]);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!input.trim() || isStreaming) return;

      // comando rápido de logout
      if (/^\s*(logout|cerrar\s+sesión)\s*$/i.test(input)) {
        resetSession();
        setInput("");
        return;
      }

      // 1) sessionId normalizado ANTES de usarlo
      let activeSessionId: string = (sessionId ?? "").trim();
      if (!activeSessionId) {
        const generated =
          typeof crypto !== "undefined" &&
          typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : Math.random().toString(36).slice(2);
        if (typeof window !== "undefined") {
          window.localStorage.setItem(SESSION_STORAGE_KEY, generated);
        }
        setSessionId(generated);
        activeSessionId = generated;
      }

      // 2) redact/parse sobre el texto crudo
      const raw = input.trim();

      // bloquear intentos con ****** literal
      if (containsMaskedPass(raw)) {
        // mensaje de sistema rápido y cortar
        appendMessage({
          id: crypto.randomUUID(),
          role: "assistant",
          content:
            "No pegues ******. Escribí el passcode real junto a tu email o nombre.",
        });
        setInput("");
        return;
      }

      const { name: authName, passcode: authPass } = parseAuthFields(raw);
      const safe = redactSecrets(raw);

      // 3) bubble del usuario sin secretos
      const userMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: safe,
      };

      // 4) payload con sessionId ya listo y auth explícita si aplica
      const payload = {
        sessionId: activeSessionId,
        authUserId: authState.status === "valid" ? authState.userId : undefined,
        ...(authName && authPass ? { name: authName, passcode: authPass } : {}),
        messages: [...messages, userMessage].map((m) => ({
          role: m.role,
          content: m.content,
        })),
      };

      // 5) UI updates
      appendMessage(userMessage);
      setInput("");
      resetTimeline();
      onCitations([]);
      onClaims([]);

      // 6) SSE
      controllerRef.current?.abort();
      const controller = startSSE(
        chatEndpoint,
        {
          method: "POST",
          body: JSON.stringify(payload),
          headers: {
            "Content-Type": "application/json",
            "X-Session-Id": activeSessionId,
          },
        },
        {
          onEvent: handleSSEEvent,
          onError: (error) => {
            const errorMessage: ChatMessage = {
              id: crypto.randomUUID(),
              role: "assistant",
              content: "",
              error: error.message,
            };
            appendMessage(errorMessage);
            activeMessageId.current = null;
            setStreaming(false);
          },
          onClose: () => {
            setStreaming(false);
          },
        }
      );
      controllerRef.current = controller;
    },
    [
      input,
      isStreaming,
      sessionId,
      authState,
      messages,
      chatEndpoint,
      handleSSEEvent,
      appendMessage,
      resetTimeline,
      onCitations,
      onClaims,
      resetSession,
    ]
  );

  const stopStreaming = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    if (activeMessageId.current) {
      const id = activeMessageId.current;
      updateMessage(id, (msg) => ({ ...msg, streaming: false }));
      activeMessageId.current = null;
    }
    setStreaming(false);
  }, [updateMessage]);

  return (
    <section className="chat">
      <header className="chat-header">
        <h1>Copiloto Tributario</h1>
        <p>
          Respuestas con evidencia y acciones comerciales tipadas. Compartí tu
          passcode directamente en la conversación para habilitar herramientas.
        </p>
      </header>

      <div className="chat-history">
        {messages.length === 0 ? (
          <div className="empty">Inicia la conversación con una consulta.</div>
        ) : (
          <ul>
            {messages.map((msg) => (
              <li key={msg.id} className={`bubble ${msg.role}`}>
                <div className="bubble-role">
                  {msg.role === "user" ? "Tú" : "Copiloto"}
                </div>
                <div className="bubble-content">{msg.content}</div>
                {msg.error ? (
                  <div className="bubble-error">{msg.error}</div>
                ) : null}
                {msg.streaming ? <span className="typing">▍</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="chat-footer">
        <form onSubmit={handleSubmit} className="chat-form">
          <div className="form-row">
            <label htmlFor="prompt">Pregunta</label>
            <textarea
              id="prompt"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              rows={3}
              placeholder="Ej. ¿Qué ordenanza respalda la exención del impuesto a la patente para PYMES?"
              disabled={isStreaming}
            />
          </div>
          <div className="form-actions">
            <button type="submit" disabled={isStreaming || !input.trim()}>
              Consultar
            </button>
            <button
              type="button"
              onClick={stopStreaming}
              disabled={!isStreaming}
              className="secondary"
            >
              Detener
            </button>
          </div>
        </form>
        <button type="button" onClick={resetSession} className="secondary">
          Nueva conversación
        </button>
      </footer>
    </section>
  );
}
