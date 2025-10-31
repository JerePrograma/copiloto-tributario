import { streamText, type StreamTextResult, type CoreMessage } from "ai";
import { modelFor, resolveModelSequence } from "../lib/openrouter";

interface StreamParams {
  messages: CoreMessage[];
  tools?: Record<string, unknown>;
  maxSteps?: number;
}

export interface StreamWithFallbackResult {
  stream: StreamTextResult;
  modelId: string;
  attempts: number;
}

export async function streamWithFallback(
  params: StreamParams,
  modelIds: string[] = resolveModelSequence()
): Promise<StreamWithFallbackResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < modelIds.length; attempt++) {
    const modelId = modelIds[attempt];
    try {
      const stream = await streamText({
        model: modelFor(modelId),
        messages: params.messages,
        tools: params.tools,
        maxSteps: params.maxSteps,
      });
      return { stream, modelId, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      if (attempt === modelIds.length - 1) {
        throw error;
      }
    }
  }
  throw lastError ?? new Error("No LLM models available");
}
