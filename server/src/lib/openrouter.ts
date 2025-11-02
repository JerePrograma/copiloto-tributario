// src/lib/openrouter.ts
import { createOpenAI } from "@ai-sdk/openai";
import { env } from "./env";

// En dev bloqueamos modelos pagos por defecto.
// Seteá ALLOW_PAID=1 para habilitarlos localmente si querés.
const ALLOW_PAID =
  process.env.ALLOW_PAID === "1" || process.env.NODE_ENV === "production";

// Cola de salvataje con modelos gratis razonables (ordenados por utilidad general).
const FREE_DEFAULTS = [
  "google/gemini-2.0-flash-exp:free",
  "deepseek/deepseek-chat-v3.1:free",
  "qwen/qwen3-14b:free",
  "mistralai/mistral-7b-instruct:free",
  "nvidia/nemotron-nano-9b-v2:free",
];

export const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: env.OPENROUTER_API_KEY, // Bearer se agrega solo por el provider
  headers: {
    "HTTP-Referer": process.env.FRONTEND_ORIGIN ?? "http://localhost:3000",
    "X-Title": "Copiloto Tributario",
  },
});

// API mínima que usa el resto del código
export function modelFor(modelId: string) {
  return openrouter.chat(modelId);
}

export function resolveModelSequence(): string[] {
  const fallbacks = env.OPENROUTER_FALLBACK_MODELS
    ? env.OPENROUTER_FALLBACK_MODELS.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  // Base: env + fallbacks + salvataje free
  const raw = [env.OPENROUTER_MODEL, ...fallbacks, ...FREE_DEFAULTS];

  // De-dupe preservando orden
  const dedup = Array.from(new Set(raw));

  // En dev, si no se permiten pagos, filtramos a ':free' únicamente.
  if (!ALLOW_PAID) {
    const onlyFree = dedup.filter((id) => id.endsWith(":free"));
    if (onlyFree.length > 0) return onlyFree;
    // Si por algún motivo no hay free, devolvé la lista dedup (mejor que nada).
    return dedup;
  }

  return dedup;
}

// Conveniencia
export const defaultModel = () => modelFor(env.OPENROUTER_MODEL);

// Export por si querés inspeccionar/mostrar en healthchecks
export { FREE_DEFAULTS };
