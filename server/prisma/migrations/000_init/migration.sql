-- Enable pgvector for semantic search
CREATE EXTENSION IF NOT EXISTS vector;

-- Domain tables
CREATE TYPE "FollowUpStatus" AS ENUM ('PENDING', 'DONE', 'CANCELED');

CREATE TABLE "InvitedUser" (
  "id" TEXT PRIMARY KEY,
  "email" TEXT NOT NULL UNIQUE,
  "passcode" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE "Session" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "expiresAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "InvitedUser"("id") ON DELETE CASCADE
);

CREATE TABLE "Lead" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT,
  "name" TEXT NOT NULL,
  "company" TEXT,
  "email" TEXT,
  "phone" TEXT,
  "status" TEXT NOT NULL DEFAULT 'new',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "Lead_userId_fkey" FOREIGN KEY ("userId") REFERENCES "InvitedUser"("id") ON DELETE SET NULL
);

CREATE TABLE "Note" (
  "id" TEXT PRIMARY KEY,
  "leadId" TEXT,
  "userId" TEXT,
  "content" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "Note_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL,
  CONSTRAINT "Note_userId_fkey" FOREIGN KEY ("userId") REFERENCES "InvitedUser"("id") ON DELETE SET NULL
);

CREATE TABLE "FollowUp" (
  "id" TEXT PRIMARY KEY,
  "leadId" TEXT NOT NULL,
  "dueAt" TIMESTAMPTZ NOT NULL,
  "status" "FollowUpStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "completedAt" TIMESTAMPTZ,
  CONSTRAINT "FollowUp_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE
);

CREATE INDEX "FollowUp_leadId_dueAt_idx" ON "FollowUp" ("leadId", "dueAt");

CREATE TABLE "Doc" (
  "id" TEXT PRIMARY KEY,
  "path" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX "Doc_path_version_key" ON "Doc" ("path", "version");

CREATE TABLE "DocChunk" (
  "id" TEXT PRIMARY KEY,
  "docId" TEXT NOT NULL,
  "idx" INTEGER NOT NULL,
  "content" TEXT NOT NULL,
  "tokenCount" INTEGER NOT NULL,
  "startChar" INTEGER NOT NULL,
  "endChar" INTEGER NOT NULL,
  "href" TEXT,
  "embedding" vector(768),
  CONSTRAINT "DocChunk_docId_fkey" FOREIGN KEY ("docId") REFERENCES "Doc"("id") ON DELETE CASCADE
);

CREATE INDEX "DocChunk_docId_idx" ON "DocChunk" ("docId", "idx");
CREATE INDEX "DocChunk_embedding_idx" ON "DocChunk" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);
