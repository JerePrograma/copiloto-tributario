import { prisma } from "../lib/prisma";
import type { MetricsSnapshot } from "./telemetry";
interface CitationPayload {
  id: string;
  title: string;
  href: string;
  similarity: number;
  snippet?: string;
  jurisdiccion?: string | null;
  hybridScore?: number;
  tipo?: string | null;
  anio?: number | null;
}

export async function recordPromptAudit(params: {
  requestId: string;
  userId?: string;
  passcodeValid: boolean;
  question: string;
  response: string;
  citations: CitationPayload[];
  metrics?: MetricsSnapshot;
  jurisdiction?: string;
}) {
  await prisma.promptAudit.create({
    data: {
      requestId: params.requestId,
      userId: params.userId,
      passcodeValid: params.passcodeValid,
      question: params.question,
      response: params.response,
      citations: params.citations,
      metrics: params.metrics,
      jurisdiction: params.jurisdiction ?? null,
    },
  });
}

export async function recordSearchAudit(params: {
  userId?: string;
  passcodeValid: boolean;
  query: string;
  filters?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
}) {
  await prisma.searchAudit.create({
    data: {
      userId: params.userId,
      passcodeValid: params.passcodeValid,
      query: params.query,
      filters: params.filters,
      metrics: params.metrics,
    },
  });
}
