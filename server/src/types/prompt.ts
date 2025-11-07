// src/types/prompt.ts  (extender opciones)
export type BuildSystemPromptOpts = {
  passcodeVerified: boolean;
  proceduralMode?: boolean;
  jurisdictionHint?: string;
  primaryDocTitle?: string;
  intent?: "adhesion_rs" | "exenciones" | "base_alicuota" | "generico" | "alta_rg" | "recategorizacion_rs" | "alicuotas";
  relaxed?: boolean;
  vectorFallback?: boolean;
  validationFirst?: boolean;
  validationChecklist?: string[]; // texto plano, 1 línea por ítem
  validationLead?: boolean; // opcional
};
