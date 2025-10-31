import { z } from "zod";

export interface LegalMetadata {
  jurisdiccion?: string;
  tipo?: string;
  anio?: number;
  tags?: string[];
  raw?: Record<string, unknown>;
}

const frontMatterSchema = z.record(z.any());

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

export function extractFrontMatter(raw: string): { body: string; metadata: Record<string, unknown> } {
  if (!raw.startsWith("---")) {
    return { body: raw, metadata: {} };
  }
  const end = raw.indexOf("\n---", 3);
  if (end === -1) {
    return { body: raw, metadata: {} };
  }
  const header = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\s+/, "");
  const metadata: Record<string, unknown> = {};
  for (const line of header.split(/\r?\n/)) {
    const [key, ...rest] = line.split(":");
    if (!key || rest.length === 0) continue;
    const value = rest.join(":").trim();
    if (!value) continue;
    if (/^\[.*\]$/.test(value)) {
      metadata[key.trim()] = value
        .slice(1, -1)
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
    } else {
      metadata[key.trim()] = value;
    }
  }
  return { body, metadata };
}

export function normalizeLegalMetadata(rawMetadata: Record<string, unknown>): LegalMetadata {
  const parsed = frontMatterSchema.parse(rawMetadata);
  const jurisdiccion = normalizeJurisdiction(
    typeof parsed.jurisdiccion === "string"
      ? parsed.jurisdiccion
      : Array.isArray(parsed.jurisdiccion)
      ? parsed.jurisdiccion[0]
      : undefined
  );
  const tipo = normalizeTipo(
    typeof parsed.tipo === "string"
      ? parsed.tipo
      : Array.isArray(parsed.tipo)
      ? parsed.tipo[0]
      : undefined
  );
  const anio = normalizeAnio(parsed.anio);
  const tags: string[] | undefined = Array.isArray(parsed.tags)
    ? parsed.tags.map((tag) => String(tag).trim()).filter((tag) => tag.length > 0)
    : undefined;
  return {
    jurisdiccion,
    tipo,
    anio,
    tags,
    raw: parsed,
  };
}
