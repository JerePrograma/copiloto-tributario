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
  similarity: number; // 1 - cosine_distance
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
  if (opts.jurisdiccion?.length) {
    const inList = opts.jurisdiccion.map((s) => `'${q(s)}'`).join(",");
    where.push(`d."jurisdiccion" IN (${inList})`);
  }
  if (opts.tipo?.length) {
    const inList = opts.tipo.map((s) => `'${q(s)}'`).join(",");
    where.push(`d."tipo" IN (${inList})`);
  }
  if (opts.anioMin) where.push(`d."anio" >= ${Math.floor(opts.anioMin)}`);
  if (opts.anioMax) where.push(`d."anio" <= ${Math.floor(opts.anioMax)}`);

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  // 3) Búsqueda vectorial (cosine). Ordenamos por distancia asc y calculamos similitud = 1 - dist
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
    `
    SELECT
      c."id",
      c."docId",
      c."idx",
      d."title",
      COALESCE(c."href", d."path") AS "href",
      c."content",
      1 - (c."embedding" <=> '${vectorLiteral}'::vector) AS similarity
    FROM "DocChunk" c
    JOIN "Doc" d ON d."id" = c."docId"
    ${whereSql}
    ORDER BY c."embedding" <=> '${vectorLiteral}'::vector
    LIMIT ${fetchN}
    `
  );
  const sqlMs = Math.round(performance.now() - sqlStart);

  // 4) Saneado + normalización de href en Windows
  const sanitized = rows.map((row) => ({
    id: row.id,
    docId: row.docId,
    idx: row.idx,
    title: row.title,
    href: (row.href ?? "#").replace(/\\/g, "/"),
    content: sanitizeContext(row.content),
    similarity: Number(row.similarity),
  }));

  // 5) Umbral y diversidad
  const filtered = sanitized.filter((r) => r.similarity >= minSim);
  const diversified = capByDoc(filtered, perDoc).slice(0, K);

  // 6) Métricas
  const sims = diversified.map((x) => x.similarity);
  const similarityAvg = sims.length
    ? sims.reduce((a, b) => a + b, 0) / sims.length
    : 0;
  const similarityMin = sims.length ? Math.min(...sims) : 0;

  return {
    chunks: diversified,
    metrics: {
      embeddingMs: emb.tMs,
      sqlMs,
      k: diversified.length,
      similarityAvg,
      similarityMin,
    },
  };
}
