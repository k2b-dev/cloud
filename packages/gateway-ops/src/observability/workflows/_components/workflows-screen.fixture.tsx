import { LocaleProvider } from "@k2b/ui";
import { fixtureNav, LONG } from "../../_components/services-fixture-area";
import { findingsQuery, runsQuery } from "../query";
import WorkflowsScreen, { type RunDetailView, type WorkflowsScreenProps } from "./WorkflowsScreen.island";

const apps = ["mail", "spaces"];
const base = "/admin/observability/workflows";
const START = Date.UTC(2026, 10, 24, 10);
const HOUR = 3_600_000;

const detail: RunDetailView = {
  title: "Rechnung versenden · Revision 4",
  state: { label: "Braucht Aufmerksamkeit", status: "warn" },
  meta: "mail · execute · Versuch 2 · vor 12 Minuten",
  outcome: {
    tone: "warn",
    title: "„send_invoice“ braucht eine Entscheidung",
    text: "Ob der Anbieter die Nachricht angenommen hat, ist unklar. Prüfe den Nachweis, bevor du entscheidest.",
  },
  facts: [
    { label: "Auslöser", value: "mail.invoice.created" },
    { label: "Eingetreten", value: "vor 12 Minuten" },
    { label: "Startverzögerung", value: "120 ms" },
  ],
  children: [{ label: "3 erfolgreich", status: "ok", href: `${base}?parent=1` }],
  steps: [
    {
      key: "a",
      step: "render",
      action: "render_pdf",
      state: { label: "Erfolgreich", status: "ok" },
      effect: null,
      detail: "—",
      attempts: "Versuch 1",
      duration: "1,2 s",
    },
    {
      key: "b",
      step: "send",
      action: "send_invoice",
      state: { label: "Braucht Aufmerksamkeit", status: "warn" },
      effect: { label: "Unklar", status: "warn" },
      detail: "SMTP timeout",
      attempts: "Versuch 2",
      duration: "30 s",
    },
  ],
  payloads: [{ title: "Eingaben", json: '{\n  "invoiceId": "R-2026-114"\n}' }],
  technical: [{ title: "Identität", json: '{\n  "runId": "6f1c…"\n}' }],
  actions: { runId: "6f1c2d3e-0000-4000-8000-000000000001", cancelable: false, attentionStep: { stepKey: "send", action: "send_invoice" } },
  closeHref: base,
};

/** The workflow console from invented runs; `view` picks the queue, `run` opens a run, `worst` adds long names. */
export const WorkflowsScreenFixture = (props: { search?: string; worst?: boolean; run?: boolean; locale?: string }) => {
  const locale = props.locale ?? "de";
  const params = new URLSearchParams(props.search ?? "");
  const view = params.get("view") === "effects" ? "effects" : params.get("view") === "events" ? "events" : "runs";
  const screen: WorkflowsScreenProps = {
    nav: fixtureNav,
    apps,
    view,
    runsState: runsQuery(locale, apps).parse(params).state,
    findingsState: findingsQuery(locale, apps).parse(params).state,
    search: params.size ? `?${params}` : "",
    ignored: null,
    tabs: { runs: base, effects: `${base}?view=effects`, events: `${base}?view=events`, effectsCount: "1", eventsCount: "" },
    cells: [
      { icon: "player-play", label: "Läufe", value: "1.204", meta: "letzte 24h" },
      { icon: "hourglass", label: "Laufend", value: "3", meta: "laufend oder wartend" },
      { icon: "alert-circle", label: "Fehlgeschlagen", value: "2", tone: "bad" },
      { icon: "hand-stop", label: "Braucht Aufmerksamkeit", value: "1", meta: "Entscheidung nötig", tone: "warn" },
      { icon: "clock-exclamation", label: "Schlimmste Startverzögerung", value: "8 min", tone: "warn" },
      { icon: "flag", label: "Offene Befunde", value: "1", meta: "1 Effekt · 0 Ereignisse", tone: "warn" },
    ],
    findings:
      view === "runs"
        ? [
            {
              tone: "warn",
              title: "1 Effekt braucht einen Nachweis",
              text: "Wiederholen kann den Effekt doppelt auslösen.",
              action: { label: "Effekte prüfen", href: `${base}?view=effects` },
            },
          ]
        : [],
    timeline:
      view === "runs"
        ? {
            domain: [START, START + 24 * HOUR],
            states: [
              { state: "succeeded", label: "Erfolgreich", color: "#10b981" },
              { state: "failed", label: "Fehlgeschlagen", color: "#ef4444" },
            ],
            sample: null,
            rows: [
              {
                label: props.worst ? LONG : "Rechnung versenden",
                href: `${base}?workflow=1`,
                tooltip: "Rechnung versenden · mail",
                intervals: [
                  { from: START + HOUR, to: START + 2 * HOUR, state: "succeeded", label: "1,2 s", href: "#", tooltip: "ok" },
                  { from: START + 20 * HOUR, to: START + 21 * HOUR, state: "failed", label: "30 s", href: "#", tooltip: "failed" },
                ],
              },
            ],
          }
        : null,
    list:
      view === "effects"
        ? {
            title: "Effekte mit Nachweisbedarf",
            count: "1",
            summary: "1 offener Effekt",
            actions: [],
            empty: "Kein Effekt wartet auf eine Entscheidung.",
            filtered: false,
            effects: [
              {
                key: "e",
                workflow: "Rechnung versenden",
                app: "mail",
                step: "send",
                action: "send_invoice",
                state: { label: "Unklar", status: "warn" },
                age: "12 min",
                href: `${base}?run=1`,
              },
            ],
          }
        : {
            title: "Workflows",
            count: "2",
            summary: "2 Definitionen in den letzten 24h",
            actions: [],
            empty: "Kein Workflow lief in diesem Zeitraum.",
            filtered: false,
            families: [
              {
                key: "f1",
                name: "Rechnung versenden",
                meta: "mail · mail.invoice.created · r4",
                latest: { label: "Braucht Aufmerksamkeit", status: "warn" },
                runs: "214",
                failed: "2 · 0,9 %",
                failedBad: true,
                runtime: "1,4 s / 31 s",
                backlog: "1 / 8 min",
                backlogWarn: true,
                activity: "vor 12 Minuten",
                href: `${base}?workflow=1`,
              },
              {
                key: "f2",
                name: props.worst ? LONG : "Bereich aufräumen",
                meta: "spaces · Direkter Aufruf · r1",
                latest: { label: "Erfolgreich", status: "ok" },
                runs: "12",
                failed: "0 · 0 %",
                failedBad: false,
                runtime: "84 ms / 120 ms",
                backlog: "0 / —",
                backlogWarn: false,
                activity: "vor 2 Stunden",
                href: `${base}?workflow=2`,
              },
            ],
          },
    missing: null,
    previousHref: null,
    nextHref: null,
    detail: props.run ? detail : null,
  };
  return (
    <LocaleProvider locale={locale}>
      <WorkflowsScreen {...screen} />
    </LocaleProvider>
  );
};

export default () => <WorkflowsScreenFixture run />;
