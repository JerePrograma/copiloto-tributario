CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS vector;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FollowUpStatus') THEN
    CREATE TYPE "FollowUpStatus" AS ENUM ('PENDING','DONE','CANCELED');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LeadStatus') THEN
    CREATE TYPE "LeadStatus" AS ENUM ('NEW','CONTACTED','QUALIFIED','WON','LOST','ARCHIVED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "InvitedUser" (
  "id"         TEXT PRIMARY KEY,
  "name"       CITEXT,
  "email"      CITEXT,
  "passcode"   VARCHAR(32) NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "Session" (
  "id"         TEXT PRIMARY KEY,
  "userId"     TEXT NOT NULL,
  "token"      TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  "expiresAt"  TIMESTAMP(3) NOT NULL
);

CREATE TABLE IF NOT EXISTS "Lead" (
  "id"         TEXT PRIMARY KEY,
  "userId"     TEXT,
  "name"       TEXT NOT NULL,
  "company"    TEXT,
  "email"      CITEXT,
  "phone"      TEXT,
  "status"     "LeadStatus" NOT NULL DEFAULT 'NEW',
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL
);

CREATE TABLE IF NOT EXISTS "Note" (
  "id"         TEXT PRIMARY KEY,
  "leadId"     TEXT,
  "userId"     TEXT,
  "content"    TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "FollowUp" (
  "id"          TEXT PRIMARY KEY,
  "leadId"      TEXT NOT NULL,
  "dueAt"       TIMESTAMP(3) NOT NULL,
  "status"      "FollowUpStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS "Doc" (
  "id"           TEXT PRIMARY KEY,
  "path"         TEXT NOT NULL,
  "title"        TEXT NOT NULL,
  "slug"         VARCHAR(120),
  "jurisdiccion" VARCHAR(20),
  "organismo"    TEXT,
  "tipo"         TEXT,
  "anio"         INTEGER,
  "publicacion"  TEXT,
  "fuenteUrl"    TEXT,
  "metadata"     JSONB,
  "version"      INTEGER NOT NULL DEFAULT 1,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL
);

CREATE TABLE IF NOT EXISTS "DocChunk" (
  "id"         TEXT PRIMARY KEY,
  "docId"      TEXT NOT NULL,
  "idx"        INTEGER NOT NULL,
  "content"    TEXT NOT NULL,
  "tokenCount" INTEGER NOT NULL,
  "startChar"  INTEGER NOT NULL,
  "endChar"    INTEGER NOT NULL,
  "href"       TEXT,
  "embedding"  vector
);

CREATE TABLE IF NOT EXISTS "PromptAudit" (
  "id"            TEXT PRIMARY KEY,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "requestId"     TEXT NOT NULL,
  "userId"        TEXT,
  "passcodeValid" BOOLEAN NOT NULL DEFAULT FALSE,
  "question"      TEXT NOT NULL,
  "response"      TEXT NOT NULL,
  "citations"     JSONB NOT NULL,
  "metrics"       JSONB,
  "jurisdiction"  TEXT
);

CREATE TABLE IF NOT EXISTS "SearchAudit" (
  "id"            TEXT PRIMARY KEY,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "userId"        TEXT,
  "passcodeValid" BOOLEAN NOT NULL DEFAULT FALSE,
  "query"         TEXT NOT NULL,
  "filters"       JSONB,
  "metrics"       JSONB
);

ALTER TABLE "InvitedUser" ADD COLUMN IF NOT EXISTS "name" CITEXT;
ALTER TABLE "InvitedUser" ADD COLUMN IF NOT EXISTS "email" CITEXT;
ALTER TABLE "InvitedUser" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "InvitedUser" ALTER COLUMN "email" TYPE CITEXT USING "email"::citext;
ALTER TABLE "InvitedUser" ALTER COLUMN "email" DROP NOT NULL;

UPDATE "InvitedUser"
SET "name" = COALESCE(NULLIF(split_part("email",'@',1), ''), 'user_' || substr("id",1,8))
WHERE "name" IS NULL;

ALTER TABLE "InvitedUser" ALTER COLUMN "name" SET NOT NULL;

ALTER TABLE "Lead" ALTER COLUMN "email" TYPE CITEXT USING "email"::citext;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='Lead' AND column_name='status' AND udt_name IN ('text','varchar')
  ) THEN
    UPDATE "Lead" SET "status" = COALESCE(UPPER("status"), 'NEW');
    UPDATE "Lead" SET "status"='NEW'
    WHERE "status" NOT IN ('NEW','CONTACTED','QUALIFIED','WON','LOST','ARCHIVED');
    ALTER TABLE "Lead"
      ALTER COLUMN "status" TYPE "LeadStatus"
      USING ("status"::"LeadStatus");
  END IF;
END $$;

ALTER TABLE "Lead" ALTER COLUMN "status" SET DEFAULT 'NEW';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='DocChunk' AND column_name='embedding'
  ) THEN
    ALTER TABLE "DocChunk"
      ALTER COLUMN "embedding" TYPE vector(768) USING "embedding";
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='Session_userId_fkey') THEN
    ALTER TABLE "Session"
      ADD CONSTRAINT "Session_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "InvitedUser"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='Lead_userId_fkey') THEN
    ALTER TABLE "Lead"
      ADD CONSTRAINT "Lead_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "InvitedUser"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='Note_leadId_fkey') THEN
    ALTER TABLE "Note"
      ADD CONSTRAINT "Note_leadId_fkey"
      FOREIGN KEY ("leadId") REFERENCES "Lead"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='Note_userId_fkey') THEN
    ALTER TABLE "Note"
      ADD CONSTRAINT "Note_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "InvitedUser"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='FollowUp_leadId_fkey') THEN
    ALTER TABLE "FollowUp"
      ADD CONSTRAINT "FollowUp_leadId_fkey"
      FOREIGN KEY ("leadId") REFERENCES "Lead"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='DocChunk_docId_fkey') THEN
    ALTER TABLE "DocChunk"
      ADD CONSTRAINT "DocChunk_docId_fkey"
      FOREIGN KEY ("docId") REFERENCES "Doc"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "InvitedUser_name_key" ON "InvitedUser"("name");
CREATE UNIQUE INDEX IF NOT EXISTS "InvitedUser_email_key" ON "InvitedUser"("email");
CREATE INDEX IF NOT EXISTS "InvitedUser_createdAt_idx" ON "InvitedUser"("createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "Session_token_key" ON "Session"("token");

CREATE INDEX IF NOT EXISTS "FollowUp_leadId_dueAt_idx" ON "FollowUp"("leadId","dueAt");
CREATE INDEX IF NOT EXISTS "FollowUp_status_dueAt_idx" ON "FollowUp"("status","dueAt");

CREATE INDEX IF NOT EXISTS "Doc_jurisdiccion_tipo_anio_idx" ON "Doc"("jurisdiccion","tipo","anio");
CREATE UNIQUE INDEX IF NOT EXISTS "Doc_path_version_key" ON "Doc"("path","version");

DROP INDEX IF EXISTS "DocChunk_docId_idx_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "DocChunk_docId_idx_key" ON "DocChunk"("docId","idx");

CREATE INDEX IF NOT EXISTS "PromptAudit_createdAt_idx" ON "PromptAudit"("createdAt");
CREATE INDEX IF NOT EXISTS "PromptAudit_requestId_idx" ON "PromptAudit"("requestId");
CREATE INDEX IF NOT EXISTS "SearchAudit_createdAt_idx" ON "SearchAudit"("createdAt");
CREATE INDEX IF NOT EXISTS "SearchAudit_userId_idx" ON "SearchAudit"("userId");

DROP INDEX IF EXISTS "DocChunk_embedding_ivfflat_idx";
DROP INDEX IF EXISTS "DocChunk_embedding_hnsw_idx";
CREATE INDEX IF NOT EXISTS "DocChunk_embedding_ivfflat_idx"
  ON "DocChunk" USING ivfflat ("embedding" vector_l2_ops) WITH (lists = 100);
