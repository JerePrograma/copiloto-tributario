import { performance } from "node:perf_hooks";

const OLLAMA = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const MODEL = process.env.EMBEDDING_MODEL || "nomic-embed-text";
const DIM = Number(process.env.EMBEDDING_DIM || 768);

export async function embed(text: string) {
  const t0 = performance.now();
  const res = await fetch(`${OLLAMA}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const json = await res.json();
  const vec: number[] = json.embedding;
  if (!Array.isArray(vec) || vec.length !== DIM) {
    throw new Error(`Dimensión inválida: got=${vec?.length} expected=${DIM}`);
  }
  const t_ms = Math.round(performance.now() - t0);
  return { vector: vec, t_ms };
}
