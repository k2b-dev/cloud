import { LocaleProvider } from "@k2b/ui";
import type { NavProps } from "@k2b/ui/v2";
import { BAD_ROUTE_SHARE, buildOverviewSignals, overviewQuery, overviewVerdict } from "../overview";
import type { FailingRoute, OverviewApp } from "./OverviewScreen";
import OverviewScreen from "./OverviewScreen.island";
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

const APPS: [id: string, label: string, icon: string, color: string][] = [
  ["mail", "Mail", "mail", "#2563eb"],
  ["files", "Dateien", "folder", "#d97706"],
  ["pulse", "Pulse", "activity", "#db2777"],
  ["grids", "Grids", "table", "#16a34a"],
  ["notebooks", "Notizbücher", "notebook", "#7c3aed"],
  ["spaces", "Spaces", "layout-kanban", "#0891b2"],
  ["chat", "Chat", "message-circle", "#0d9488"],
  ["contacts", "Kontakte", "address-book", "#ea580c"],
  ["calendar", "Kalender", "calendar", "#c2410c"],
  ["assistant", "Assistent", "sparkles", "#9333ea"],
  ["tools", "Werkzeuge", "tool", "#475569"],
  ["core", "Cloud", "cloud", "#57534e"],
];
const app = (id: string) => {
  const found = APPS.find((entry) => entry[0] === id);
  return { label: found?.[1] ?? id, icon: found?.[2] ?? "apps", color: found?.[3] };
};

const ROUTES: FailingRoute[] = (
  [
    ["pulse", "/api/pulse/streams", 214, 214],
    ["chat", "/api/chat/rooms/:id/messages", 61, 2_840],
    ["files", "/api/files/upload/:id", 22, 1_904],
    ["mail", "/api/mail/send", 9, 6_120],
    ["grids", "/api/grids/bases/:id/rows", 6, 3_311],
  ] as const
).map(([id, route, errors, requests]) => ({
  key: `${id}:${route}`,
  route,
  app: app(id),
  errors: errors.toLocaleString("de"),
  requests: requests.toLocaleString("de"),
  rate: new Intl.NumberFormat("de", { style: "percent", maximumFractionDigits: 1 }).format(errors / requests),
  bad: errors / requests >= BAD_ROUTE_SHARE,
  href: `/admin/observability/telemetry?range=24h&app=${id}&route=${encodeURIComponent(route)}`,
}));

const WORST_ROUTE: FailingRoute = {
  key: "werkstatt:long",
  route: "/api/werkstatt/kunden/:kundeId/auftraege/:auftragId/positionen/:positionId/anhaenge/:anhangId/vorschau",
  app: { label: "Kunden & Aufträge (Werkstatt Nord)", icon: "tool" },
  errors: "123.456",
  requests: "123.456",
  rate: "100 %",
  bad: true,
  href: "/admin/observability/telemetry?range=24h&app=werkstatt",
};

/** Server errors per hour of the window: a quiet base with the burst of the incident. */
const ERRORS = [4, 6, 3, 5, 8, 6, 4, 3, 2, 3, 5, 9, 12, 48, 61, 22, 9, 7, 10, 14, 18, 25, 16, 11];

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
          : ["pulse"],
      serverErrors: quiet ? 0 : worst ? 1_234_567 : 311,
      rateLimited: quiet ? 0 : 12,
      failedRuns: quiet ? 0 : worst ? 98_765 : 14,
      stuckRuns: quiet ? 0 : 1,
      logErrors: quiet ? 0 : 23,
      unavailable: worst ? { logs: "connect ECONNREFUSED 10.0.0.12:5432 — the log store did not answer within 5 s" } : {},
    },
    locale,
  );
  const verdict = overviewVerdict(signals, locale);
  const [logChart] = opsCharts(
    [
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
  );
  const errors = quiet ? ERRORS.map(() => 0) : worst ? ERRORS.map((value) => value * 4_000) : ERRORS;
  const apps: OverviewApp[] = [
    ...(worst
      ? [
          {
            id: "kunden-und-auftraege-werkstatt-nord",
            label: "Kunden & Aufträge (Werkstatt Nord) – Auftragsverwaltung",
            icon: "tool",
            status: "bad" as const,
          },
        ]
      : []),
    ...APPS.map(([id, label, icon, color]) => ({
      id,
      label,
      icon,
      color,
      status: quiet ? ("ok" as const) : id === "pulse" ? ("bad" as const) : id === "chat" ? ("warn" as const) : ("ok" as const),
    })),
  ];
  return (
    <LocaleProvider locale={locale}>
      <OverviewScreen
        nav={nav}
        state={state}
        verdict={{ label: verdict.label, description: verdict.description }}
        signals={signals.filter((signal) => signal.id !== "server-errors")}
        cells={[
          {
            icon: "alert-circle",
            label: "Serverfehler",
            value: quiet ? "0" : worst ? "1.234.567" : "311",
            meta: quiet ? "0 % von 45.530 Anfragen" : worst ? "10 % von 12.345.678.901 Anfragen" : "0,68 % von 45.530 Anfragen",
            tone: quiet ? undefined : "bad",
            href: "/admin/observability/telemetry?range=24h&only=errors",
            trend: { values: errors, label: "Serverfehler je Stunde" },
          },
          { icon: "apps", label: "Apps online", value: quiet ? "12/12" : "10/12", meta: "registrierte Apps" },
          { icon: "player-play", label: "Läufe", value: worst ? "12.345.678" : "3.482", meta: "24h" },
        ]}
        logs={
          logChart && {
            chart: logChart,
            empty: "Keine Werte",
            href: "/admin/observability/logs?time=last-24h",
            linkLabel: "Protokolle öffnen",
          }
        }
        routes={{
          rows: quiet ? [] : worst ? [WORST_ROUTE, ...ROUTES] : ROUTES,
          error: null,
          href: "/admin/observability/telemetry?range=24h&only=errors",
        }}
        services={[
          {
            key: "postgres",
            label: "Postgres",
            icon: "database",
            href: "/admin/observability/infrastructure/postgres",
            status: worst ? "warn" : "ok",
          },
          {
            key: "valkey",
            label: "Valkey",
            icon: "database",
            href: "/admin/observability/infrastructure/valkey",
            status: worst ? "bad" : "ok",
          },
          {
            key: "nats",
            label: "NATS",
            icon: "topology-star-3",
            href: "/admin/observability/infrastructure/nats",
            status: quiet ? "ok" : worst ? undefined : "warn",
          },
        ]}
        apps={apps}
      />
    </LocaleProvider>
  );
};
