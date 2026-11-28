import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { logging, type TraceWindow, trace } from "@k2b/cloud/services";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { gatewayOpsMessages } from "../messages";
import { observabilityAdminNav } from "./_components/admin-nav";
import { INFRA_HREF } from "./_components/InfrastructureTabs";
import type { KeyCell } from "./_components/KeyCells";
import { readAttention, readHealth } from "./_components/ObservabilityArea";
import type { FailingRoute, OverviewApp } from "./_components/OverviewScreen";
import OverviewScreen from "./_components/OverviewScreen.island";
import { opsCharts } from "./_components/ops-chart";
import { readInfraStates } from "./infrastructure/sections";
import { BAD_ROUTE_SHARE, buildOverviewSignals, overviewQuery, overviewVerdict } from "./overview";
import { TELEMETRY_RANGES } from "./telemetry/contracts";
import { getTelemetryOverview, getTelemetryTimeseries, listTelemetryRoutes } from "./telemetry/service";

/** Routes the overview lists; Telemetry lists them all. */
const FAILING_ROUTES = 5;

/** Reports a source that could not be read instead of rendering it as zero. */
const settled = async <T,>(load: () => Promise<T>, fallback: T): Promise<{ value: T; error: string | null }> => {
  try {
    return { value: await load(), error: null };
  } catch (error) {
    return { value: fallback, error: error instanceof Error ? error.message : String(error) };
  }
};

const iconOf = (icon: string | undefined) => icon?.replace(/^ti\s+(ti-)?/, "") || "apps";

/**
 * Operations at a glance on v2: the window's statement, the server errors with their history as the hero, the signals
 * that need someone, the failing routes and the log severity; beside them the services and the apps with their state.
 */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = gatewayOpsMessages.resolve([locale]);
  const number = (value: number) => value.toLocaleString(locale);
  const query = overviewQuery(locale);
  const { state } = query.parse(new URL(c.req.url).searchParams);
  const range = state.filters.range.kind === "preset" ? state.filters.range.preset : "24h";
  // jobs keep no six-hour window: the next longer one
  const jobsWindow: TraceWindow = range === "6h" ? "12h" : range;

  const [health, telemetry, telemetryTimeseries, failingRoutes, logSummary, logTimeseries, jobStats, attention, infra] = await Promise.all([
    // the health the area shares for 30 s (its sidebar dots read the same), not a second build per load
    settled(() => readHealth(), null),
    settled(() => getTelemetryOverview({ range }), null),
    settled(() => getTelemetryTimeseries({ range }), []),
    settled(() => listTelemetryRoutes({ range }, "errorRate", { errorsOnly: true, slowOnly: false }), []),
    settled(() => logging.summary(), null),
    settled(() => logging.timeseries({ sinceHours: TELEMETRY_RANGES[range].hours }), []),
    settled(() => trace.stats({ filter: { window: jobsWindow } }), null),
    readAttention(),
    // The three services' states: a probe of Postgres, Valkey and NATS, each bounded by the first picture's budget and
    // shared by the area's pages for 30 s, so a call probes them at most once per 30 s per process.
    readInfraStates(),
  ]);

  const offlineApps = health.value?.apps.filter((app) => app.status !== "ok") ?? [];
  const signals = buildOverviewSignals(
    {
      range,
      jobsWindow,
      offlineApps: offlineApps.map((app) => app.id),
      serverErrors: telemetry.value?.serverErrors ?? 0,
      rateLimited: telemetry.value?.rateLimited ?? 0,
      failedRuns: jobStats.value?.failed ?? 0,
      stuckRuns: jobStats.value?.stuck ?? 0,
      logErrors: logSummary.value?.errors24h ?? 0,
      unavailable: {
        apps: health.error ?? undefined,
        telemetry: telemetry.error ?? telemetryTimeseries.error ?? failingRoutes.error ?? undefined,
        runs: jobStats.error ?? undefined,
        logs: logSummary.error ?? logTimeseries.error ?? undefined,
      },
    },
    locale,
  );
  const verdict = overviewVerdict(signals, locale);
  const telemetryHref = `/admin/observability/telemetry?range=${range}`;
  const share = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 });

  // The hero: the server errors of the window with their real history per interval. A figure that could not be read
  // says so instead of showing zero.
  const errorSeries = telemetryTimeseries.value.map((point) => point.serverErrors);
  const errorTotal = errorSeries.reduce((sum, value) => sum + value, 0);
  const hero: KeyCell = {
    icon: "alert-circle",
    label: t.serverErrors,
    value: telemetry.value ? number(telemetry.value.serverErrors) : "—",
    meta: telemetry.value
      ? t.shareOfRequests({
          rate: share.format(telemetry.value.requests > 0 ? telemetry.value.serverErrors / telemetry.value.requests : 0),
          requests: number(telemetry.value.requests),
        })
      : t.unavailable,
    tone: (telemetry.value?.serverErrors ?? 0) > 0 ? "bad" : undefined,
    href: `${telemetryHref}&only=errors`,
    trend:
      errorSeries.length > 1
        ? { values: errorSeries, label: t.serverErrorsTrend({ total: number(errorTotal), peak: number(Math.max(...errorSeries)) }) }
        : undefined,
  };
  // three cells beside the context column: the hero and the two volumes a person reads it against
  const cells: KeyCell[] = [
    hero,
    {
      icon: "apps",
      label: t.appsOnline,
      value: health.value ? `${health.value.apps.length - offlineApps.length}/${health.value.apps.length}` : "—",
      meta: health.error ? t.unavailable : t.registeredAppsLabel,
    },
    {
      icon: "player-play",
      label: t.runs,
      value: jobStats.value ? number(jobStats.value.runs) : "—",
      meta: jobStats.value ? jobsWindow : t.unavailable,
    },
  ];

  const interval =
    logTimeseries.value.length > 1
      ? logTimeseries.value[1]!.at.getTime() - logTimeseries.value[0]!.at.getTime()
      : TELEMETRY_RANGES[range].bucketSeconds * 1000;
  const [logChart] = opsCharts(
    [
      {
        kind: "line",
        title: t.logSeverityOverTime,
        description: t.logSeverityDescription,
        maxGap: interval,
        error: logTimeseries.error,
        series: [
          { label: t.warnings, data: logTimeseries.value.map((point) => ({ x: point.at.getTime(), y: point.warn })) },
          { label: t.errors, data: logTimeseries.value.map((point) => ({ x: point.at.getTime(), y: point.error })) },
        ],
      },
    ],
    locale,
  );

  // names, signs and colours of the apps come from the health snapshot the page already read
  const appOf = (id: string) => {
    const app = health.value?.apps.find((candidate) => candidate.id === id);
    return { label: app?.name || id, icon: iconOf(app?.icon), color: app?.accent };
  };
  const rate = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  const routes = {
    error: failingRoutes.error,
    href: `${telemetryHref}&only=errors`,
    rows: failingRoutes.value.slice(0, FAILING_ROUTES).map(
      (row): FailingRoute => ({
        key: `${row.appId}:${row.route}`,
        route: row.route,
        app: appOf(row.appId),
        errors: number(row.errors),
        requests: number(row.requests),
        rate: rate.format(row.requests > 0 ? row.errors / row.requests : 0),
        bad: row.requests > 0 && row.errors / row.requests >= BAD_ROUTE_SHARE,
        href: `${telemetryHref}&app=${encodeURIComponent(row.appId)}&route=${encodeURIComponent(row.route)}`,
      }),
    ),
  };
  // every registered app with its state; health already reads them all, so this costs no read of its own
  const appRows: OverviewApp[] | null = health.value
    ? health.value.apps.map((app) => ({
        id: app.id,
        label: app.name,
        icon: iconOf(app.icon),
        color: app.accent,
        status: app.status === "ok" ? "ok" : app.online ? "warn" : "bad",
      }))
    : null;

  return () => (
    <AdminLayout c={c} ui="v2" title={t.observability}>
      <OverviewScreen
        nav={observabilityAdminNav(c, locale, attention, "home")}
        state={state}
        verdict={{ label: verdict.label, description: verdict.description }}
        cells={cells}
        // the hero already says how many server errors there are and leads to them
        signals={signals.filter((signal) => signal.id !== "server-errors")}
        logs={
          logChart && {
            chart: logChart,
            empty: t.noLogEntries,
            href: `/admin/observability/logs?time=last-${range}`,
            linkLabel: t.openLogs,
          }
        }
        routes={routes}
        services={[
          { key: "postgres", label: "Postgres", icon: "database", href: INFRA_HREF.postgres, status: infra.postgres },
          { key: "valkey", label: "Valkey", icon: "database", href: INFRA_HREF.valkey, status: infra.valkey },
          { key: "nats", label: "NATS", icon: "topology-star-3", href: INFRA_HREF.nats, status: infra.nats },
        ]}
        apps={appRows}
      />
    </AdminLayout>
  );
});
