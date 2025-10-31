ALTER TABLE "Doc"
  ADD COLUMN "jurisdiccion" TEXT,
  ADD COLUMN "tipo" TEXT,
  ADD COLUMN "anio" INTEGER,
  ADD COLUMN "metadata" JSONB,
  ADD COLUMN "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE "PromptAudit" (
  "id" TEXT PRIMARY KEY,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "requestId" TEXT NOT NULL,
  "userId" TEXT,
  "passcodeValid" BOOLEAN NOT NULL DEFAULT FALSE,
  "question" TEXT NOT NULL,
  "response" TEXT NOT NULL,
  "citations" JSONB NOT NULL,
  "metrics" JSONB,
  "jurisdiction" TEXT
);

CREATE TABLE "SearchAudit" (
  "id" TEXT PRIMARY KEY,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "userId" TEXT,
  "passcodeValid" BOOLEAN NOT NULL DEFAULT FALSE,
  "query" TEXT NOT NULL,
  "filters" JSONB,
  "metrics" JSONB
);
