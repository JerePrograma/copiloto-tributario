"use client";

import { useState } from "react";
import Chat from "./Chat";
import MetricsPanel from "./MetricsPanel";
import Timeline from "./Timeline";
import SourcesPanel from "./SourcesPanel";
import QualityDashboard from "./QualityDashboard";
import SearchPanel from "./SearchPanel";
import type {
  AuthState,
  ClaimCheckEntry,
  Citation,
  MetricsSnapshot,
  TimelineEvent,
} from "./types";

export default function AppShell() {
  const [metrics, setMetrics] = useState<MetricsSnapshot>({});
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [citations, setCitations] = useState<Citation[]>([]);
  const [claims, setClaims] = useState<ClaimCheckEntry[]>([]);
  const [authState, setAuthState] = useState<AuthState>({ status: "unknown" });

  return (
    <div className="layout">
      <div className="layout-main">
        <Chat
          onMetrics={setMetrics}
          onTimeline={setTimeline}
          onCitations={setCitations}
          onClaims={setClaims}
          authState={authState}
          onAuthStateChange={setAuthState}
        />
      </div>
      <aside className="layout-aside">
        <SearchPanel authState={authState} />
        <SourcesPanel citations={citations} />
        <QualityDashboard claims={claims} />
        <MetricsPanel metrics={metrics} />
        <Timeline events={timeline} />
      </aside>
    </div>
  );
}
