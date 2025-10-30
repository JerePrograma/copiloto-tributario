-- Extensiones
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Enum Prisma
DO $$
BEGIN
  CREATE TYPE "FollowUpStatus" AS ENUM ('PENDING','DONE','CANCELED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Tablas (idénticas a tu schema.prisma)
CREATE TABLE "InvitedUser" (
  "id" TEXT PRIMARY KEY,
  "email" TEXT NOT NULL UNIQUE,
  "passcode" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "Session" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "Lead" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT,
  "name" TEXT NOT NULL,
  "company" TEXT,
  "email" TEXT,
  "phone" TEXT,
  "status" TEXT NOT NULL DEFAULT 'new',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "Note" (
  "id" TEXT PRIMARY KEY,
  "leadId" TEXT,
  "userId" TEXT,
  "content" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "FollowUp" (
  "id" TEXT PRIMARY KEY,
  "leadId" TEXT NOT NULL,
  "dueAt" TIMESTAMP(3) NOT NULL,
  "status" "FollowUpStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3)
);

CREATE TABLE "Doc" (
  "id" TEXT PRIMARY KEY,
  "path" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "DocChunk" (
  "id" TEXT PRIMARY KEY,
  "docId" TEXT NOT NULL,
  "idx" INTEGER NOT NULL,
  "content" TEXT NOT NULL,
  "tokenCount" INTEGER NOT NULL,
  "startChar" INTEGER NOT NULL,
  "endChar" INTEGER NOT NULL,
  "href" TEXT,
  "embedding" vector(768)  -- dimensión fija
);

-- FKs
ALTER TABLE "Session"
  ADD CONSTRAINT "Session_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "InvitedUser"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Lead"
  ADD CONSTRAINT "Lead_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "InvitedUser"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Note"
  ADD CONSTRAINT "Note_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "Lead"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Note"
  ADD CONSTRAINT "Note_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "InvitedUser"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "FollowUp"
  ADD CONSTRAINT "FollowUp_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "Lead"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DocChunk"
  ADD CONSTRAINT "DocChunk_docId_fkey"
  FOREIGN KEY ("docId") REFERENCES "Doc"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Índices
CREATE INDEX "FollowUp_leadId_dueAt_idx" ON "FollowUp"("leadId","dueAt");
CREATE UNIQUE INDEX "Doc_path_version_key" ON "Doc"("path","version");
CREATE INDEX "DocChunk_docId_idx_idx" ON "DocChunk"("docId","idx");

-- ANN recomendado por defecto: IVFFLAT
CREATE INDEX IF NOT EXISTS "DocChunk_embedding_ivfflat"
  ON "DocChunk" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);

-- (Opcional) HNSW si tu imagen pgvector lo soporta
-- CREATE INDEX IF NOT EXISTS "DocChunk_embedding_hnsw"
--   ON "DocChunk" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- ANALYZE recomendado tras cargar embeddings
-- ANALYZE "DocChunk";
