-- CreateTable
CREATE TABLE "AgentSession" (
    "id" TEXT NOT NULL,
    "history" JSONB NOT NULL DEFAULT '[]',
    "authenticatedUserId" TEXT,
    "authenticatedUserEmail" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentSession_createdAt_idx" ON "AgentSession"("createdAt");
CREATE INDEX "AgentSession_authenticatedUserId_idx" ON "AgentSession"("authenticatedUserId");
