import { LocaleProvider } from "@k2b/ui";
import type { NavProps } from "@k2b/ui/v2";
import { buildOverviewSignals, overviewQuery, overviewVerdict } from "../overview";
import OverviewScreen, { type FailingRoute } from "./OverviewScreen";
import { opsCharts } from "./ops-chart";

// Invented operations for render and browser tests: fixed times, no production data.

export type OverviewFixtureData = "normal" | "quiet" | "worst";

const nav: NavProps = {
  title: "Administration",
  icon: "settings",
  groups: [{ items: [{ label: "Übersicht", icon: "dashboard", href: "/admin/observability", current: true }] }],
};

const END = Date.parse("2026-11-24T09:00:00.000Z");
const HOUR = 3_600_000;
/** 24 hourly points: a quiet base with a short burst, as an incident looks. */
const series = (base: number, burst: number) =>
  Array.from({ length: 24 }, (_, index) => ({ x: END - (23 - index) * HOUR, y: index >= 15 && index <= 17 ? burst : base + (index % 3) }));

const ROUTES: FailingRoute[] = [
  ["mail", "Mail", "mail", "/api/mail/send", 41, 1_812],
  ["files", "Dateien", "folder", "/api/files/upload/:id", 17, 3_406],
  ["notebooks", "Notizbücher", "notebook", "/api/notebooks/:id/pages", 6, 9_120],
  ["calendar", "Kalender", "calendar", "/api/calendar/sync", 3, 640],
].map(([id, label, icon, route, errors, requests]) => ({
  key: `${id}:${route}`,
  route: String(route),
  app: { label: String(label), icon: String(icon) },
  errors: Number(errors).toLocaleString("de"),
  requests: Number(requests).toLocaleString("de"),
  rate: new Intl.NumberFormat("de", { style: "percent", maximumFractionDigits: 1 }).format(Number(errors) / Number(requests)),
  href: `/admin/observability/telemetry?range=24h&app=${id}&route=${encodeURIComponent(String(route))}`,
}));

const WORST_ROUTE: FailingRoute = {
  key: "werkstatt:long",
  route: "/api/werkstatt/kunden/:kundeId/auftraege/:auftragId/positionen/:positionId/anhaenge/:anhangId/vorschau",
  app: { label: "Kunden & Aufträge (Werkstatt Nord)", icon: "tool" },
  errors: "123.456",
  requests: "123.456",
  rate: "100 %",
  href: "/admin/observability/telemetry?range=24h&app=werkstatt",
};

/** The overview for one window and data set, as the page renders it. */
export const OverviewScreenFixture = (props: { search: string; locale?: string; data?: OverviewFixtureData }) => {
  const locale = props.locale ?? "de";
  const data = props.data ?? "normal";
  const query = overviewQuery(locale);
  const { state } = query.parse(new URLSearchParams(props.search));
  const range = state.filters.range.kind === "preset" ? state.filters.range.preset : "24h";
  const quiet = data === "quiet";
  const worst = data === "worst";
  const signals = buildOverviewSignals(
    {
      range,
      jobsWindow: range === "6h" ? "12h" : range,
      offlineApps: quiet
        ? []
        : worst
          ? ["kunden-und-auftraege-werkstatt-nord", "mail", "files", "notebooks", "calendar", "календарь-синхронизация"]
          : ["calendar"],
      serverErrors: quiet ? 0 : worst ? 1_234_567 : 67,
      rateLimited: quiet ? 0 : 12,
      failedRuns: quiet ? 0 : worst ? 98_765 : 7,
      stuckRuns: quiet ? 0 : 1,
      logErrors: quiet ? 0 : 23,
      unavailable: worst ? { logs: "connect ECONNREFUSED 10.0.0.12:5432 — the log store did not answer within 5 s" } : {},
    },
    locale,
  );
  const verdict = overviewVerdict(signals, locale);
  const charts = opsCharts(
    [
      {
        kind: "line",
        title: "Serverfehler",
        description: "5xx-Antworten im gewählten Auswertungszeitraum.",
        maxGap: HOUR,
        series: [{ label: "Fehler", data: quiet ? series(0, 0) : series(1, 40) }],
      },
      {
        kind: "line",
        title: "Protokollstufen im Zeitverlauf",
        description: "Warnungen und Fehler im gewählten Auswertungszeitraum.",
        maxGap: HOUR,
        error: worst ? "Der Protokollspeicher war nicht lesbar." : null,
        series: [
          { label: "Warnungen", data: series(4, 30) },
          { label: "Fehler", data: series(0, 12) },
        ],
      },
    ],
    locale,
  ).map((chart, index) => ({
    chart,
    icon: index === 0 ? "alert-circle" : "file-alert",
    empty: "Keine Werte",
    href: index === 0 ? "/admin/observability/telemetry?range=24h" : "/admin/observability/logs?time=last-24h",
    linkLabel: index === 0 ? "Datenverkehr öffnen" : "Protokolle öffnen",
  }));
  return (
    <LocaleProvider locale={locale}>
      <OverviewScreen
        nav={nav}
        state={state}
        verdict={{ label: verdict.label, description: verdict.description }}
        signals={signals}
        cells={[
          {
            icon: "apps",
            label: "Apps online",
            value: quiet ? "14/14" : "13/14",
            meta: "registrierte Apps",
            tone: quiet ? undefined : "bad",
          },
          { icon: "arrows-exchange", label: "Anfragen", value: worst ? "12.345.678.901" : "48.213", meta: "112 Langsame Anfragen" },
          {
            icon: "player-play",
            label: "Fehlgeschlagene Läufe",
            value: quiet ? "0" : worst ? "98.765" : "7",
            meta: "1 Lauf hängt",
            tone: quiet ? undefined : "warn",
          },
          worst
            ? { icon: "file-alert", label: "Protokollwarnungen", value: "—", meta: "nicht verfügbar" }
            : {
                icon: "file-alert",
                label: "Protokollwarnungen",
                value: quiet ? "0" : "318",
                meta: "letzte 24 Std.",
                tone: quiet ? undefined : "warn",
              },
        ]}
        charts={charts}
        routes={{
          rows: quiet ? [] : worst ? [WORST_ROUTE, ...ROUTES] : ROUTES,
          error: null,
          href: "/admin/observability/telemetry?range=24h&only=errors",
        }}
      />
    </LocaleProvider>
  );
};
