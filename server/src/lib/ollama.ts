import { performance } from "node:perf_hooks";
import { env } from "./env";

export class EmbeddingServiceUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "EmbeddingServiceUnavailableError";
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export interface EmbeddingResult {
  vector: number[];
  tMs: number;
}

export async function embed(text: string): Promise<EmbeddingResult> {
  const t0 = performance.now();
  let response: Response;
  try {
    response = await fetch(`${env.OLLAMA_BASE_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: env.EMBEDDING_MODEL, prompt: text }),
    });
  } catch (error) {
    throw new EmbeddingServiceUnavailableError(
      `No se pudo conectar con Ollama en ${env.OLLAMA_BASE_URL}. Asegurate de que el servicio esté corriendo (por ejemplo, con 'ollama serve').`,
      { cause: error }
    );
  }
  if (!response.ok) {
    throw new Error(`Ollama error: ${response.status}`);
  }
  const json = (await response.json()) as { embedding: number[] };
  const vector = json.embedding;
  if (!Array.isArray(vector) || vector.length !== env.EMBEDDING_DIM) {
    throw new Error(
      `Dimensión inválida: actual=${vector?.length ?? 0} esperada=${env.EMBEDDING_DIM}`
    );
  }
  const tMs = Math.round(performance.now() - t0);
  return { vector, tMs };
}
