import { performance } from "node:perf_hooks";
import { prisma } from "../lib/prisma";
import { embed } from "../lib/ollama";
import { sanitizeContext } from "../security/sanitize";

export interface RetrievedChunk {
  id: string;
  docId: string;
  idx: number;
  title: string;
  href: string;
  content: string;
  similarity: number;
}

export interface SearchMetrics {
  embeddingMs: number;
  sqlMs: number;
  k: number;
  similarityAvg: number;
  similarityMin: number;
}

export interface SearchResult {
  chunks: RetrievedChunk[];
  metrics: SearchMetrics;
}

export async function searchDocuments(query: string, k = 6): Promise<SearchResult> {
  const embedding = await embed(query);
  const vectorLiteral = `[` + embedding.vector.map((value) => value.toFixed(6)).join(",") + `]`;

  const sqlStart = performance.now();
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      docId: string;
      idx: number;
      title: string;
      href: string | null;
      content: string;
      similarity: number;
    }>
  >(
    `SELECT c."id", c."docId", c."idx", d."title", COALESCE(c."href", d."path") AS "href", c."content", 1 - (c."embedding" <=> '${vectorLiteral}'::vector) AS similarity
     FROM "DocChunk" c
     JOIN "Doc" d ON d."id" = c."docId"
     ORDER BY c."embedding" <=> '${vectorLiteral}'::vector
     LIMIT ${k}`
  );
  const sqlMs = Math.round(performance.now() - sqlStart);

  const sanitized = rows.map((row) => ({
    id: row.id,
    docId: row.docId,
    idx: row.idx,
    title: row.title,
    href: row.href ?? "#",
    content: sanitizeContext(row.content),
    similarity: Number(row.similarity),
  }));

  const similarityValues = sanitized.map((item) => item.similarity);
  const similarityAvg =
    similarityValues.length > 0
      ? similarityValues.reduce((sum, value) => sum + value, 0) / similarityValues.length
      : 0;
  const similarityMin = similarityValues.length > 0 ? Math.min(...similarityValues) : 0;

  return {
    chunks: sanitized,
    metrics: {
      embeddingMs: embedding.tMs,
      sqlMs,
      k: sanitized.length,
      similarityAvg,
      similarityMin,
    },
  };
}
