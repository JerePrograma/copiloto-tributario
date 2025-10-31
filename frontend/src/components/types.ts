export interface MetricsSnapshot {
  ttfbMs?: number;
  llmMs?: number;
  sqlMs?: number;
  embeddingMs?: number;
  ftsMs?: number;
  k?: number;
  similarityAvg?: number;
  similarityMin?: number;
  hybridAvg?: number;
  hybridMin?: number;
  reranked?: boolean;
  restrictedCount?: number;
  modelId?: string;
  llmAttempts?: number;
}

export type TimelineStatus = "pending" | "ok" | "error";

export interface TimelineEvent {
  id: string;
  label: string;
  status: TimelineStatus;
  detail?: string;
  durationMs?: number;
  startedAt?: number;
}

export interface Citation {
  id: string;
  title: string;
  href: string;
  similarity: number;
  snippet: string;
  hybridScore?: number;
  jurisdiccion?: string;
  tipo?: string;
  anio?: number;
}

export interface ClaimCheckEntry {
  sentence: string;
  status: "supported" | "no_evidence";
  citations: string[];
}
