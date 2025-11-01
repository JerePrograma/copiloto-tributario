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
  ftsMs?: number;
  k?: number;
  similarityAvg?: number;
  similarityMin?: number;
  hybridAvg?: number;
  hybridMin?: number;
  reranked?: boolean;
  restrictedCount?: number;
  vectorWeight?: number;
  textWeight?: number;
  weightSource?: "auto" | "manual" | "phase";
  phase?: string;
  relaxed?: boolean;
  modelId?: string;
  llmAttempts?: number;
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
    ftsMs?: number;
    hybridAvg?: number;
    hybridMin?: number;
    reranked?: boolean;
    restrictedCount?: number;
    vectorWeight: number;
    textWeight: number;
    weightSource: "auto" | "manual" | "phase";
    phase?: string;
    relaxed?: boolean;
  };
  llm?: {
    modelId?: string;
    attempts?: number;
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
    ftsMs?: number;
    hybridAvg?: number;
    hybridMin?: number;
    reranked?: boolean;
    restrictedCount?: number;
    vectorWeight: number;
    textWeight: number;
    weightSource: "auto" | "manual" | "phase";
    phase?: string;
    relaxed?: boolean;
  }) => void;
  setLLMInfo: (info: { modelId?: string; attempts?: number }) => void;
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
    setLLMInfo(info) {
      state.llm = { ...info };
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
        if (state.searchMetrics.ftsMs !== undefined) {
          snapshot.ftsMs = Math.round(state.searchMetrics.ftsMs);
        }
        snapshot.hybridAvg = state.searchMetrics.hybridAvg;
        snapshot.hybridMin = state.searchMetrics.hybridMin;
        snapshot.reranked = state.searchMetrics.reranked;
        snapshot.restrictedCount = state.searchMetrics.restrictedCount;
        snapshot.vectorWeight = state.searchMetrics.vectorWeight;
        snapshot.textWeight = state.searchMetrics.textWeight;
        snapshot.weightSource = state.searchMetrics.weightSource;
        snapshot.phase = state.searchMetrics.phase;
        snapshot.relaxed = state.searchMetrics.relaxed;
      }
      if (state.llm) {
        snapshot.modelId = state.llm.modelId;
        snapshot.llmAttempts = state.llm.attempts;
      }
      return snapshot;
    },
    timeline() {
      return [...state.toolEvents];
    },
  };
}
