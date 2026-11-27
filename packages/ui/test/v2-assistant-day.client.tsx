import { render } from "solid-js/web";
import Chart from "../src/content/Chart";
import { Bar, Button, Canvas, Nav, Pane, Section, StatusRow, Workspace } from "../src/v2";

// A day of an assistant's runs on a v2 screen, as the Assistant's day line draws it: automations that run for seconds
// (a morning report, sorting the inbox), one that ran for minutes, failed runs, and runs still to come today. The page
// knows the present moment (14:20) and passes it; the chart reads no clock of its own.

declare global {
  interface Window {
    __k2Mounted?: boolean;
  }
}

const HOUR = 3_600_000;
const day = Date.UTC(2026, 10, 26);
const at = (hours: number, minutes = 0) => day + hours * HOUR + minutes * 60_000;
const now = at(14, 20);
const states = [
  { state: "ok", label: "Erfolgreich", color: "#10b981" },
  { state: "error", label: "Fehlgeschlagen", color: "#ef4444" },
  { state: "running", label: "Läuft", color: "#3b82f6" },
  { state: "scheduled", label: "Steht an", color: "#64748b" },
];
const time = (value: number) => new Intl.DateTimeFormat("de-DE", { timeZone: "UTC", hour: "2-digit", minute: "2-digit" }).format(value);
/** A run of `seconds` at a time of day; `planned` when it is still to come. */
const run = (hours: number, minutes: number, seconds: number, state: string, planned = false) => {
  const from = at(hours, minutes);
  return {
    from,
    to: from + seconds * 1000,
    state,
    planned,
    href: planned ? undefined : `/app/assistant/runs/${hours}${minutes}`,
    tooltip: planned ? `${time(from)} · geplant` : `${time(from)} · ${seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`}`,
  };
};
const rows = [
  { label: "Morgenbericht", intervals: [run(7, 0, 4, "ok"), run(19, 0, 4, "scheduled", true)] },
  {
    label: "Postfach sortieren",
    intervals: [7, 9, 11, 13, 15, 17, 19].map((hour) =>
      hour < 14 ? run(hour, 30, 2, hour === 11 ? "error" : "ok") : run(hour, 30, 2, "scheduled", true),
    ),
  },
  { label: "Rechnungen ablegen", intervals: [run(8, 15, 38, "ok"), run(12, 15, 41, "error"), run(16, 15, 40, "scheduled", true)] },
  { label: "Kalender abgleichen", intervals: [run(6, 0, 1, "ok"), run(12, 0, 1, "ok"), run(18, 0, 1, "scheduled", true)] },
  { label: "Wochenrückblick schreiben", intervals: [{ ...run(13, 50, 30 * 60, "running"), to: now }] },
];

const root = document.getElementById("root");
if (!root) throw new Error("assistant-day: #root is missing");
render(
  () => (
    <Workspace
      sidebar={
        <Nav
          title="Assistent"
          icon="sparkles"
          groups={[
            {
              items: [
                { label: "Unterhaltungen", icon: "messages" },
                { label: "Automationen", icon: "robot", current: true, count: 5 },
                { label: "Wissen", icon: "books" },
              ],
            },
          ]}
        />
      }
      head={<Bar end={<Button icon="plus">Automation</Button>} />}
    >
      <Pane
        label="Automationen"
        status={
          <StatusRow
            lead="Heute 14 Läufe"
            facts={[
              { value: 2, after: "fehlgeschlagen" },
              { value: 6, after: "stehen an" },
            ]}
          />
        }
      >
        <Section icon="timeline" title="Tageslinie">
          <Canvas label="Läufe heute" height={Math.max(160, 96 + rows.length * 24)}>
            <Chart
              kind="stateTimeline"
              rows={rows}
              states={states}
              domain={[day, day + 24 * HOUR]}
              now={now}
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
