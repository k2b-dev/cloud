import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { formatDurationMs as fmtMs, formatDateTime, formatNumber, formatPercent, formatRatio } from "@k2b/cloud/shared";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { listAppSloWindows } from "../../grids-operational-health";
import { gatewayOpsMessages } from "../../messages";
import type { KeyCell } from "../_components/KeyCells";
import { areaText, observabilityGroups, readAttention } from "../_components/ObservabilityArea";
import ObservabilityNavigation from "../_components/ObservabilityNavigation.island";
import { opsCharts } from "../_components/ops-chart";
import TelemetryScreen from "./_components/TelemetryScreen.island";
import { browserTelemetryPage } from "./browser/page";
import { DEFAULT_TELEMETRY_ROUTE_SORT, TELEMETRY_RANGES, TELEMETRY_ROUTE_SORTS, type TelemetryRange } from "./contracts";
import { browserHref, browserQuery, legacyTelemetryHref, telemetryHref, telemetryQuery } from "./query";
import {
  getTelemetryOverview,
  getTelemetryTimeseries,
  listTelemetryApps,
  listTelemetryEvents,
  listTelemetryRoutes,
  SLOW_REQUEST_MS,
} from "./service";

/** Individual requests shown once a route is selected. */
const DRILLDOWN_EVENT_LIMIT = 100;

/** Error rates only read as a problem above a floor; below it they are noise. */
const isProblemRate = (errors: number, requests: number) => requests >= 20 && errors / requests >= 0.05;

/** Server telemetry on v2. The address holds range, app, "only", the order and the open route. */
export default ssr<AuthContext>(async (c) => {
  const url = new URL(c.req.url);
  if (url.searchParams.get("view") === "browser") return browserTelemetryPage(c);
  const legacy = legacyTelemetryHref(url.searchParams);
  if (legacy) return c.redirect(legacy);
  const locale = getLocale(c);
  const dateConfig = getDateConfig(c);
  const { t } = gatewayOpsMessages.resolve([locale]);
  // The app the address names stays a value of its filter, so the address reads the same before the apps are known.
  const selectedApp = url.searchParams.get("app") ?? undefined;
  const address = telemetryQuery(locale, [], selectedApp).parse(url.searchParams);
  const state = address.state;
  const time = state.filters.range;
  const range: TelemetryRange = time.kind === "preset" ? time.preset : "24h";
  const appId = state.filters.app ?? "";
  const route = url.searchParams.get("route")?.trim() ?? "";
  const only = state.filters.only ?? [];
  const sort = TELEMETRY_ROUTE_SORTS.find((option) => option === state.sort.field) ?? DEFAULT_TELEMETRY_ROUTE_SORT;
  const filter = { range, appId: appId || undefined, route: route || undefined };

  const [overview, timeseries, routes, telemetryApps, events, sloWindows, attention] = await Promise.all([
    getTelemetryOverview(filter),
    getTelemetryTimeseries(filter),
    listTelemetryRoutes(filter, sort, { errorsOnly: only.includes("errors"), slowOnly: only.includes("slow") }),
    listTelemetryApps(range),
    // Raw events are only worth reading once a route is open.
    route ? listTelemetryEvents(filter, DRILLDOWN_EVENT_LIMIT) : Promise.resolve([]),
    // Availability objectives are per app, so they only mean something once the view is narrowed to one.
    appId ? listAppSloWindows(appId) : Promise.resolve([]),
    readAttention(),
  ]);
  const apps = telemetryApps.map((id) => ({ id, label: id }));
  const query = telemetryQuery(locale, apps, selectedApp);
  const number = (value: number) => formatNumber(value, { locale });
  const maxGap = TELEMETRY_RANGES[range].bucketSeconds * 1000;
  const at = (point: { at: string }) => new Date(point.at).getTime();
  const charts = opsCharts(
    [
      {
        kind: "line",
        title: t.requests,
        description: t.trafficDescription,
        maxGap,
        series: [{ label: t.requests, data: timeseries.map((point) => ({ x: at(point), y: point.requests })) }],
      },
      {
        kind: "line",
        title: t.errorRate,
        description: t.chartRateHelp,
        unit: "percent",
        maxGap,
        series: [
          {
            label: t.errorRate,
            data: timeseries
              .filter((point) => point.requests > 0)
              .map((point) => ({ x: at(point), y: (point.errors / point.requests) * 100 })),
          },
        ],
      },
      {
        kind: "line",
        title: t.latency,
        description: t.chartLatencyHelp,
        unit: "ms",
        maxGap,
        series: [
          {
            label: t.chartAverage,
            data: timeseries.flatMap((point) => (point.avgDurationMs === null ? [] : [{ x: at(point), y: point.avgDurationMs }])),
          },
          {
            label: t.chartMaximum,
            data: timeseries.flatMap((point) => (point.maxDurationMs === null ? [] : [{ x: at(point), y: point.maxDurationMs }])),
          },
        ],
      },
    ],
    locale,
  );
  const cells: KeyCell[] = [
    { icon: "arrows-exchange", label: t.requests, value: number(overview.requests), meta: range },
    {
      icon: "alert-circle",
      label: t.serverErrors,
      value: number(overview.serverErrors),
      meta: "5xx",
      tone: overview.serverErrors > 0 ? "bad" : undefined,
    },
    {
      icon: "hand-stop",
      label: t.clientErrors,
      value: number(overview.clientErrors),
      meta: `${t.rateLimited} (429): ${number(overview.rateLimited)}`,
      tone: overview.rateLimited > 0 ? "warn" : undefined,
    },
    {
      icon: "clock-exclamation",
      label: t.slow,
      value: number(overview.slowRequests),
      meta: `>= ${SLOW_REQUEST_MS}ms`,
      tone: overview.slowRequests > 0 ? "warn" : undefined,
    },
  ];
  const slo: KeyCell[] = sloWindows.map((window) => {
    const completeSeconds = window.window === "1h" ? 3600 : window.window === "6h" ? 21_600 : 2_592_000;
    const collecting = window.observedSeconds < completeSeconds * 0.95;
    const missed = !collecting && window.requestCount > 0 && window.availabilityRatio < 0.999;
    return {
      icon: missed ? "alert-circle" : "shield-check",
      label: window.window,
      value: window.requestCount === 0 ? t.noTraffic : formatPercent(window.availabilityRatio, { locale }),
      meta: collecting
        ? t.requestsCollecting({ count: number(window.requestCount) })
        : t.requestCountLabel({ count: number(window.requestCount) }),
      tone: missed ? "bad" : undefined,
    };
  });
  const statusTone = (status: number) => (status >= 500 ? "bad" : status >= 400 ? "warn" : null);
  const ignored = address.issues.length > 0 ? address.issues.map((issue) => `${issue.param}=${issue.value}`).join(", ") : null;
  const area = areaText(locale);
  const groups = observabilityGroups(c, locale, attention);
  const browser = browserQuery(locale, apps, selectedApp);

  return () => (
    <Layout
      c={c}
      fullWidth
      ui="v2"
      title={[{ title: t.start, href: "/" }, { title: area.area, href: "/admin/observability" }, { title: area.telemetry }]}
    >
      <ObservabilityNavigation label={area.area} current="telemetry" groups={groups} />
      <TelemetryScreen
        area={{ title: area.area, groups, markLabel: area.needsAttention }}
        apps={apps}
        state={state}
        ignored={ignored}
        browserHref={browserHref(browser, {
          ...browser.reset(),
          filters: { ...browser.reset().filters, range: time, app: state.filters.app },
        })}
        cells={cells}
        charts={charts}
        slo={slo}
        routes={routes.map((row) => ({
          key: `${row.appId} ${row.route}`,
          app: row.appId,
          route: row.route,
          requests: number(row.requests),
          errorRate: row.errors === 0 ? "—" : formatRatio(row.errors, row.requests, { locale, decimals: 1 }),
          problem: isProblemRate(row.errors, row.requests),
          errors: row.errors === 0 ? "—" : number(row.errors),
          slow: row.slowRequests === 0 ? "—" : number(row.slowRequests),
          hasSlow: row.slowRequests > 0,
          duration: `${fmtMs(row.avgDurationMs, { locale })} / ${fmtMs(row.maxDurationMs, { locale })}`,
          slowMax: row.maxDurationMs !== null && row.maxDurationMs >= SLOW_REQUEST_MS,
        }))}
        route={
          route
            ? {
                name: route,
                app: appId,
                summary: t.lastRequestsInRange({ count: DRILLDOWN_EVENT_LIMIT }),
                closeHref: telemetryHref(query, state),
                events: events.map((event) => ({
                  key: String(event.id),
                  time: formatDateTime(event.occurredAt, dateConfig),
                  method: event.method,
                  status: String(event.status),
                  tone: statusTone(event.status),
                  error: event.errorKind,
                  duration: fmtMs(event.durationMs, { locale }),
                  slow: event.durationMs >= SLOW_REQUEST_MS,
                })),
              }
            : null
        }
      />
    </Layout>
  );
});
