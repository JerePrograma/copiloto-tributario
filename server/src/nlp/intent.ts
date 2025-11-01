// server/src/nlp/intent.ts
import { LEX, norm } from "./lexicon";

export type Intent =
  | "adhesion_rs"
  | "exenciones"
  | "base_aliquota"
  | "explicar_boleta"
  | "generic";

export function norm(s: string) {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export const LEX = {
  adhesion: [
    "adhesion",
    "adhesión",
    "inscripcion",
    "inscripción",
    "alta",
    "empadronamiento",
    "tramite",
    "trámite",
    "adherir",
    "adhiero",
    "adherimos",
    "anotarme",
    "registrarme",
  ],
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
    "patente",
    "impuesto a los automotores",
  ],
  iibb: [
    "ingresos brutos",
    "iibb",
    "régimen simplificado",
    "regimen simplificado",
    "rs",
  ],
  base: [
    "base imponible",
    "base de cálculo",
    "valuación fiscal",
    "valuacion fiscal",
    "valúo",
    "valuo",
    "valor imponible",
    "determinación",
    "determinacion",
  ],
  alicuota: ["alícuota", "alicuota", "tasa", "porcentaje"],
  pba: ["provincia de buenos aires", "pba", "arba", "buenos aires"],
  pyme: [
    "pyme",
    "pymes",
    "mipyme",
    "micro",
    "pequena",
    "pequeña",
    "mediana",
    "sme",
  ],
};

const BASE_ALIQ = [...LEX.base, ...LEX.alicuota];

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
  const adhesionMatched =
    LEX.adhesion.some((w) => s.includes(w)) || /adhier|adher/.test(s);
  const iibbMatched = LEX.iibb.some((w) => s.includes(w));
  if (
    adhesionMatched &&
    iibbMatched
  )
    return "adhesion_rs";
  if (LEX.exencion.some((w) => s.includes(w)) && /automotor|patente/.test(s))
    return "exenciones";
  if (BASE_ALIQ.some((w) => s.includes(w))) return "base_aliquota";
  if (/boleta|vencim|detalle|concepto/.test(s)) return "explicar_boleta";
  return "generic";
}

export function buildAnchorGroups(
  intent: Intent,
  t: string,
  jur?: string[]
): { groups: string[][]; minHits: number } {
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
    groups.push(BASE_ALIQ);
  }
  // opcional: sumar automotor/iibb si aparecen
  if (LEX.automotor.some((w) => s.includes(w))) groups.push(LEX.automotor);
  if (LEX.iibb.some((w) => s.includes(w))) groups.push(LEX.iibb);
  if (LEX.adhesion.some((w) => s.includes(w))) groups.push(LEX.adhesion);
  if (LEX.pyme.some((w) => s.includes(w))) groups.push(LEX.pyme);
  // NO metas hardcode de PBA acá; usalo en el filtro pathLike del search.
  const uniqueGroups = groups.length;
  let minHits = uniqueGroups === 0 ? 0 : uniqueGroups === 1 ? 1 : 2;
  if (intent === "exenciones" || intent === "base_aliquota") {
    const bonus = uniqueGroups > 2 ? 1 : 0;
    minHits = Math.min(minHits + bonus, Math.max(uniqueGroups, 1));
  }
  if (intent === "adhesion_rs") {
    minHits = Math.min(2, Math.max(uniqueGroups, 1));
  }
  return { groups, minHits };
}
