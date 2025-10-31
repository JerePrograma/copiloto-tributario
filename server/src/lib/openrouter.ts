import { createOpenAI } from "@ai-sdk/openai";
import { env } from "./env";

export const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: env.OPENROUTER_API_KEY,
  defaultHeaders: {
    "HTTP-Referer": "https://copiloto-tributario.local/",
    "X-Title": "Copiloto Tributario",
  },
});

export const defaultModel = () => openrouter(env.OPENROUTER_MODEL);

export function modelFor(modelId: string) {
  return openrouter(modelId);
}

export function resolveModelSequence(): string[] {
  const fallbacks = env.OPENROUTER_FALLBACK_MODELS
    ? env.OPENROUTER_FALLBACK_MODELS.split(",").map((item) => item.trim()).filter(Boolean)
    : [];
  const sequence = [env.OPENROUTER_MODEL, ...fallbacks];
  return Array.from(new Set(sequence));
}
