import { performance } from "node:perf_hooks";
import { prisma } from "../lib/prisma";
import {
  embed,
  EmbeddingServiceUnavailableError,
  type EmbeddingResult,
} from "../lib/ollama";
import { env } from "../lib/env";
import { sanitizeContext } from "../security/sanitize";
import { rerankChunks, type RerankerMode } from "./rerank";
import {
  restrictedJurisdictions,
  sanitizeJurisdictions,
} from "../security/policies";

/* ====================== Tipos ====================== */
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
  vectorWeight: number;
  textWeight: number;
  weightSource: "auto" | "manual" | "phase";
  phase?: string;
  relaxed?: boolean;
  vectorFallback?: boolean;
  // extras informativos
  tsQueryUsed?: "plainto" | "websearch" | "ilike-fallback";
  tokens?: number;
}

export interface SearchResult {
  chunks: RetrievedChunk[];
  metrics: SearchMetrics;
}

export interface SearchOpts {
  k?: number; // resultados finales
  perDoc?: number; // máximo por documento (diversidad)
  minSim?: number; // umbral mínimo de similitud vectorial
  pathLike?: string; // filtro rápido por ruta (ILIKE)
  jurisdiccion?: string[];
  tipo?: string[];
  anioMin?: number;
  anioMax?: number;
  authenticated?: boolean;
  rerankMode?: RerankerMode;
  rerankLimit?: number;
  vectorWeight?: number;
  textWeight?: number;
  phase?: string;
  phaseWeights?: Record<string, { vectorWeight?: number; textWeight?: number }>;
}

/* ====================== Utils ====================== */

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

/** escapado mínimo para patrón ILIKE/tsquery */
function q(s: string) {
  return s.replace(/'/g, "''");
}

/** normaliza href Windows */
function normHref(href: string | null) {
  return (href ?? "#").replace(/\\/g, "/");
}

/* ====================== Core ====================== */

export async function searchDocuments(
  query: string,
  k = 6,
  opts: SearchOpts = {}
): Promise<SearchResult> {
  const tokens = query.trim().split(/\s+/).filter(Boolean).length;

  const K = Math.max(1, Math.min(opts.k ?? k, 50));
  const perDoc = Math.max(1, Math.min(opts.perDoc ?? 3, 10));
  const defaultMinSim = tokens <= 2 ? 0.05 : 0.15;
  const minSim = Math.max(0, Math.min(opts.minSim ?? defaultMinSim, 0.999));
  const fetchN = K * 4; // traemos de más para diversificar

  // heurísticas simples
  const legalist = /(exenci[oó]n|patente|automotores?|pymes?)/i.test(query);
  const multiWord = tokens >= 3;
  const longQuery = tokens >= 8;
  const hasPhrase = /"[^"]+"/.test(query);
  const hasConnectors =
    /[,;]|\b(de(l)?|para|sobre|seg[uú]n|respecto|contra|sin|con)\b/i.test(
      query
    );

  // pesos auto
  let autoTextWeight = 0.52;
  if (tokens <= 2) autoTextWeight = 0.6;
  if (legalist) autoTextWeight = Math.max(autoTextWeight, 0.6);
  if (multiWord) autoTextWeight = Math.min(autoTextWeight, 0.45);
  if (longQuery) autoTextWeight = Math.min(autoTextWeight, 0.4);
  if (hasPhrase) autoTextWeight = Math.min(autoTextWeight, 0.35);
  if (hasConnectors && multiWord)
    autoTextWeight = Math.min(autoTextWeight, 0.43);
  const autoVectorWeight = 1 - autoTextWeight;

  // overrides por fase
  const phaseKey = opts.phase ?? "default";
  const phaseOverrides =
    opts.phaseWeights?.[phaseKey] ?? opts.phaseWeights?.default;
  const overrideVector =
    phaseOverrides?.vectorWeight ?? opts.vectorWeight ?? undefined;
  const overrideText =
    phaseOverrides?.textWeight ?? opts.textWeight ?? undefined;

  let weightSource: "auto" | "manual" | "phase" = "auto";
  if (
    phaseOverrides &&
    (phaseOverrides.vectorWeight !== undefined ||
      phaseOverrides.textWeight !== undefined)
  ) {
    weightSource = "phase";
  } else if (opts.vectorWeight !== undefined || opts.textWeight !== undefined) {
    weightSource = "manual";
  }

  let vectorWeight =
    overrideVector ??
    (overrideText !== undefined ? 1 - overrideText : autoVectorWeight);
  let textWeight =
    overrideText ??
    (overrideVector !== undefined ? 1 - overrideVector : autoTextWeight);

  vectorWeight = Math.max(0, Math.min(vectorWeight, 1));
  textWeight = Math.max(0, Math.min(textWeight, 1));
  const totalWeight = vectorWeight + textWeight;
  if (totalWeight === 0) {
    vectorWeight = 0.5;
    textWeight = 0.5;
  } else if (Math.abs(totalWeight - 1) > 0.001) {
    vectorWeight = vectorWeight / totalWeight;
    textWeight = textWeight / totalWeight;
  }

  const auth = Boolean(opts.authenticated);
  const restricted = restrictedJurisdictions(auth);
  const sanitizedJurisdictions = sanitizeJurisdictions(opts.jurisdiccion, auth);

  // 1) Embedding de la query
  let emb: EmbeddingResult;
  let vectorFallback = false;
  try {
    emb = await embed(query);
  } catch (error) {
    if (error instanceof EmbeddingServiceUnavailableError) {
      console.warn(
        "Fallo el servicio de embeddings, se desactiva la búsqueda vectorial.",
        error
      );
      vectorFallback = true;
      vectorWeight = 0;
      textWeight = 1;
      weightSource = "manual";
      emb = {
        vector: Array.from({ length: env.EMBEDDING_DIM }, () => 0),
        tMs: 0,
      };
    } else {
      throw error;
    }
  }
  const vectorLiteral =
    "[" + emb.vector.map((v) => Number(v).toFixed(6)).join(",") + "]";

  // 2) WHERE dinámico (sin filtrar por embedding, para permitir FTS puro)
  const where: string[] = [];
  if (opts.pathLike?.trim()) {
    where.push(`d."path" ILIKE '%${q(opts.pathLike.trim())}%'`);
  }
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

  // 3) tsquery según longitud
  const tsQueryUsed: "plainto" | "websearch" =
    tokens <= 2 ? "plainto" : "websearch";
  const tsQueryExpr =
    tsQueryUsed === "plainto"
      ? `plainto_tsquery('spanish', '${q(query)}')`
      : `websearch_to_tsquery('spanish', '${q(query)}')`;

  const textRankExpr = `ts_rank_cd(
    setweight(to_tsvector('spanish', coalesce(d."title", '')), 'A') ||
    setweight(to_tsvector('spanish', c."content"), 'B'),
    ${tsQueryExpr}
  )`;

  // 4) SELECT híbrido tolerante a NULL + boosts
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
      /* vector sim tolerante a NULL */
      CASE WHEN c."embedding" IS NULL
           THEN 0
           ELSE 1 - (c."embedding" <=> '${vectorLiteral}'::vector)
      END AS "similarity",
      ${textRankExpr} AS "textScore",
      (
        (${vectorWeight} * CASE WHEN c."embedding" IS NULL
                                THEN 0
                                ELSE 1 - (c."embedding" <=> '${vectorLiteral}'::vector)
                           END)
        + (${textWeight} * ${textRankExpr})
        /* señales simples: secciones operativas y leve recencia por año */
        + CASE
            WHEN c."content" ~* E'(^|\\n)##\\s*pasos' THEN 0.08
            WHEN c."content" ~* E'(^|\\n)##\\s*errores(\\s+comunes)?' THEN 0.06
            ELSE 0
          END
        + COALESCE(LEAST(GREATEST((d."anio" - 2019) * 0.003, -0.03), 0.06), 0)
      ) AS "hybridScore",
      d."jurisdiccion",
      d."tipo",
      d."anio"
    FROM "DocChunk" c
    JOIN "Doc" d ON d."id" = c."docId"
    ${whereSql}
    ORDER BY "hybridScore" DESC NULLS LAST
    LIMIT ${fetchN}
    `
  );
  let sqlMs = Math.round(performance.now() - sqlStart);
  const ftsMs = sqlMs;

  // 5) Si no hay filas, rescate ILIKE laxo sobre título/contenido
  let effectiveRows = rows;
  if (!effectiveRows.length) {
    const words = query
      .trim()
      .split(/\s+/)
      .filter((w) => w.length >= 3)
      .slice(0, 6)
      .map((w) => q(w));

    if (words.length) {
      const orLike = words
        .map((w) => `(d."title" ILIKE '%${w}%' OR c."content" ILIKE '%${w}%')`)
        .join(" OR ");

      const ilikeStart = performance.now();
      effectiveRows = await prisma.$queryRawUnsafe<
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
          CASE WHEN c."embedding" IS NULL
               THEN 0
               ELSE 1 - (c."embedding" <=> '${vectorLiteral}'::vector)
          END AS "similarity",
          NULL::float AS "textScore",
          (
            (${vectorWeight} * CASE WHEN c."embedding" IS NULL
                                    THEN 0
                                    ELSE 1 - (c."embedding" <=> '${vectorLiteral}'::vector)
                               END)
            + COALESCE(LEAST(GREATEST((d."anio" - 2019) * 0.003, -0.03), 0.06), 0)
          ) AS "hybridScore",
          d."jurisdiccion",
          d."tipo",
          d."anio"
        FROM "DocChunk" c
        JOIN "Doc" d ON d."id" = c."docId"
        ${whereSql ? whereSql + " AND " : "WHERE "} (${orLike})
        ORDER BY "hybridScore" DESC NULLS LAST
        LIMIT ${fetchN}
        `
      );
      sqlMs += Math.round(performance.now() - ilikeStart);
    }
  }

  // 6) Saneado
  const sanitized = effectiveRows.map((row) => ({
    id: row.id,
    docId: row.docId,
    idx: row.idx,
    title: row.title,
    href: normHref(row.href),
    content: sanitizeContext(row.content),
    similarity: Number(row.similarity),
    textScore: row.textScore === null ? undefined : Number(row.textScore),
    hybridScore: row.hybridScore === null ? undefined : Number(row.hybridScore),
    jurisdiccion: row.jurisdiccion,
    tipo: row.tipo,
    anio: row.anio,
  }));

  // 7) Filtro combinado: respeta vector y FTS
  const filtered = sanitized.filter((r) => {
    const okVec = vectorWeight > 0 ? r.similarity >= minSim : true;
    const okFts = textWeight > 0 ? (r.textScore ?? 0) > 0 : true;
    return okVec && okFts;
  });

  // 8) Diversidad por documento
  const diversified = capByDoc(filtered, perDoc).slice(0, K);

  // 9) Re-rank opcional
  let reranked: RetrievedChunk[] = diversified;
  if (opts.rerankMode) {
    reranked = rerankChunks(query, diversified, {
      mode: opts.rerankMode,
      limit: opts.rerankLimit ?? K,
    }) as RetrievedChunk[]; // si la firma de rerankChunks ya devuelve RetrievedChunk[], quita el "as"
  }

  // 10) Métricas
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
      vectorWeight,
      textWeight,
      weightSource,
      phase: opts.phase,
      vectorFallback,
      tsQueryUsed: effectiveRows === rows ? tsQueryUsed : "ilike-fallback",
      tokens,
    },
  };
}
