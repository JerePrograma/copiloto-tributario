import type { RetrievedChunk } from "../rag/search";

export interface ClaimCheckResult {
  sentence: string;
  status: "supported" | "no_evidence";
  citations: string[];
}

function tokenize(sentence: string): string[] {
  return sentence
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z\sáéíóúñ]/gi, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4);
}

function sentenceFromChunk(chunk: RetrievedChunk, tokens: string[]): boolean {
  const haystack = chunk.content.toLowerCase();
  let matches = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      matches++;
    }
    if (matches >= 2) {
      return true;
    }
  }
  return false;
}

export function claimCheck(output: string, chunks: RetrievedChunk[]): ClaimCheckResult[] {
  const sentences = output
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);

  return sentences.map((sentence) => {
    const tokens = tokenize(sentence);
    const citations = chunks
      .filter((chunk) => sentenceFromChunk(chunk, tokens))
      .map((chunk) => chunk.href);

    return {
      sentence,
      status: citations.length > 0 ? "supported" : "no_evidence",
      citations,
    };
  });
}
