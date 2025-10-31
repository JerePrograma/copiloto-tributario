"use client";

import { FormEvent, useCallback, useMemo, useRef, useState } from "react";
import { startSSE, type SSEMessage, type SSEController } from "@/lib/sse";
import type {
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

interface MetricsEventPayload extends MetricsSnapshot {}

interface ContextEventPayload {
  citations: Citation[];
}

interface ClaimEventPayload {
  claims: ClaimCheckEntry[];
}

const API_BASE = (
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001"
).replace(/\/$/, "");

export default function Chat({
  onMetrics,
  onTimeline,
  onCitations,
  onClaims,
}: ChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [passcode, setPasscode] = useState("");
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
          const detailString =
            payload.detail && typeof payload.detail !== "string"
              ? JSON.stringify(payload.detail, null, 2)
              : (payload.detail as string | undefined);
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
          // Opcional: marcar visualmente el bubble como “ajustado por evidencia”.
          // No se inyecta contenido.
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
      pushTimeline,
      updateMessage,
    ]
  );

  const resetTimeline = useCallback(() => {
    onTimeline(() => []);
  }, [onTimeline]);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!input.trim() || isStreaming) return;

      const userMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: input.trim(),
      };
      appendMessage(userMessage);
      setInput("");
      resetTimeline();
      onCitations([]);
      onClaims([]);

      const payload = {
        passcode: passcode || undefined,
        messages: [...messages, userMessage].map((msg) => ({
          role: msg.role,
          content: msg.content,
        })),
      };

      controllerRef.current?.abort();
      const controller = startSSE(
        chatEndpoint,
        {
          method: "POST",
          body: JSON.stringify(payload),
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
      appendMessage,
      chatEndpoint,
      handleSSEEvent,
      input,
      isStreaming,
      messages,
      onCitations,
      onClaims,
      passcode,
      resetTimeline,
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
          Respuestas con evidencia y acciones comerciales tipadas. Ingresa el
          passcode para habilitar herramientas.
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
            <label htmlFor="passcode">Passcode</label>
            <input
              id="passcode"
              type="password"
              value={passcode}
              onChange={(event) => setPasscode(event.target.value)}
              placeholder="Opcional"
              autoComplete="off"
            />
          </div>
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
      </footer>
    </section>
  );
}
