// server/src/nlp/lexicon.ts

export function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function norm(s: string): string {
  return stripAccents(s).toLowerCase();
}

export const LEX = {
  adhesion: [
    "adhesion",
    "adhesión",
    "adhiero",
    "inscripcion",
    "inscripción",
    "alta",
    "empadronamiento",
    "tramite",
    "trámite",
    "adherir",
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
    "vehiculo/s",
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
    "base de calculo",
    "valuación fiscal",
    "valuacion fiscal",
    "valúo",
    "valuo",
    "valor imponible",
    "determinación",
    "determinacion",
  ],
  alicuota: ["alícuota", "alicuota", "tasa", "porcentaje"],
  baseAliq: [] as string[],
  iva: ["iva", "impuesto al valor agregado"],
  ganancias: ["ganancias", "impuesto a las ganancias"],
  monotributo: ["monotributo", "régimen simplificado nacional"],
  boleta: ["boleta", "liquidación", "liquidacion", "comprobante"],
  pba: ["provincia de buenos aires", "pba", "arba", "buenos aires"],
  caba: ["caba", "ciudad de buenos aires", "gcba"],
  cba: ["cordoba", "córdoba", "dgr cordoba", "rentas cordoba"],
  nacion: ["nacion", "nacional", "argentina"],
  pyme: [
    "pyme",
    "PyME",
    "pymes",
    "mipyme",
    "mi pyme",
    "micro",
    "pequena",
    "pequeña",
    "mediana",
    "sme",
  ],
};

LEX.baseAliq = [...LEX.base, ...LEX.alicuota];
