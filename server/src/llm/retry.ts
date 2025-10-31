// src/llm/retry.ts
import {
  streamText,
  type StreamTextResult,
  type CoreMessage,
  type ToolSet,
  type ModelMessage,
} from "ai";
import { modelFor, resolveModelSequence } from "../lib/openrouter";

interface StreamParams {
  system?: string;
  messages: CoreMessage[];
  tools?: Record<string, unknown>;
  // lo dejamos por si arriba alguien lo usa, pero NO se lo pasamos a streamText
  maxSteps?: number;
}

export interface StreamWithFallbackResult {
  stream: StreamTextResult<any, any>;
  modelId: string;
  attempts: number;
}

function normalizeContent(content: CoreMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return String(content ?? "");
}

// CoreMessage -> ModelMessage
function toModelMessages(messages: CoreMessage[]): ModelMessage[] {
  return messages
    .filter((m) => m.role !== "system")
    .map<ModelMessage>((m) => {
      const base: ModelMessage = {
        role: m.role as ModelMessage["role"],
        content: normalizeContent(m.content),
      };

      if ((m as any).providerOptions) {
        return {
          ...base,
          providerOptions: (m as any).providerOptions,
        } as ModelMessage;
      }

      return base;
    });
}

export async function streamWithFallback(
  params: StreamParams,
  modelIds: string[] = resolveModelSequence()
): Promise<StreamWithFallbackResult> {
  const modelMessages = toModelMessages(params.messages);
  const toolset = params.tools as ToolSet | undefined;

  let lastError: unknown;

  for (let attempt = 0; attempt < modelIds.length; attempt++) {
    const modelId = modelIds[attempt];

    try {
      const stream = await streamText({
        model: modelFor(modelId),
        system: params.system,
        messages: modelMessages,
        tools: toolset,
        // NO maxSteps acá, esta versión no lo admite
      });

      // si querés respetar params.maxSteps, podés envolver stream.fullStream en /chat
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
