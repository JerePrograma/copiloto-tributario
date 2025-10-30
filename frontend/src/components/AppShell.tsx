"use client";

import { useState } from "react";
import Chat from "./Chat";
import MetricsPanel from "./MetricsPanel";
import Timeline from "./Timeline";
import type { MetricsSnapshot, TimelineEvent } from "./types";

export default function AppShell() {
  const [metrics, setMetrics] = useState<MetricsSnapshot>({});
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);

  return (
    <div className="layout">
      <div className="layout-main">
        <Chat onMetrics={setMetrics} onTimeline={setTimeline} />
      </div>
      <aside className="layout-aside">
        <MetricsPanel metrics={metrics} />
        <Timeline events={timeline} />
      </aside>
    </div>
  );
}
