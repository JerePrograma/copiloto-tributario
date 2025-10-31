"use client";

import type { Citation } from "./types";

interface SourcesPanelProps {
  citations: Citation[];
}

export default function SourcesPanel({ citations }: SourcesPanelProps) {
  return (
    <section className="panel sources-panel">
      <header className="panel-header">
        <h2>Fuentes</h2>
      </header>
      <div className="panel-body sources-body">
        {citations.length === 0 ? (
          <p className="empty">Aún sin evidencia cargada.</p>
        ) : (
          <ol className="sources-list">
            {citations.map((citation) => (
              <li key={citation.id}>
                <div className="source-heading">
                  <span className="source-id">[{citation.id}]</span>
                  <a href={citation.href} target="_blank" rel="noreferrer">
                    {citation.title}
                  </a>
                </div>
                <div className="source-meta">
                  <span>sim: {citation.similarity.toFixed(3)}</span>
                  {citation.hybridScore !== undefined ? (
                    <span>hyb: {citation.hybridScore.toFixed(3)}</span>
                  ) : null}
                  {citation.jurisdiccion ? (
                    <span>jurisdicción: {citation.jurisdiccion}</span>
                  ) : null}
                  {citation.tipo ? <span>tipo: {citation.tipo}</span> : null}
                  {citation.anio ? <span>año: {citation.anio}</span> : null}
                </div>
                <p className="source-snippet">{citation.snippet}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
