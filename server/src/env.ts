import { z } from "zod";
export const env = z.object({
  DATABASE_URL: z.string().url(),
  OLLAMA_BASE_URL: z.string().url(),
  EMBEDDING_MODEL: z.string(),
  EMBEDDING_DIM: z.coerce.number(),
  OPENROUTER_API_KEY: z.string().min(10),
  OPENROUTER_MODEL: z.string(),
  DOCS_ROOT: z.string(),
  MAX_TOOL_ITERATIONS: z.coerce.number().default(4)
}).parse(process.env);
