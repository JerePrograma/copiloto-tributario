import type { AgentSession as AgentSessionModel } from "@prisma/client";
import { prisma } from "./prisma";

export type AgentMessageRole = "system" | "user" | "assistant";

export interface AgentMessage {
  role: AgentMessageRole;
  content: string;
}

export interface AgentSession {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  history: AgentMessage[];
  authenticatedUser?: { id: string; email?: string | null } | null;
}

const HISTORY_LIMIT = 120;

function normalizeHistory(raw: unknown): AgentMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentMessage[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const role = (entry as { role?: unknown }).role;
    const content = (entry as { content?: unknown }).content;
    if (
      (role === "system" || role === "user" || role === "assistant") &&
      typeof content === "string" &&
      content.trim().length > 0
    ) {
      out.push({ role, content });
    }
  }
  return out;
}

function clampHistory(history: AgentMessage[], max = HISTORY_LIMIT): AgentMessage[] {
  return history.length > max ? history.slice(history.length - max) : history;
}

function mapRecord(record: AgentSessionModel): AgentSession {
  return {
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    history: normalizeHistory(record.history),
    authenticatedUser: record.authenticatedUserId
      ? {
          id: record.authenticatedUserId,
          email: record.authenticatedUserEmail,
        }
      : null,
  };
}

export async function getOrCreateAgentSession(
  requestedId?: string | null
): Promise<{ session: AgentSession; created: boolean }> {
  if (requestedId && requestedId.trim().length > 0) {
    const existing = await prisma.agentSession.findUnique({
      where: { id: requestedId.trim() },
    });
    if (existing) {
      return { session: mapRecord(existing), created: false };
    }
    const created = await prisma.agentSession.create({
      data: { id: requestedId.trim() },
    });
    return { session: mapRecord(created), created: true };
  }

  const created = await prisma.agentSession.create({ data: {} });
  return { session: mapRecord(created), created: true };
}

export async function saveAgentSession(session: AgentSession): Promise<void> {
  const history = clampHistory(normalizeHistory(session.history));
  const authenticatedUser = session.authenticatedUser ?? null;
  await prisma.agentSession.update({
    where: { id: session.id },
    data: {
      history,
      authenticatedUserId: authenticatedUser?.id ?? null,
      authenticatedUserEmail: authenticatedUser?.email ?? null,
    },
  });
  session.history = history;
  session.updatedAt = new Date();
}
