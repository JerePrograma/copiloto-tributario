"use client";

import type { ClaimCheckEntry } from "./types";

interface QualityDashboardProps {
  claims: ClaimCheckEntry[];
}

export default function QualityDashboard({ claims }: QualityDashboardProps) {
  const supported = claims.filter((claim) => claim.status === "supported").length;
  const unsupported = claims.filter((claim) => claim.status === "no_evidence").length;
  return (
    <section className="panel quality-panel">
      <header className="panel-header">
        <h2>Calidad de respuesta</h2>
      </header>
      <div className="panel-body">
        <div className="quality-metrics">
          <div>
            <span className="quality-label">Oraciones evidenciadas</span>
            <span className="quality-value">{supported}</span>
          </div>
          <div>
            <span className="quality-label">Sin evidencia</span>
            <span className="quality-value">{unsupported}</span>
          </div>
        </div>
        <ul className="quality-list">
          {claims.map((claim, idx) => (
            <li key={`claim-${idx}`} className={claim.status}>
              <span>{claim.sentence}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
