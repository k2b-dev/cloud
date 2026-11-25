import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { Bar, Button, Chip, Input, Pane, StatusRow, Table, Tabs, Workspace } from "../src/v2";

// A filtered list as an operations log draws it: a head with views, a search and "…"; a status row with the result,
// key figures, a loading mark and the order controls, above a large table with a sticky first column, group rows of
// minutes and a status chip at the end of each phone row. A hook turns the loading mark on and off, as a refresh does.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    /** Shows or hides the loading mark of the status row. */
    __k2Loading?: (on: boolean) => void;
    /** Gives the status row more key figures than fit before its controls in a column of 760 to 1024 px. */
    __k2MoreFacts?: () => void;
    /** Takes the filters away and shortens the lead: a status row with nothing at its end, as Mail's list column. */
    __k2NoFilters?: () => void;
    /** Gives the status row a lead longer than fits beside its worded filters in a column below 760 px. */
    __k2LongLead?: () => void;
    /** The search of the head takes Escape itself (its onKeyDown calls preventDefault) and counts it. */
    __k2TakeEscape?: boolean;
    __k2Escapes?: number;
  }
}

type Entry = { id: string; time: string; minute: string; level: "Fehler" | "Warnung"; source: string; message: string; ms: string };

const entries: readonly Entry[] = [
  {
    id: "1",
    time: "10:43:48,377",
    minute: "10:43",
    level: "Fehler",
    source: "gateway",
    message: "Upstream mail: Zeitüberschreitung nach 30 s",
    ms: "30.012 ms",
  },
  {
    id: "2",
    time: "10:43:35,992",
    minute: "10:43",
    level: "Fehler",
    source: "mail",
    message: "SMTP-Verbindung: Zeitüberschreitung nach 30 s",
    ms: "30.004 ms",
  },
  {
    id: "3",
    time: "10:42:28,153",
    minute: "10:42",
    level: "Warnung",
    source: "mail",
    message: "Zustellung verzögert: Greylisting",
    ms: "145 ms",
  },
  {
    id: "4",
    time: "10:42:06,622",
    minute: "10:42",
    level: "Warnung",
    source: "mail",
    message: "IMAP-Abgleich dauert länger als 20 s",
    ms: "1.015 ms",
  },
];

const level = (entry: Entry) => <Chip status={entry.level === "Fehler" ? "bad" : "warn"}>{entry.level}</Chip>;

const [loading, setLoading] = createSignal(false);
window.__k2Loading = setLoading;
const [more, setMore] = createSignal(false);
window.__k2MoreFacts = () => setMore(true);
const [filters, setFilters] = createSignal(true);
window.__k2NoFilters = () => setFilters(false);
const [longLead, setLongLead] = createSignal(false);
window.__k2LongLead = () => setLongLead(true);

const root = document.getElementById("root");
if (!root) throw new Error("status-table: #root is missing");
render(
  () => (
    <Workspace
      head={
        <Bar
          start={
            <Tabs
              label="Ansichten"
              items={[
                { label: "Alle", href: "#alle", current: true },
                { label: "Fehler", href: "#fehler" },
              ]}
            />
          }
          end={
            <>
              <Input
                type="search"
                icon="search"
                placeholder="Durchsuchen"
                label="Durchsuchen"
                onKeyDown={(event) => {
                  if (event.key !== "Escape" || !window.__k2TakeEscape) return;
                  event.preventDefault();
                  window.__k2Escapes = (window.__k2Escapes ?? 0) + 1;
                }}
              />
              <Button keep variant="ghost" icon="dots" label="Weitere Aktionen" />
            </>
          }
        />
      }
    >
      <Pane
        label="Protokolle"
        status={
          <StatusRow
            lead={longLead() ? "11 von 11 Einträgen aus Gateway, Mail und Zustellung" : filters() ? "11 von 11 Einträgen" : "4 neu"}
            loading={loading()}
            facts={[
              { value: 6, after: "Fehler" },
              { value: 5, after: "Warnungen" },
              ...(more()
                ? [
                    { before: "zuletzt", value: "10:43:48", after: "aus dem Gateway" },
                    { value: 2, after: "Quellen" },
                  ]
                : []),
            ]}
            filters={
              filters() ? (
                <>
                  <Button variant="text" icon="arrows-sort">
                    Neueste zuerst
                  </Button>
                  <Button variant="ghost" icon="stack-2" menu>
                    Nach Minute
                  </Button>
                </>
              ) : undefined
            }
          />
        }
      >
        <Table
          label="Einträge"
          rows={entries}
          rowKey={(entry) => entry.id}
          sticky
          group={(entry) => ({ key: entry.minute, head: () => <span>{entry.minute} Uhr</span>, meta: "2 Einträge" })}
          phone={(entry) => ({ lines: [entry.message, `${entry.time} · ${entry.source}`], time: entry.ms, marks: level(entry) })}
          columns={[
            { title: "Zeit", width: { min: 100, default: 120 }, cell: (entry) => entry.time },
            { title: "Stufe", width: { min: 90, default: 110 }, cell: level },
            { title: "Quelle", width: { min: 90, default: 120 }, cell: (entry) => entry.source },
            { title: "Nachricht", width: { min: 200, default: 420 }, cell: (entry) => entry.message },
            { title: "Dauer", align: "end", width: { min: 80, default: 100 }, cell: (entry) => entry.ms },
          ]}
        />
      </Pane>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
