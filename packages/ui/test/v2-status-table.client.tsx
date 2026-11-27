import { createSignal, type JSX, Show } from "solid-js";
import { render } from "solid-js/web";
import { Bar, Button, Chip, Input, Pane, Path, StatusRow, Table, Tabs, Text, Workspace } from "../src/v2";

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
    /**
     * Draws the status row as the operations log does (break-ui finding 21): its result, figures with large counts,
     * live as a toggle with a symbol and a short label, and sort and grouping as framed menus in words. Live is on, or
     * off and blocked: then the toggle is disabled and the reason stands as a figure in the row.
     */
    __k2Logs?: (live?: "on" | "until-now" | "first-page") => void;
    /** A list with an entry open beside it, its status row as proxy-auth draws it: a long lead and a warning chip at the end. */
    __k2Proxy?: () => void;
    /** Three key figures, for a long lead beside figures and filters (the order of giving way). */
    __k2ThreeFacts?: () => void;
    /** Mail's list column: a select box, a short lead, one long figure and no filters. */
    __k2MailFact?: () => void;
    /**
     * Tinted chips of the statement: an exception "1 ohne Zugriff" and a warning "2 laufen ab"; `"none"` passes
     * `marks={false}`, as `missing() > 0 && <Chip …/>` does while nothing is missing.
     */
    __k2Marks?: (state?: "shown" | "none") => void;
    /** The search of the head takes Escape itself (its onKeyDown calls preventDefault) and counts it. */
    __k2TakeEscape?: boolean;
    __k2Escapes?: number;
    /** Set before the fixture mounts: the head shows where the page stands (a `Path`) instead of its views. */
    __k2PathHead?: boolean;
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
const [logs, setLogs] = createSignal<"on" | "until-now" | "first-page" | undefined>();
window.__k2Logs = (live = "on") => setLogs(live);
const [proxy, setProxy] = createSignal(false);
window.__k2Proxy = () => setProxy(true);
const [three, setThree] = createSignal(false);
window.__k2ThreeFacts = () => setThree(true);
const [mail, setMail] = createSignal(false);
window.__k2MailFact = () => {
  setFilters(false);
  setMail(true);
};
const [chips, setChips] = createSignal<"shown" | "none" | undefined>();
window.__k2Marks = (state = "shown") => setChips(state);
const liveBlocked = () =>
  logs() === "until-now" ? "Live nur mit Zeitraum bis jetzt" : logs() === "first-page" ? "Live nur auf der ersten Seite" : undefined;

/** The list alone, or (proxy) beside an open entry in a split: a column of a split keeps at least 400 px, so the other
 * states keep the list alone and can narrow it to 320 px. */
const Frame = (props: { children: JSX.Element }) => (
  <Show when={proxy()} fallback={props.children}>
    <Pane.Split>
      {props.children}
      <Pane detail label="Client" head={<Bar start={<Text type="lead">Uptime Kuma</Text>} />}>
        <Text>Erreichbarkeit der Dienste</Text>
      </Pane>
    </Pane.Split>
  </Show>
);

const root = document.getElementById("root");
if (!root) throw new Error("status-table: #root is missing");
render(
  () => (
    <Workspace
      head={
        <Bar
          start={
            window.__k2PathHead ? (
              <Path label="Ort" items={[{ label: "Betrieb", href: "#betrieb" }, { label: "Protokolle" }]} />
            ) : (
              <Tabs
                label="Ansichten"
                items={[
                  { label: "Alle", href: "#alle", current: true },
                  { label: "Fehler", count: 5, href: "#fehler" },
                  { label: "Warn", count: 6, href: "#warn" },
                  {
                    label: "Weitere",
                    count: "+2",
                    menu: [
                      { label: "Jobs", href: "#jobs" },
                      { label: "Anfragen", href: "#anfragen" },
                    ],
                  },
                ]}
              />
            )
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
      <Frame>
        <Pane
          label="Protokolle"
          status={
            <StatusRow
              select={mail() ? { label: "Alle auswählen" } : undefined}
              lead={
                mail()
                  ? "7 ungelesen"
                  : proxy()
                    ? "1 Client ist bis zur Konfiguration gesperrt"
                    : logs()
                      ? "300 von 12.345 Einträgen"
                      : longLead()
                        ? "11 von 11 Einträgen aus Gateway, Mail, Zustellung und dem Abgleich der Kalender"
                        : filters()
                          ? "11 von 11 Einträgen"
                          : "4 neu"
              }
              loading={loading()}
              marks={
                chips() === "shown" ? (
                  <>
                    <Chip status="bad">1 ohne Zugriff</Chip>
                    <Chip status="warn">2 laufen ab</Chip>
                  </>
                ) : chips() === "none" ? (
                  false
                ) : undefined
              }
              facts={[
                ...(mail()
                  ? [{ before: "Heute", value: 12, after: "erledigt · 5 davon automatisch" }]
                  : proxy()
                    ? []
                    : logs()
                      ? [
                          { value: "1.204", after: "Fehler" },
                          { value: 321, after: "Warnungen" },
                          ...(liveBlocked() ? [{ after: liveBlocked() }] : []),
                        ]
                      : [
                          { value: 6, after: "Fehler" },
                          { value: 5, after: "Warnungen" },
                          ...(three() ? [{ value: 2, after: "Quellen" }] : []),
                        ]),
                ...(more()
                  ? [
                      { before: "zuletzt", value: "10:43:48", after: "aus dem Gateway" },
                      { value: 2, after: "Quellen" },
                    ]
                  : []),
              ]}
              filters={
                proxy() ? (
                  <Chip status="warn" icon="lock">
                    bis zur Konfiguration gesperrt
                  </Chip>
                ) : logs() ? (
                  <>
                    <Button icon="broadcast" pressed={logs() === "on"} disabled={liveBlocked() !== undefined} title={liveBlocked()}>
                      Live
                    </Button>
                    <Button icon="arrows-sort" menu>
                      Eingang ↓
                    </Button>
                    <Button icon="stack-2" menu>
                      Keine Gruppen
                    </Button>
                  </>
                ) : filters() ? (
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
      </Frame>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
