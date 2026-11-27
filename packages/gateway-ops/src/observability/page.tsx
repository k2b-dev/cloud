import { listApps } from "@k2b/cloud";
import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { logging, type TraceWindow, trace } from "@k2b/cloud/services";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { alignCountSeries } from "../frontend/operational-charts";
import { buildGatewayHealth } from "../health";
import { gatewayOpsMessages } from "../messages";
import { observabilityAdminNav } from "./_components/admin-nav";
import type { KeyCell } from "./_components/KeyCells";
import { INFRA_HREF } from "./_components/InfrastructureTabs";
import { readAttention } from "./_components/ObservabilityArea";
import OverviewScreen from "./_components/OverviewScreen.island";
import { opsCharts } from "./_components/ops-chart";
import { readInfraStates } from "./infrastructure/sections";
import { buildOverviewSignals, overviewQuery, overviewVerdict } from "./overview";
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

/** Operations at a glance on v2: the window's statement, key figures, open signals, error charts and failing routes. */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = gatewayOpsMessages.resolve([locale]);
  const number = (value: number) => value.toLocaleString(locale);
  const query = overviewQuery(locale);
  const { state } = query.parse(new URL(c.req.url).searchParams);
  const range = state.filters.range.kind === "preset" ? state.filters.range.preset : "24h";
  // jobs keep no six-hour window: the next longer one
  const jobsWindow: TraceWindow = range === "6h" ? "12h" : range;

  const [health, telemetry, telemetryTimeseries, failingRoutes, logSummary, logTimeseries, jobStats, apps, attention, infra] = await Promise.all([
    settled(() => buildGatewayHealth(), null),
    settled(() => getTelemetryOverview({ range }), null),
    settled(() => getTelemetryTimeseries({ range }), []),
    settled(() => listTelemetryRoutes({ range }, "errorRate", { errorsOnly: true, slowOnly: false }), []),
    settled(() => logging.summary(), null),
    settled(() => logging.timeseries({ sinceHours: TELEMETRY_RANGES[range].hours }), []),
    settled(() => trace.stats({ filter: { window: jobsWindow } }), null),
    listApps().catch(() => []),
    readAttention(),
    // the three services' states, shared by the area's pages for 30 s, so a call does not probe them each time
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

  // A figure that could not be read says so instead of showing zero.
  const cells: KeyCell[] = [
    {
      icon: "apps",
      label: t.appsOnline,
      value: health.value ? `${health.value.apps.length - offlineApps.length}/${health.value.apps.length}` : "—",
      meta: health.error ? t.unavailable : t.registeredAppsLabel,
      tone: offlineApps.length > 0 ? "bad" : undefined,
    },
    {
      icon: "arrows-exchange",
      label: t.requests,
      value: telemetry.value ? number(telemetry.value.requests) : "—",
      meta: telemetry.value ? `${number(telemetry.value.slowRequests)} ${t.slowRequests}` : t.unavailable,
    },
    {
      icon: "player-play",
      label: t.failedRuns,
      value: jobStats.value ? number(jobStats.value.failed) : "—",
      meta: jobStats.value ? (jobStats.value.stuck > 0 ? t.stuckRunsTitle({ count: jobStats.value.stuck }) : jobsWindow) : t.unavailable,
      tone: (jobStats.value?.failed ?? 0) > 0 ? "warn" : undefined,
    },
    {
      icon: "file-alert",
      label: t.logWarnings,
      value: logSummary.value ? number(logSummary.value.warnings24h) : "—",
      meta: logSummary.value ? t.last24h : t.unavailable,
      tone: (logSummary.value?.warnings24h ?? 0) > 0 ? "warn" : undefined,
    },
  ];

  const interval =
    logTimeseries.value.length > 1
      ? logTimeseries.value[1]!.at.getTime() - logTimeseries.value[0]!.at.getTime()
      : TELEMETRY_RANGES[range].bucketSeconds * 1000;
  const telemetryHref = `/admin/observability/telemetry?range=${range}`;
  // each chart with the page it is looked at on
  const chartLinks = [
    { icon: "alert-circle", empty: t.noTrafficRange, href: telemetryHref, linkLabel: t.openTraffic },
    { icon: "file-alert", empty: t.noLogEntries, href: `/admin/observability/logs?time=last-${range}`, linkLabel: t.openLogs },
  ];
  const charts = opsCharts(
    [
      {
        kind: "line",
        title: t.serverErrors,
        description: t.serverErrorsDescription,
        maxGap: interval,
        error: telemetryTimeseries.error,
        series: [
          {
            label: t.errors,
            data: alignCountSeries(
              telemetryTimeseries.value.map((point) => ({ x: new Date(point.at).getTime(), y: point.serverErrors })),
              interval,
            ),
          },
        ],
      },
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
  ).flatMap((chart, index) => {
    const link = chartLinks[index];
    return link ? [{ chart, ...link }] : [];
  });

  const appOf = (id: string) => {
    const app = apps.find((candidate) => candidate.id === id);
    return { label: app?.name || id, icon: app?.icon?.replace(/^ti\s+(ti-)?/, "") || "apps" };
  };
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  const routes = {
    error: failingRoutes.error,
    href: `${telemetryHref}&only=errors`,
    rows: failingRoutes.value.slice(0, FAILING_ROUTES).map((row) => ({
      key: `${row.appId}:${row.route}`,
      route: row.route,
      app: appOf(row.appId),
      errors: number(row.errors),
      requests: number(row.requests),
      rate: percent.format(row.requests > 0 ? row.errors / row.requests : 0),
      href: `${telemetryHref}&app=${encodeURIComponent(row.appId)}&route=${encodeURIComponent(row.route)}`,
    })),
  };

  return () => (
    <AdminLayout c={c} ui="v2" title={t.observability}>
      <OverviewScreen
        nav={observabilityAdminNav(c, locale, attention, "home")}
        state={state}
        verdict={{ label: verdict.label, description: verdict.description }}
        signals={signals}
        cells={cells}
        charts={charts}
        routes={routes}
        services={[
          { key: "postgres", label: "Postgres", icon: "database", href: INFRA_HREF.postgres, status: infra.postgres },
          { key: "valkey", label: "Valkey", icon: "database", href: INFRA_HREF.valkey, status: infra.valkey },
          { key: "nats", label: "NATS", icon: "topology-star-3", href: INFRA_HREF.nats, status: infra.nats },
        ]}
      />
    </AdminLayout>
  );
});
