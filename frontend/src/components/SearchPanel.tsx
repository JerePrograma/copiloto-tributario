"use client";

import { FormEvent, useState } from "react";
import type { AuthState, MetricsSnapshot } from "./types";

interface SearchResult {
  id: string;
  title: string;
  href: string;
  content: string;
  similarity: number;
  hybridScore?: number;
  jurisdiccion?: string | null;
  tipo?: string | null;
  anio?: number | null;
}

interface ApiResponse {
  results: SearchResult[];
  metrics: MetricsSnapshot;
  authenticated: boolean;
}

const API_BASE = (process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001").replace(/\/$/, "");

interface SearchPanelProps {
  authState: AuthState;
}

export default function SearchPanel({ authState }: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [metrics, setMetrics] = useState<MetricsSnapshot>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: query.trim(),
          authUserId:
            authState.status === "valid" ? authState.userId : undefined,
          k: 6,
          reranker: "lexical",
        }),
      });
      if (!response.ok) {
        throw new Error(`Error ${response.status}`);
      }
      const payload = (await response.json()) as ApiResponse;
      setResults(payload.results);
      setMetrics(payload.metrics);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="panel search-panel">
      <header className="panel-header">
        <h2>Buscador híbrido</h2>
        <p className="panel-subtitle">
          {authState.status === "valid"
            ? "Herramientas habilitadas para tu sesión."
            : "Validá tu passcode en el chat para habilitar resultados restringidos."}
        </p>
      </header>
      <div className="panel-body">
        <form className="search-form" onSubmit={handleSubmit}>
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar normativa..."
            disabled={loading}
          />
          <button type="submit" disabled={loading || !query.trim()}>
            {loading ? "Buscando..." : "Buscar"}
          </button>
        </form>
        {error ? <p className="error">{error}</p> : null}
        {results.length > 0 ? (
          <ol className="search-results">
            {results.map((result) => (
              <li key={result.id}>
                <div className="search-heading">
                  <a href={result.href} target="_blank" rel="noreferrer">
                    {result.title}
                  </a>
                </div>
                <div className="search-meta">
                  <span>sim: {result.similarity.toFixed(3)}</span>
                  {result.hybridScore !== undefined ? (
                    <span>hyb: {result.hybridScore.toFixed(3)}</span>
                  ) : null}
                  {result.jurisdiccion ? (
                    <span>jurisdicción: {result.jurisdiccion}</span>
                  ) : null}
                  {result.tipo ? <span>tipo: {result.tipo}</span> : null}
                  {result.anio ? <span>año: {result.anio}</span> : null}
                </div>
                <p>{result.content}</p>
              </li>
            ))}
          </ol>
        ) : null}
        {results.length > 0 ? (
          <div className="search-metrics">
            <span>k: {metrics.k ?? "—"}</span>
            <span>sql: {metrics.sqlMs ?? "—"} ms</span>
            <span>fts: {metrics.ftsMs ?? "—"} ms</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
