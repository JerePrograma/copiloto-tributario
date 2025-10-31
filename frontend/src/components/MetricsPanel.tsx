"use client";

import type { MetricsSnapshot } from "./types";

interface MetricsPanelProps {
  metrics: MetricsSnapshot;
}

const MetricRow = ({ label, value }: { label: string; value: string }) => (
  <div className="metric-row">
    <span className="metric-label">{label}</span>
    <span className="metric-value">{value}</span>
  </div>
);

export function formatMs(value?: number): string {
  if (value === undefined) return "—";
  return `${value.toFixed(0)} ms`;
}

export function formatSimilarity(value?: number): string {
  if (value === undefined) return "—";
  return value.toFixed(3);
}

export default function MetricsPanel({ metrics }: MetricsPanelProps) {
  return (
    <section className="panel metrics-panel">
      <header className="panel-header">
        <h2>Métricas en vivo</h2>
      </header>
      <div className="panel-body">
        <MetricRow label="TTFB" value={formatMs(metrics.ttfbMs)} />
        <MetricRow label="Latencia LLM" value={formatMs(metrics.llmMs)} />
        <MetricRow label="Latencia SQL" value={formatMs(metrics.sqlMs)} />
        <MetricRow label="Latencia embeddings" value={formatMs(metrics.embeddingMs)} />
        <MetricRow label="Latencia FTS" value={formatMs(metrics.ftsMs)} />
        <MetricRow
          label="k (chunks)"
          value={metrics.k !== undefined ? String(metrics.k) : "—"}
        />
        <MetricRow
          label="Similitud media"
          value={formatSimilarity(metrics.similarityAvg)}
        />
        <MetricRow
          label="Similitud mínima"
          value={formatSimilarity(metrics.similarityMin)}
        />
        <MetricRow
          label="Hybrid avg"
          value={formatSimilarity(metrics.hybridAvg)}
        />
        <MetricRow
          label="Hybrid min"
          value={formatSimilarity(metrics.hybridMin)}
        />
        <MetricRow
          label="Reranker"
          value={metrics.reranked ? "Activado" : "No"}
        />
        <MetricRow
          label="Jurisdicciones restringidas"
          value={metrics.restrictedCount !== undefined ? String(metrics.restrictedCount) : "—"}
        />
        <MetricRow
          label="Modelo LLM"
          value={metrics.modelId ?? "—"}
        />
        <MetricRow
          label="Intentos LLM"
          value={metrics.llmAttempts !== undefined ? String(metrics.llmAttempts) : "—"}
        />
      </div>
    </section>
  );
}
