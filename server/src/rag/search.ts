import { performance } from "node:perf_hooks";
import { prisma } from "../lib/prisma";
import { embed } from "../lib/ollama";
import { sanitizeContext } from "../security/sanitize";
import { rerankChunks, type RerankerMode } from "./rerank";
import {
  restrictedJurisdictions,
  sanitizeJurisdictions,
} from "../security/policies";

export interface RetrievedChunk {
  id: string;
  docId: string;
  idx: number;
  title: string;
  href: string;
  content: string;
  similarity: number; // 1 - cosine_distance
  hybridScore?: number;
  textScore?: number;
  jurisdiccion?: string | null;
  tipo?: string | null;
  anio?: number | null;
}

export interface SearchMetrics {
  embeddingMs: number;
  sqlMs: number;
  ftsMs?: number;
  k: number;
  similarityAvg: number;
  similarityMin: number;
  hybridAvg?: number;
  hybridMin?: number;
  reranked?: boolean;
  restrictedCount?: number;
}

export interface SearchResult {
  chunks: RetrievedChunk[];
  metrics: SearchMetrics;
}

export interface SearchOpts {
  k?: number; // resultados finales
  perDoc?: number; // máximo por documento (diversidad)
  minSim?: number; // umbral mínimo de similitud
  pathLike?: string; // filtro rápido por ruta (ILIKE)
  // Si luego persistís metadatos del front-matter en "Doc":
  jurisdiccion?: string[];
  tipo?: string[];
  anioMin?: number;
  anioMax?: number;
  authenticated?: boolean;
  rerankMode?: RerankerMode;
  rerankLimit?: number;
  vectorWeight?: number;
  textWeight?: number;
}

/** capea resultados por documento (diversidad) */
function capByDoc<T extends { href: string }>(rows: T[], perDoc = 3) {
  const seen = new Map<string, number>();
  const out: T[] = [];
  for (const r of rows) {
    const key = r.href.split("#")[0];
    const n = seen.get(key) ?? 0;
    if (n < perDoc) {
      out.push(r);
      seen.set(key, n + 1);
    }
  }
  return out;
}

/** escapado mínimo para patrón ILIKE; no interpolar texto libre sin validar */
function q(s: string) {
  return s.replace(/'/g, "''");
}

export async function searchDocuments(
  query: string,
  k = 6,
  opts: SearchOpts = {}
): Promise<SearchResult> {
  const K = Math.max(1, Math.min(opts.k ?? k, 50));
  const perDoc = Math.max(1, Math.min(opts.perDoc ?? 3, 10));
  const minSim = Math.max(0, Math.min(opts.minSim ?? 0.15, 0.999));
  const fetchN = K * 4; // traemos de más para poder diversificar
  const tokens = query.trim().split(/\s+/).length;
  const legalist = /(exenci[oó]n|patente|automotores?|pymes?)/i.test(query);
  const textWeightAuto =
    opts.textWeight ?? (tokens <= 6 || legalist ? 0.6 : 0.3);
  const vectorWeightAuto = opts.vectorWeight ?? 1 - textWeightAuto;

  const vectorWeight = Math.max(0, Math.min(vectorWeightAuto, 1));
  const textWeight = Math.max(0, Math.min(textWeightAuto, 1));
  const auth = Boolean(opts.authenticated);
  const restricted = restrictedJurisdictions(auth);
  const sanitizedJurisdictions = sanitizeJurisdictions(opts.jurisdiccion, auth);

  // 1) Embedding de la query
  const emb = await embed(query);
  const vectorLiteral =
    "[" + emb.vector.map((v) => Number(v).toFixed(6)).join(",") + "]";

  // 2) WHERE dinámico (solo cláusulas seguras)
  const where: string[] = [`c."embedding" IS NOT NULL`];
  if (opts.pathLike?.trim()) {
    where.push(`d."path" ILIKE '%${q(opts.pathLike.trim())}%'`);
  }
  // Si tenés columnas en "Doc" (agregalas con la migración de abajo)
  if (sanitizedJurisdictions?.length) {
    const inList = sanitizedJurisdictions.map((s) => `'${q(s)}'`).join(",");
    where.push(`d."jurisdiccion" IN (${inList})`);
  }
  if (opts.tipo?.length) {
    const inList = opts.tipo.map((s) => `'${q(s)}'`).join(",");
    where.push(`d."tipo" IN (${inList})`);
  }
  if (opts.anioMin) where.push(`d."anio" >= ${Math.floor(opts.anioMin)}`);
  if (opts.anioMax) where.push(`d."anio" <= ${Math.floor(opts.anioMax)}`);
  if (restricted.length) {
    const notIn = restricted.map((s) => `'${q(s)}'`).join(",");
    where.push(
      `(d."jurisdiccion" IS NULL OR d."jurisdiccion" NOT IN (${notIn}))`
    );
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  // 3) Búsqueda híbrida: vector + FTS en la misma consulta
  const sqlStart = performance.now();
  const textRankExpr = `ts_rank_cd(setweight(to_tsvector('spanish', coalesce(d."title", '')), 'A') || setweight(to_tsvector('spanish', c."content"), 'B'), plainto_tsquery('spanish', '${q(
    query
  )}'))`;
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      docId: string;
      idx: number;
      title: string;
      href: string | null;
      content: string;
      similarity: number;
      textScore: number | null;
      hybridScore: number | null;
      jurisdiccion: string | null;
      tipo: string | null;
      anio: number | null;
    }>
  >(
    `
    SELECT
      c."id",
      c."docId",
      c."idx",
      d."title",
      COALESCE(c."href", d."path") AS "href",
      c."content",
      1 - (c."embedding" <=> '${vectorLiteral}'::vector) AS similarity,
      ${textRankExpr} AS "textScore",
      ((${vectorWeight} * (1 - (c."embedding" <=> '${vectorLiteral}'::vector))) + (${textWeight} * ${textRankExpr})) AS "hybridScore",
      d."jurisdiccion",
      d."tipo",
      d."anio"
    FROM "DocChunk" c
    JOIN "Doc" d ON d."id" = c."docId"
    ${whereSql}
    ORDER BY "hybridScore" DESC
    LIMIT ${fetchN}
    `
  );
  const sqlMs = Math.round(performance.now() - sqlStart);
  const ftsMs = sqlMs;

  // 4) Saneado + normalización de href en Windows
  const sanitized = rows.map((row) => ({
    id: row.id,
    docId: row.docId,
    idx: row.idx,
    title: row.title,
    href: (row.href ?? "#").replace(/\\/g, "/"),
    content: sanitizeContext(row.content),
    similarity: Number(row.similarity),
    textScore: row.textScore === null ? undefined : Number(row.textScore),
    hybridScore: row.hybridScore === null ? undefined : Number(row.hybridScore),
    jurisdiccion: row.jurisdiccion,
    tipo: row.tipo,
    anio: row.anio,
  }));

  // 5) Umbral y diversidad
  const filtered = sanitized.filter((r) => r.similarity >= minSim);
  const diversified = capByDoc(filtered, perDoc).slice(0, K);

  let reranked = diversified;
  if (opts.rerankMode) {
    reranked = rerankChunks(query, diversified, {
      mode: opts.rerankMode,
      limit: opts.rerankLimit ?? K,
    });
  }

  // 6) Métricas
  const sims = reranked.map((x) => x.similarity);
  const similarityAvg = sims.length
    ? sims.reduce((a, b) => a + b, 0) / sims.length
    : 0;
  const similarityMin = sims.length ? Math.min(...sims) : 0;
  const hybridScores = reranked
    .map((x) => x.hybridScore ?? x.similarity)
    .filter((score): score is number => score !== undefined);
  const hybridAvg = hybridScores.length
    ? hybridScores.reduce((a, b) => a + b, 0) / hybridScores.length
    : undefined;
  const hybridMin = hybridScores.length ? Math.min(...hybridScores) : undefined;

  return {
    chunks: reranked,
    metrics: {
      embeddingMs: emb.tMs,
      sqlMs,
      ftsMs,
      k: reranked.length,
      similarityAvg,
      similarityMin,
      hybridAvg,
      hybridMin,
      reranked: Boolean(opts.rerankMode),
      restrictedCount: restricted.length,
    },
  };
}
