import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  OLLAMA_BASE_URL: z.string().url(),
  EMBEDDING_MODEL: z.string().min(2),
  EMBEDDING_DIM: z.coerce.number().int().positive(),
  OPENROUTER_API_KEY: z
    .string()
    .min(10)
    .transform((s) => s.trim()),
  OPENROUTER_MODEL: z.string().min(3),
  OPENROUTER_FALLBACK_MODELS: z.string().optional(),
  DOCS_ROOT: z.string().min(1),
  MAX_TOOL_ITERATIONS: z.coerce.number().int().min(1).max(8).default(4),
  PORT: z.coerce.number().int().positive().optional(),
  FRONTEND_ORIGIN: z.string().url().optional(),
});

export type Env = z.infer<typeof envSchema>;
export const env: Env = envSchema.parse(process.env);
