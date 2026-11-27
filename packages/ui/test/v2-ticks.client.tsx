import { render } from "solid-js/web";
import { Band, Bar, Pane, Table, Text, type TickState, Ticks, Workspace } from "../src/v2";

// The sources of a monitoring app, as Pulse draws them: one column carries the scrapes of the last 30 minutes, one tick
// per minute (ok in the soft app colour, a failed scrape red, a minute without a scrape empty). Below, the open source
// shows the same ticks across the width of its detail; it is the open row of the table. The test reads sizes, colours
// and the forced-colors look.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    /** One more source with 500 slots: more than a cell holds. */
    __k2Many?: boolean;
  }
}

/** 30 minutes: `fail` lists the minutes that failed, `from` the first minute with a scrape (a new source). */
const minutes = (fail: readonly number[], from = 0): TickState[] =>
  Array.from({ length: 30 }, (_, minute) => (minute < from ? "none" : fail.includes(minute) ? "bad" : "ok"));
const sources = [
  { name: "prometheus-nord", slots: minutes([]), last: "vor 12 s", words: "alle 30 Abrufe erfolgreich" },
  { name: "postgres-haupt", slots: minutes([21, 22, 27]), last: "vor 40 s", words: "3 von 30 Abrufen fehlgeschlagen" },
  { name: "nginx-zugriffe", slots: minutes([], 18), last: "vor 8 s", words: "alle 12 Abrufe erfolgreich, erst seit 18 Minuten" },
  { name: "node-exporter", slots: minutes([5, 6, 7, 8, 9, 10, 11]), last: "vor 1 min", words: "7 von 30 Abrufen fehlgeschlagen" },
  ...(window.__k2Many
    ? [
        {
          name: "syslog-alle",
          slots: Array.from({ length: 500 }, (): TickState => "ok"),
          last: "vor 2 s",
          words: "alle 500 Abrufe erfolgreich",
        },
      ]
    : []),
];
/** The one form of every label: what, over which time, then what happened. */
const label = (source: (typeof sources)[number]) => `${source.name}, letzte 30 Minuten: ${source.words}`;

const root = document.getElementById("root");
if (!root) throw new Error("ticks: #root is missing");
render(
  () => (
    <Workspace head={<Bar start={<Text type="lead">Quellen</Text>} />}>
      <Pane label="Quellen">
        <Table
          label="Quellen"
          rows={sources}
          rowKey={(row) => row.name}
          current="postgres-haupt"
          phone={(row) => ({ lines: [row.name, `${row.words} · ${row.last}`] })}
          columns={[
            { title: "Quelle", width: { min: 160, default: 220 }, cell: (row) => row.name },
            {
              title: "Abrufe, 30 Min",
              width: { min: 160, default: 180 },
              cell: (row) => <Ticks slots={row.slots} label={label(row)} />,
            },
            { title: "Letzter Abruf", width: { min: 110, default: 130 }, cell: (row) => row.last, drop: true },
          ]}
        />
        <Band>
          <Text>postgres-haupt, letzte 30 Minuten: 3 von 30 Abrufen fehlgeschlagen</Text>
          <Ticks stretch slots={sources[1]!.slots} label={label(sources[1]!)} color="#7c3aed" />
        </Band>
      </Pane>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
