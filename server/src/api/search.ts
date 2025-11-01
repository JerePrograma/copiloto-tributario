// src/api/search.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { searchDocuments } from "../rag/search";
import { recordSearchAudit } from "../metrics/audit";

// Normalización y sinónimos iguales a /api/chat
function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function norm(s: string): string {
  return stripAccents(s).toLowerCase();
}
const LEX = {
  exencion: [
    "exención",
    "exencion",
    "exento",
    "exentos",
    "exímase",
    "eximase",
    "exceptúase",
    "exceptuase",
    "no alcanzad",
  ],
  automotor: [
    "automotor",
    "automotores",
    "rodado",
    "rodados",
    "vehiculo",
    "vehículos",
    "vehiculo/s",
    "patente",
    "impuesto a los automotores",
  ],
  pyme: [
    "pyme",
    "pymes",
    "mipyme",
    "mi pyme",
    "micro",
    "pequena",
    "pequeña",
    "mediana",
    "sme",
  ],
  pba: ["provincia de buenos aires", "pba", "arba", "buenos aires"],
  iibb: [
    "ingresos brutos",
    "iibb",
    "regimen simplificado",
    "régimen simplificado",
  ],
};
type AnchorGroups = string[][];

function buildAnchorGroupsFromQuery(
  q: string,
  jurisdictionHint?: string
): { groups: AnchorGroups; minHits: number } {
  const nq = norm(q);
  const groups: AnchorGroups = [];
  // heurística: si menciona automotores/patente → usar automotor+exención, y si menciona PyME → agregar pyme
  if (/(automotor|patente|rodado|vehicul)/.test(nq)) groups.push(LEX.automotor);
  if (/(exenci|exento|eximase|exceptuase|no alcanzad)/.test(nq))
    groups.push(LEX.exencion);
  if (/(pyme|mipyme|micro|pequen|mediana|sme)/.test(nq)) groups.push(LEX.pyme);
  if (/(ingresos brutos|iibb|simplificado)/.test(nq)) groups.push(LEX.iibb);
  if (jurisdictionHint === "AR-BA" || /(buenos aires|pba|arba)/.test(nq))
    groups.push(LEX.pba);

  // default razonable si no detectamos nada
  if (groups.length === 0) groups.push(LEX.exencion);

  const minHits = groups.length > 1 ? 2 : 1;

  return { groups, minHits };
}
function hasCooccurrence(
  text: string,
  groups: AnchorGroups,
  minGroupsHit = 2
): boolean {
  const t = norm(text);
  let hits = 0;
  for (const g of groups) if (g.some((w) => t.includes(norm(w)))) hits++;
  return hits >= minGroupsHit;
}
function filterByCooccurrence<T extends { content: string }>(
  chunks: T[],
  groups: AnchorGroups,
  minGroupsHit = 2
): T[] {
  const effectiveMin =
    groups.length === 1 ? 1 : Math.max(1, Math.min(minGroupsHit, groups.length));
  return chunks.filter((c) =>
    hasCooccurrence(c.content, groups, effectiveMin)
  );
}
function rewriteQueryStrict(groups: AnchorGroups): string {
  return groups
    .map((g) => "(" + g.map((w) => `"${w}"`).join(" OR ") + ")")
    .join(" ");
}
function rewriteQueryExpanded(groups: AnchorGroups): string {
  const flat = [...new Set(groups.flat())];
  return flat.map((w) => `"${w}"`).join(" OR ");
}

const requestSchema = z.object({
  passcode: z.string().min(4).optional(),
  query: z.string().min(2),
  k: z.number().int().min(1).max(20).optional(),
  perDoc: z.number().int().min(1).max(6).optional(),
  minSim: z.number().min(0).max(1).optional(),
  reranker: z.enum(["lexical", "mmr"]).optional(),
  filters: z
    .object({
      pathLike: z.string().optional(),
      jurisdiccion: z.array(z.string()).optional(), // aceptado para futuro
      tipo: z.array(z.string()).optional(),
      anioMin: z.number().int().optional(),
      anioMax: z.number().int().optional(),
    })
    .optional(),
  // Hint opcional para robustez
  jurisdictionHint: z.enum(["AR-BA", "AR-CABA", "AR-CBA", "AR-NAC"]).optional(),
});

async function verifyPasscode(passcode?: string) {
  if (!passcode)
    return { authenticated: false, userId: undefined as string | undefined };
  const invited = await prisma.invitedUser.findFirst({ where: { passcode } });
  return { authenticated: Boolean(invited), userId: invited?.id };
}

export async function search(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req)
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const parsed = requestSchema.parse(rawBody ? JSON.parse(rawBody) : {});

    const { authenticated, userId } = await verifyPasscode(parsed.passcode);

    // Filtros
    const filters = parsed.filters ?? {};
    const cleanedFilters = Object.fromEntries(
      Object.entries(filters).filter(([, value]) =>
        Array.isArray(value)
          ? value.length > 0
          : value !== undefined && value !== null && value !== ""
      )
    );

    // pathLike por hint de jurisdicción
    const autoPathLike =
      parsed.jurisdictionHint === "AR-BA"
        ? "provincial/ar-ba-%"
        : parsed.jurisdictionHint === "AR-CABA"
        ? "provincial/ar-caba-%"
        : parsed.jurisdictionHint === "AR-CBA"
        ? "provincial/ar-cba-%"
        : undefined;

    const pathLike = filters.pathLike ?? autoPathLike;

    // Anclas desde la query
    const { groups, minHits } = buildAnchorGroupsFromQuery(
      parsed.query,
      parsed.jurisdictionHint
    );

    // Fase 1: léxica estricta con co-ocurrencia (>=2 grupos por defecto)
    const qStrict = rewriteQueryStrict(groups);
    let result = await searchDocuments(qStrict, parsed.k ?? 12, {
      authenticated,
      pathLike,
      rerankMode: "lexical",
      perDoc: parsed.perDoc ?? 4,
      minSim: parsed.minSim ?? 0.35,
      phase: "lexical-strict",
    });
    let filtered = filterByCooccurrence(result.chunks, groups, minHits);

    let phase = "lexical-strict";
    if (filtered.length === 0) {
      // Fase 2: MMR expandida
      const qExpanded = `${rewriteQueryExpanded(groups)} ${parsed.query}`;
      result = await searchDocuments(qExpanded, parsed.k ?? 12, {
        authenticated,
        pathLike,
        rerankMode: "mmr",
        perDoc: parsed.perDoc ?? 4,
        minSim: parsed.minSim ?? 0.35,
        phase: "mmr-expanded",
      });
      filtered = filterByCooccurrence(result.chunks, groups, minHits);
      phase = "mmr-expanded";
    }

    if (filtered.length === 0) {
      // Fase 3: negativa (exención + automotor) para listar capítulo
      const relaxedGroups: AnchorGroups = groups.some(
        (g) => g === LEX.automotor
      )
        ? [LEX.exencion, LEX.automotor]
        : [LEX.exencion];
      const qRelaxed = rewriteQueryStrict(relaxedGroups);
      result = await searchDocuments(qRelaxed, parsed.k ?? 12, {
        authenticated,
        pathLike,
        rerankMode: "lexical",
        perDoc: parsed.perDoc ?? 4,
        minSim: parsed.minSim ?? 0.35,
        phase: "negative-evidence",
      });
      filtered = filterByCooccurrence(
        result.chunks,
        relaxedGroups,
        Math.min(minHits, relaxedGroups.length || 1)
      );
        phase = "negative-evidence";
        result.metrics.relaxed = true;
    }

    // Auditoría
    await recordSearchAudit({
      userId,
      passcodeValid: authenticated,
      query: parsed.query,
      filters: cleanedFilters,
      metrics: { ...(result.metrics as any), phase, pathLike },
    });

    // Ignorados (hoy no soportados)
    const ignoredFilters: string[] = [];
    if ("jurisdiccion" in cleanedFilters) ignoredFilters.push("jurisdiccion");
    if ("tipo" in cleanedFilters) ignoredFilters.push("tipo");
    if ("anioMin" in cleanedFilters || "anioMax" in cleanedFilters)
      ignoredFilters.push("anioMin/anioMax");

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        results: filtered,
        metrics: { ...(result.metrics as any), phase, pathLike },
        authenticated,
        ignoredFilters: ignoredFilters.length ? ignoredFilters : undefined,
        anchorsUsed: groups, // útil para depurar qué sinónimos se aplicaron
      })
    );
  } catch (error) {
    const isValidation =
      error instanceof z.ZodError || error instanceof SyntaxError;
    const message = isValidation
      ? (error as Error).message
      : (error as Error).message ?? "Unexpected error";
    res.writeHead(isValidation ? 400 : 500, {
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify({ error: message }));
  }
}
