import { render } from "solid-js/web";
import Chart from "../src/content/Chart";
import { Bar, Button, Canvas, Nav, Pane, Section, StatusRow, Workspace } from "../src/v2";

// The runs of an operations app on a v2 screen, at their worst: job lanes with long names beside a short one, and
// eight states with their own colours (as gateway-ops draws them, PR #4205). The timeline stands in a Canvas of the
// height the app gives it, as the skill says a chart stands in a v2 screen.

declare global {
  interface Window {
    __k2Mounted?: boolean;
  }
}

const HOUR = 3_600_000;
const start = Date.UTC(2026, 10, 26, 6);
const states = [
  { state: "ok", label: "Erfolgreich", color: "#10b981" },
  { state: "error", label: "Fehlgeschlagen", color: "#ef4444" },
  { state: "running", label: "Läuft", color: "#3b82f6" },
  { state: "stuck", label: "Nie beendet", color: "#f59e0b" },
  { state: "queued", label: "Wartet in der Warteschlange", color: "#8b5cf6" },
  { state: "cancelled", label: "Abgebrochen", color: "#64748b" },
  { state: "retried", label: "Wiederholt", color: "#0ea5e9" },
  { state: "skipped", label: "Übersprungen", color: "#a3a3a3" },
];
const lanes = [
  "worker:files:thumbnails",
  "worker-pool-eu-central:media-thumbnails-regeneration",
  "mail:imap-sync:postfach-kontakt@werkstatt-nord.example",
  "gc",
  "notebooks:export:pdf-render-queue",
  "accounts:directory-sync",
];
const rows = lanes.map((label, lane) => ({
  label,
  tooltip: label,
  intervals: Array.from({ length: 6 }, (_, slot) => {
    const from = start + (slot * 2 + (lane % 2)) * HOUR;
    return { from, to: from + HOUR * (0.6 + ((lane + slot) % 3) * 0.3), state: states[(lane + slot * 3) % states.length]!.state };
  }),
}));
const time = (value: number) => new Intl.DateTimeFormat("de-DE", { timeZone: "UTC", hour: "2-digit", minute: "2-digit" }).format(value);

const root = document.getElementById("root");
if (!root) throw new Error("state-timeline: #root is missing");
render(
  () => (
    <Workspace
      sidebar={
        <Nav
          title="Betrieb"
          icon="activity"
          groups={[
            {
              items: [
                { label: "Läufe", icon: "player-play", current: true, count: 312 },
                { label: "Telemetrie", icon: "chart-line" },
                { label: "Zustand", icon: "heart-rate-monitor" },
              ],
            },
          ]}
        />
      }
      head={<Bar end={<Button icon="refresh">Neu laden</Button>} />}
    >
      <Pane
        label="Läufe"
        status={
          <StatusRow
            lead="312 Läufe heute"
            facts={[
              { value: 9, after: "fehlgeschlagen" },
              { value: 4, after: "laufen" },
            ]}
          />
        }
      >
        <Section icon="timeline" title="Zeitstrahl">
          <Canvas label="Zeitstrahl der Jobs" height={Math.max(160, 96 + rows.length * 24)}>
            <Chart
              kind="stateTimeline"
              rows={rows}
              states={states}
              domain={[start, start + 12 * HOUR]}
              xAxis={{ format: time }}
              legend
              interactive
              style={{ height: "100%" }}
            />
          </Canvas>
        </Section>
      </Pane>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
