"use client";

import type { TimelineEvent } from "./types";

interface TimelineProps {
  events: TimelineEvent[];
}

const STATUS_LABEL: Record<TimelineEvent["status"], string> = {
  pending: "En progreso",
  ok: "OK",
  error: "Error",
};

export default function Timeline({ events }: TimelineProps) {
  return (
    <section className="panel timeline-panel">
      <header className="panel-header">
        <h2>Herramientas</h2>
      </header>
      <div className="panel-body timeline-body">
        {events.length === 0 ? (
          <p className="empty">Sin ejecuciones.</p>
        ) : (
          <ol className="timeline-list">
            {events.map((event) => (
              <li key={event.id} className={`timeline-item ${event.status}`}>
                <div className="timeline-row">
                  <span className="timeline-label">{event.label}</span>
                  <span className={`timeline-status ${event.status}`}>
                    {STATUS_LABEL[event.status]}
                  </span>
                </div>
                {event.detail ? (
                  <pre className="timeline-detail">{event.detail}</pre>
                ) : null}
                {event.durationMs !== undefined ? (
                  <span className="timeline-duration">
                    {event.durationMs.toFixed(0)} ms
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
