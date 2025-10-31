import type { RetrievedChunk } from "./search";

export type RerankerMode = "lexical" | "mmr";

export interface RerankOptions {
  mode?: RerankerMode;
  lambda?: number;
  limit?: number;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z\sáéíóúñ0-9]/gi, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

function lexicalScore(queryTokens: string[], chunk: RetrievedChunk): number {
  const haystack = chunk.content.toLowerCase();
  let matches = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) {
      matches++;
    }
  }
  return matches / Math.max(queryTokens.length, 1);
}

function maxSimilarity(chunk: RetrievedChunk, selected: RetrievedChunk[]): number {
  if (selected.length === 0) return 0;
  return selected.reduce((max, current) => Math.max(max, current.similarity), 0);
}

export function rerankChunks(
  query: string,
  chunks: RetrievedChunk[],
  options: RerankOptions = {}
): RetrievedChunk[] {
  const mode = options.mode ?? "lexical";
  const limit = options.limit ?? chunks.length;
  const queryTokens = tokenize(query);
  if (mode === "lexical") {
    return [...chunks]
      .map((chunk) => ({
        chunk,
        score:
          (chunk.hybridScore ?? chunk.similarity ?? 0) * 0.6 + lexicalScore(queryTokens, chunk) * 0.4,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.chunk);
  }
  // mmr (diversidad)
  const lambda = options.lambda ?? 0.7;
  const remaining = [...chunks];
  const selected: RetrievedChunk[] = [];
  while (remaining.length > 0 && selected.length < limit) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const relevance = candidate.hybridScore ?? candidate.similarity ?? 0;
      const diversity = maxSimilarity(candidate, selected);
      const score = lambda * relevance - (1 - lambda) * diversity;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    const [picked] = remaining.splice(bestIndex, 1);
    selected.push(picked);
  }
  return selected;
}
