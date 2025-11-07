// server/src/nlp/intent.ts
import { LEX, norm } from "./lexicon";

// ===== Tipos =====
export type Intent =
  | "adhesion_rs"
  | "exenciones"
  | "base_alicuota"          // nombre unificado
  | "explicar_boleta"
  | "alta_rg"                // opcional: “alta IIBB RG”
  | "recategorizacion_rs"    // opcional
  | "alicuotas"              // alias “tablas de alícuotas”
  | "generico";

// Grupo de anclas
export type AnchorGroups = string[][];

// ===== Jurisdicción =====
export function detectJurisdiccion(t: string): string[] | undefined {
  const s = norm(t);
  const out = new Set<string>();
  if (/caba|gcba|ciudad de buenos aires|agip/.test(s)) out.add("AR-CABA");
  if (/provincia de buenos aires|pba|arba|buenos aires/.test(s)) out.add("AR-BA");
  if (/(c[óo]rdoba|cordoba|cba|rentas cordoba)/.test(s)) out.add("AR-CBA");
  if (/(naci[óo]n|nacional|argentina)/.test(s)) out.add("AR-NACION");
  return out.size ? [...out] : undefined;
}

// ===== Intent principal =====
export function detectIntent(text: string): Intent {
  const s = norm(text);

  const hasAdhesion =
    LEX.adhesion.some((w) => s.includes(norm(w))) || /adhier|adher/.test(s);
  const hasIIBB = LEX.iibb.some((w) => s.includes(norm(w)));
  const asksBaseAli = [...LEX.base, ...LEX.alicuota].some((w) => s.includes(norm(w)));

  const mentionsAltaRG =
    /alta/.test(s) && (/(iibb|ingresos brutos|r[ée]gimen general|rg)/.test(s) || hasIIBB);

  const mentionsRecateg =
    /(recategorizaci[óo]n|recategorizar|cambio de categor)/.test(s) &&
    /rs|simplificado|monotributo/.test(s);

  const mentionsBoleta = /boleta|vencim|detalle|concepto/.test(s);

  if (hasAdhesion && hasIIBB) return "adhesion_rs";
  if (mentionsAltaRG) return "alta_rg";
  if (mentionsRecateg) return "recategorizacion_rs";
  if (asksBaseAli) return "base_alicuota";
  if (LEX.exencion.some((w) => s.includes(norm(w))) && /automotor|patente/.test(s))
    return "exenciones";
  if (mentionsBoleta) return "explicar_boleta";
  return "generico";
}

// Normalizador defensivo para equivalencias heredadas
export function canonicalizeIntent(i: string): Intent {
  const s = i.toLowerCase();
  if (s === "base_aliquota") return "base_alicuota"; // typo/portu
  if (s === "generic") return "generico";            // inglés
  if (
    s === "adhesion_rs" || s === "exenciones" || s === "explicar_boleta" ||
    s === "generico" || s === "base_alicuota" || s === "alta_rg" ||
    s === "recategorizacion_rs" || s === "alicuotas"
  ) return s as Intent;
  return "generico";
}

// ===== Anchors por intent + señales del texto =====
export function buildAnchorGroups(
  intent: Intent,
  text: string
): { groups: AnchorGroups; minHits: number } {
  const s = norm(text);
  const groups: AnchorGroups = [];

  // Núcleo por intent
  switch (intent) {
    case "adhesion_rs":
      groups.push(LEX.adhesion, LEX.iibb);
      break;
    case "alta_rg":
      groups.push(LEX.iibb);
      break;
    case "recategorizacion_rs":
      groups.push(LEX.iibb);
      break;
    case "base_alicuota":
    case "alicuotas":
      groups.push([...LEX.base, ...LEX.alicuota]);
      break;
    case "exenciones":
      groups.push(LEX.exencion, LEX.automotor);
      break;
    default:
      // generico: sin núcleo obligatorio
      break;
  }

  // Tópicos explícitos del texto
  if (LEX.automotor.some((w) => s.includes(norm(w)))) groups.push(LEX.automotor);
  if (LEX.iibb.some((w) => s.includes(norm(w)))) groups.push(LEX.iibb);
  if (LEX.adhesion.some((w) => s.includes(norm(w)))) groups.push(LEX.adhesion);
  if (LEX.pyme.some((w) => s.includes(norm(w)))) groups.push(LEX.pyme);

  // minHits: 1 si hay 1 grupo, 2 si hay ≥2; afinado por intent
  const uniqueGroups = groups.length;
  let minHits = uniqueGroups <= 1 ? 1 : 2;

  if (intent === "base_alicuota" || intent === "exenciones") {
    // consultas más “técnicas” → pedí más co-ocurrencia, pero acotado
    minHits = Math.min(3, Math.max(2, Math.min(uniqueGroups, 3)));
  }
  if (intent === "adhesion_rs") {
    minHits = Math.min(2, Math.max(1, Math.min(uniqueGroups, 2)));
  }

  // Garantía final
  minHits = Math.max(1, Math.min(minHits, Math.max(uniqueGroups, 1)));

  return { groups, minHits };
}
