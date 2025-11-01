// server/src/nlp/intent.ts
import { LEX, norm } from "./lexicon";

export type Intent =
  | "adhesion_rs"
  | "exenciones"
  | "base_aliquota"
  | "explicar_boleta"
  | "generic";

export function detectJurisdiccion(t: string): string[] | undefined {
  const s = norm(t);
  const out = new Set<string>();
  if (/caba|gcba|ciudad de buenos aires/.test(s)) out.add("AR-CABA");
  if (/provincia de buenos aires|pba|arba|buenos aires/.test(s))
    out.add("AR-BA");
  if (/cordoba|cba|rentas cordoba/.test(s)) out.add("AR-CBA");
  if (/nacion|nacional|argentina/.test(s)) out.add("AR-NACION");
  return out.size ? [...out] : undefined;
}

export function detectIntent(t: string): Intent {
  const s = norm(t);
  if (
    LEX.adhesion.some((w) => s.includes(w)) &&
    LEX.iibb.some((w) => s.includes(w))
  )
    return "adhesion_rs";
  if (LEX.exencion.some((w) => s.includes(w)) && /automotor|patente/.test(s))
    return "exenciones";
  if (LEX.baseAliq.some((w) => s.includes(w))) return "base_aliquota";
  if (/boleta|vencim|detalle|concepto/.test(s)) return "explicar_boleta";
  return "generic";
}

export function buildAnchorGroups(
  intent: Intent,
  t: string,
  jur?: string[]
): string[][] {
  const s = norm(t);
  const groups: string[][] = [];
  if (intent === "adhesion_rs") {
    groups.push(LEX.adhesion, LEX.iibb);
  }
  if (intent === "exenciones") {
    groups.push(LEX.exencion, LEX.automotor);
    if (LEX.pyme.some((w) => s.includes(w))) groups.push(LEX.pyme);
  }
  if (intent === "base_aliquota") {
    groups.push(LEX.baseAliq);
  }
  // opcional: sumar automotor/iibb si aparecen
  if (LEX.automotor.some((w) => s.includes(w))) groups.push(LEX.automotor);
  if (LEX.iibb.some((w) => s.includes(w))) groups.push(LEX.iibb);
  if (LEX.adhesion.some((w) => s.includes(w))) groups.push(LEX.adhesion);
  if (LEX.pyme.some((w) => s.includes(w))) groups.push(LEX.pyme);
  // NO metas hardcode de PBA acá; usalo en el filtro pathLike del search.
  return groups;
}
