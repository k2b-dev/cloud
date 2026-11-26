import { render } from "solid-js/web";
import { Band, Bar, Pane, Table, Text, type TickState, Ticks, Workspace } from "../src/v2";

// The sources of a monitoring app, as Pulse draws them: one column carries the scrapes of the last 30 minutes, one tick
// per minute (ok in the soft app colour, a failed scrape red, a minute without a scrape empty). Below, the open source
// shows the same ticks across the width of its detail. The test reads sizes, colours and the forced-colors look.

declare global {
  interface Window {
    __k2Mounted?: boolean;
  }
}

/** 30 minutes: `fail` lists the minutes that failed, `from` the first minute with a scrape (a new source). */
const minutes = (fail: readonly number[], from = 0): TickState[] =>
  Array.from({ length: 30 }, (_, minute) => (minute < from ? "none" : fail.includes(minute) ? "bad" : "ok"));
const sources = [
  { name: "prometheus-nord", slots: minutes([]), last: "vor 12 s", words: "30 Abrufe, alle erfolgreich" },
  { name: "postgres-haupt", slots: minutes([21, 22, 27]), last: "vor 40 s", words: "30 Abrufe, 3 fehlgeschlagen" },
  { name: "nginx-zugriffe", slots: minutes([], 18), last: "vor 8 s", words: "12 Abrufe seit 18 Minuten, alle erfolgreich" },
  { name: "node-exporter", slots: minutes([5, 6, 7, 8, 9, 10, 11]), last: "vor 1 min", words: "30 Abrufe, 7 fehlgeschlagen" },
];

const root = document.getElementById("root");
if (!root) throw new Error("ticks: #root is missing");
render(
  () => (
    <Workspace head={<Bar start={<Text type="lead">Quellen</Text>} />}>
      <Pane label="Quellen">
        <Table
          label="Quellen"
          rows={sources}
          phone={(row) => ({ lines: [row.name, `${row.words} · ${row.last}`] })}
          columns={[
            { title: "Quelle", width: { min: 160, default: 220 }, cell: (row) => row.name },
            {
              title: "Abrufe, 30 Min",
              width: { min: 160, default: 180 },
              cell: (row) => <Ticks slots={row.slots} label={`${row.name}: ${row.words}`} />,
            },
            { title: "Letzter Abruf", width: { min: 110, default: 130 }, cell: (row) => row.last, drop: true },
          ]}
        />
        <Band>
          <Text>postgres-haupt: 30 Abrufe in 30 Minuten, 3 fehlgeschlagen</Text>
          <Ticks stretch slots={sources[1]!.slots} label="postgres-haupt: 30 Abrufe, 3 fehlgeschlagen" color="#7c3aed" />
        </Band>
      </Pane>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
