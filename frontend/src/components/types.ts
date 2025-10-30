export interface MetricsSnapshot {
  ttfbMs?: number;
  llmMs?: number;
  sqlMs?: number;
  embeddingMs?: number;
  k?: number;
  similarityAvg?: number;
  similarityMin?: number;
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
}

export interface ClaimCheckEntry {
  sentence: string;
  status: "supported" | "no_evidence";
  citations: string[];
}
