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
      </div>
    </section>
  );
}
