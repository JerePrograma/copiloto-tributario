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
