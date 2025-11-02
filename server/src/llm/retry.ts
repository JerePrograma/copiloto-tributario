// src/llm/retry.ts
import {
  streamText,
  type StreamTextResult,
  type CoreMessage,
  type ToolSet,
  APICallError, // ✅ existe en ai@5
} from "ai";
import { modelFor, resolveModelSequence } from "../lib/openrouter";

interface StreamParams {
  system?: string;
  messages: CoreMessage[];
  tools?: Record<string, unknown>;
  temperature?: number;
  topP?: number;
  abortSignal?: AbortSignal;
}

export interface StreamWithFallbackResult {
  stream: StreamTextResult<any, any>;
  modelId: string;
  attempts: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Normaliza el error a {status, message} y detecta si parece venir del provider */
function asApiError(err: unknown): {
  status: number;
  message: string;
  fromApi: boolean;
} {
  const anyErr = err as any;
  const fromApi =
    err instanceof APICallError ||
    (anyErr &&
      typeof anyErr === "object" &&
      ("statusCode" in anyErr || "url" in anyErr));

  const status =
    err instanceof APICallError
      ? err.statusCode ?? 0
      : typeof anyErr?.statusCode === "number"
      ? anyErr.statusCode
      : 0;

  const message =
    err instanceof APICallError
      ? String(err.message ?? "")
      : typeof anyErr?.message === "string"
      ? anyErr.message
      : String(err);

  return { status, message, fromApi };
}

function shouldSkipModel(err: unknown): {
  skip: boolean;
  reason?: string;
  waitMs?: number;
} {
  const { status, message, fromApi } = asApiError(err);
  if (!fromApi) return { skip: false }; // error “duro” local: no seguir probando

  if (status === 401)
    return { skip: true, reason: "401 unauthorized (key / account)" };
  if (status === 402 || /Insufficient credits/i.test(message))
    return { skip: true, reason: "402 insufficient credits" };
  if (status === 403) return { skip: true, reason: "403 forbidden" };
  if (status === 404) return { skip: true, reason: "404 model not found" };
  if (status === 429)
    return { skip: true, reason: "429 rate limit", waitMs: 300 };
  if (status >= 500 && status < 600)
    return { skip: true, reason: `${status} server error`, waitMs: 200 };

  return { skip: false };
}

// No conviertas a ModelMessage: ai@5 acepta CoreMessage[].
export async function streamWithFallback(
  params: StreamParams,
  modelIds: string[] = resolveModelSequence()
): Promise<StreamWithFallbackResult> {
  const toolset = params.tools as ToolSet | undefined;

  let lastError: unknown;
  for (let attempt = 0; attempt < modelIds.length; attempt++) {
    const modelId = modelIds[attempt];
    try {
      console.info(
        `[LLM] intento ${attempt + 1}/${modelIds.length} → ${modelId}`
      );
      const stream = await streamText({
        model: modelFor(modelId),
        system: params.system,
        messages: params.messages,
        tools: toolset,
        temperature: params.temperature,
        topP: params.topP,
        abortSignal: params.abortSignal,
      });
      console.info(`[LLM] OK con ${modelId} (intento ${attempt + 1})`);
      return { stream, modelId, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      const policy = shouldSkipModel(error);

      if (policy.skip) {
        if (policy.waitMs) {
          const extra = Math.min(1000, attempt * 200); // backoff incremental suave
          await sleep(policy.waitMs + extra);
        }
        console.warn(
          `[LLM] Skip ${modelId}: ${
            policy.reason ?? "policy"
          } → siguiente modelo...`
        );
        if (attempt === modelIds.length - 1) {
          console.error(`[LLM] No quedan modelos para intentar`);
          throw error;
        }
        continue;
      }

      console.error(`[LLM] Error no-saltable con ${modelId}:`, error);
      throw error;
    }
  }

  throw lastError ?? new Error("No LLM models available");
}
