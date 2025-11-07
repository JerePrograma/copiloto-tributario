// src/system/validation.ts  (checklists canónicas por intent)
export type Intent =
  | "adhesion_rs"
  | "exenciones"
  | "base_alicuota"
  | "generico"
  | "alta_rg"
  | "recategorizacion_rs"
  | "alicuotas";

export function getValidationChecklist(intent: Intent, jur?: string): string[] {
  switch (intent) {
    case "alta_rg":
      return [
        "CUIT y fecha de inicio de actividad",
        "Jurisdicción exacta (AR-BA / AR-CABA / AR-CBA)",
        "Código/s de actividad (NAIIBB/NAES) y domicilio",
        "DFE habilitado",
        "¿Convenio Multilateral? Si sí: coeficientes y altas en SIFERE/SIRCAR",
      ];
    case "adhesion_rs":
      return [
        "CUIT y jurisdicción (AR-BA / AR-CABA / AR-CBA)",
        "Actividad y parámetros que encuadran en RS/MU",
        "Tope anual y categoría vigente (no provisto → confirmación)",
        "DFE habilitado y canal (AFIP/portal provincial)",
      ];
    case "recategorizacion_rs":
      return [
        "Ingresos últimos 12 meses y fecha de corte",
        "Parámetros físicos/consumos si aplican (m2, energía, etc.)",
        "Categoría actual y propuesta",
      ];
    case "alicuotas":
    case "base_alicuota":
      return [
        "Jurisdicción y año fiscal",
        "Código de actividad",
        "Régimen (RG/RS/CM) y posibles beneficios/exenciones",
      ];
    case "exenciones":
      return [
        "Norma invocada / tipo de beneficio",
        "Actividad alcanzada y documentación (p.ej., Certificado MiPyME)",
        "Vigencia/periodo aplicable",
      ];
    default:
      return [
        "Jurisdicción concreta",
        "Tributo/proceso exacto",
        "Identificadores mínimos (CUIT, actividad, periodo)",
      ];
  }
}
