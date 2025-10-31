// metadata.ts — sin Zod en el hot-path, defensivo

export interface LegalMetadata {
  jurisdiccion?: string;
  tipo?: string;
  anio?: number;
  tags?: string[];
  raw?: Record<string, unknown>;
}

const JURISDICTION_ALIASES: Record<string, string> = {
  caba: "AR-CABA",
  "ciudad de buenos aires": "AR-CABA",
  argentina: "AR-NACION",
  nacional: "AR-NACION",
  nacion: "AR-NACION",
};

const TYPE_ALIASES: Record<string, string> = {
  ley: "LEY",
  decreto: "DECRETO",
  ordenanza: "ORDENANZA",
  resolucion: "RESOLUCION",
};

function asRecord(u: unknown): Record<string, unknown> {
  return u && typeof u === "object" && !Array.isArray(u)
    ? (u as Record<string, unknown>)
    : {};
}

function normalizeJurisdiction(value?: string): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim().toLowerCase();
  return JURISDICTION_ALIASES[cleaned] ?? value.trim().toUpperCase();
}

function normalizeTipo(value?: string): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim().toLowerCase();
  return TYPE_ALIASES[cleaned] ?? value.trim().toUpperCase();
}

function normalizeAnio(value?: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  const year = Math.round(parsed);
  if (year < 1900 || year > 2100) return undefined;
  return year;
}

// Front matter muy simple: YAML-lite línea a línea
export function extractFrontMatter(raw: string): {
  body: string;
  metadata: Record<string, unknown>;
} {
  if (!raw.startsWith("---")) return { body: raw, metadata: {} };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { body: raw, metadata: {} };

  const header = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\s+/, "");
  const metadata: Record<string, unknown> = {};

  for (const line of header.split(/\r?\n/)) {
    const [keyRaw, ...rest] = line.split(":");
    const key = keyRaw?.trim();
    const valueStr = rest.join(":").trim();
    if (!key || !valueStr) continue;

    // array tipo [a, b, c]
    if (/^\[.*\]$/.test(valueStr)) {
      const arr = valueStr
        .slice(1, -1)
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      metadata[key] = arr;
    } else if (/^\d{4}$/.test(valueStr)) {
      // año simple
      metadata[key] = Number(valueStr);
    } else {
      // quita comillas simples/dobles envolventes si existen
      metadata[key] = valueStr.replace(/^['"]|['"]$/g, "");
    }
  }
  return { body, metadata };
}

export function normalizeLegalMetadata(
  rawMetadata: Record<string, unknown>
): LegalMetadata {
  const parsed = asRecord(rawMetadata);

  const jVal =
    typeof parsed.jurisdiccion === "string"
      ? parsed.jurisdiccion
      : Array.isArray(parsed.jurisdiccion)
      ? String(parsed.jurisdiccion[0] ?? "")
      : undefined;

  const tVal =
    typeof parsed.tipo === "string"
      ? parsed.tipo
      : Array.isArray(parsed.tipo)
      ? String(parsed.tipo[0] ?? "")
      : undefined;

  const jurisdiccion = normalizeJurisdiction(jVal);
  const tipo = normalizeTipo(tVal);
  const anio = normalizeAnio(parsed.anio);
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.map((x) => String(x).trim()).filter(Boolean)
    : undefined;

  return { jurisdiccion, tipo, anio, tags, raw: parsed };
}
