export interface ToolTimelineEvent {
  id: string;
  name: string;
  status: "start" | "success" | "error";
  detail?: string;
  durationMs?: number;
}

export interface MetricsSnapshot {
  ttfbMs?: number;
  llmMs?: number;
  sqlMs?: number;
  embeddingMs?: number;
  k?: number;
  similarityAvg?: number;
  similarityMin?: number;
}

interface TelemetryState {
  startedAt: number;
  firstTokenAt?: number;
  llmFinishedAt?: number;
  searchMetrics?: {
    sqlMs: number;
    embeddingMs: number;
    k: number;
    similarityAvg: number;
    similarityMin: number;
  };
  toolEvents: ToolTimelineEvent[];
}

export interface Telemetry {
  markFirstToken: () => void;
  markLLMFinished: () => void;
  setSearchMetrics: (metrics: {
    sqlMs: number;
    embeddingMs: number;
    k: number;
    similarityAvg: number;
    similarityMin: number;
  }) => void;
  addToolEvent: (event: ToolTimelineEvent) => void;
  snapshot: () => MetricsSnapshot;
  timeline: () => ToolTimelineEvent[];
}

export function createTelemetry(): Telemetry {
  const state: TelemetryState = {
    startedAt: Date.now(),
    toolEvents: [],
  };

  return {
    markFirstToken() {
      state.firstTokenAt = state.firstTokenAt ?? Date.now();
    },
    markLLMFinished() {
      state.llmFinishedAt = Date.now();
    },
    setSearchMetrics(metrics) {
      state.searchMetrics = metrics;
    },
    addToolEvent(event) {
      state.toolEvents.push({ ...event });
    },
    snapshot() {
      const snapshot: MetricsSnapshot = {};
      if (state.firstTokenAt) {
        snapshot.ttfbMs = Math.round(state.firstTokenAt - state.startedAt);
      }
      if (state.llmFinishedAt) {
        snapshot.llmMs = Math.round(
          state.llmFinishedAt - (state.firstTokenAt ?? state.startedAt)
        );
      }
      if (state.searchMetrics) {
        snapshot.sqlMs = Math.round(state.searchMetrics.sqlMs);
        snapshot.embeddingMs = Math.round(state.searchMetrics.embeddingMs);
        snapshot.k = state.searchMetrics.k;
        snapshot.similarityAvg = state.searchMetrics.similarityAvg;
        snapshot.similarityMin = state.searchMetrics.similarityMin;
      }
      return snapshot;
    },
    timeline() {
      return [...state.toolEvents];
    },
  };
}
