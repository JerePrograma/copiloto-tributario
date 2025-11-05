-- Extensión pgvector (no falla si ya existe)
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
END $$;

-- Tipo vector(768) en DocChunk.embedding
DO $$
BEGIN
  ALTER TABLE "DocChunk"
    ALTER COLUMN "embedding" TYPE vector(768) USING "embedding";
EXCEPTION WHEN undefined_column THEN
  -- si no existe la columna, no hacer nada
  NULL;
WHEN others THEN
  -- si ya es vector(768) u otro caso, continuar
  NULL;
END $$;

-- Limpiar índices previos si existieran (nombres posibles)
DROP INDEX IF EXISTS "DocChunk_embedding_idx";
DROP INDEX IF EXISTS "DocChunk_embedding_hnsw_idx";
DROP INDEX IF EXISTS "DocChunk_embedding_ivfflat_idx";

-- Crear índice ANN recomendado (elegí UNO; dejo IVFFLAT por defecto)
CREATE INDEX IF NOT EXISTS "DocChunk_embedding_ivfflat_idx"
  ON "DocChunk" USING ivfflat ("embedding" vector_l2_ops) WITH (lists = 100);
-- Alternativa:
-- CREATE INDEX IF NOT EXISTS "DocChunk_embedding_hnsw_idx"
--   ON "DocChunk" USING hnsw ("embedding" vector_l2_ops);
