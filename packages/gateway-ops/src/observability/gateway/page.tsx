import { listApps } from "@k2b/cloud";
import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { latestGatewayRouteSnapshot } from "@k2b/cloud/services";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { gatewayOpsMessages } from "../../messages";
import { observabilityAdminNav } from "../_components/admin-nav";
import type { KeyCell } from "../_components/KeyCells";
import { areaText, readAttention } from "../_components/ObservabilityArea";
import { getTelemetryAppTotals, getTelemetryPrefixTotals, getTelemetryTimeseries, type TelemetryTotals } from "../telemetry/service";
import RoutesScreen from "./_components/RoutesScreen.island";
import { ROUTES_SEARCH_MAX, routesQuery } from "./query";

/** Bars the hero's history draws at most. */
const TREND_BARS = 12;

/** Apps the context column lists by their requests; the table shows every prefix. */
const BY_APP = 12;

/** Uptime in the largest whole unit that says it: seconds, minutes, hours, days. */
const uptime = (ms: number, locale: string) => {
  const units: [Intl.NumberFormatOptions["unit"], number][] = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
    ["second", 1000],
  ];
  const [unit, size] = units.find(([, step]) => ms >= step) ?? units[3]!;
  return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "short", maximumFractionDigits: 0 }).format(
    Math.floor(ms / size),
  );
};

/**
 * Gateway routes on v2: the router's table with the traffic of each prefix in the window. Router counters are
 * cumulative since its start, so a long-lived router would report a healthy lifetime average while it fails now;
 * traffic comes from the windowed telemetry rollups, the table itself from the router's snapshot.
 */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = gatewayOpsMessages.resolve([locale]);
  const dateConfig = getDateConfig(c);
  const params = new URL(c.req.url).searchParams;
  // The address needs no app list to be read: an app it names stands as an option of its own.
  const parsed = routesQuery(locale, [], params.get("app") ?? undefined).parse(params);
  const state =
    parsed.state.search && parsed.state.search.length > ROUTES_SEARCH_MAX ? { ...parsed.state, search: undefined } : parsed.state;
  const range = state.filters.range.kind === "preset" ? state.filters.range.preset : "24h";

  // Traffic that cannot be read leaves the router's table standing and says so in its place.
  const traffic = Promise.all([getTelemetryAppTotals(range), getTelemetryPrefixTotals(range)]).then(
    ([apps, prefixes]) => ({ apps, prefixes, error: null as string | null }),
    (error: unknown) => ({
      apps: new Map<string, TelemetryTotals>(),
      prefixes: new Map<string, TelemetryTotals>(),
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  const [registered, snapshot, totals, timeseries, attention] = await Promise.all([
    listApps().catch(() => []),
    // a router snapshot that cannot be read shows as none, as before the first one
    latestGatewayRouteSnapshot().catch(() => null),
    traffic,
    // the requests per interval of the window, for the hero's history; the same rollup read as the overview's
    getTelemetryTimeseries({ range }).catch(() => []),
    readAttention(),
  ]);
  const appTotals = totals.apps;
  const prefixTotals = totals.prefixes;
  const registeredApps = registered.map((app) => ({
    id: app.id,
    label: app.name || app.id,
    icon: app.icon?.replace(/^ti\s+(ti-)?/, "") || "apps",
    color: app.appearance?.accent,
  }));
  // Every app the window or the table names is a filter option: one that stopped or left the registry stands by its id.
  const seen = new Set(registeredApps.map((app) => app.id));
  const apps = [
    ...registeredApps,
    ...[...appTotals.keys(), ...(snapshot?.routes ?? []).map((route) => route.appId)]
      .filter((id) => id !== "gateway" && !seen.has(id) && (seen.add(id), true))
      .map((id) => ({ id, label: id, icon: "apps", color: undefined as string | undefined })),
  ];
  const number = (value: number) => value.toLocaleString(locale);
  const appOf = (id: string) => apps.find((app) => app.id === id) ?? { id, label: id, icon: "apps", color: undefined };
  const needle = state.search?.toLowerCase();
  const all = (snapshot?.routes ?? [])
    .map((route) => ({ ...route, totals: prefixTotals.get(route.prefix) }))
    .sort((left, right) => (right.totals?.requests ?? 0) - (left.totals?.requests ?? 0) || left.prefix.localeCompare(right.prefix));
  const rows = all
    .filter((route) => !state.filters.app || route.appId === state.filters.app)
    .filter((route) => !needle || route.prefix.toLowerCase().includes(needle) || route.appId.toLowerCase().includes(needle))
    .map((route) => ({
      prefix: route.prefix,
      app: appOf(route.appId),
      requests: route.totals?.requests ? number(route.totals.requests) : "—",
      errors: number(route.totals?.errors ?? 0),
      failing: (route.totals?.errors ?? 0) > 0,
    }));

  const windowRequests = [...appTotals.values()].reduce((sum, totals) => sum + totals.requests, 0);
  // requests the router could not give to any app are counted under the gateway itself
  const unmatched = appTotals.get("gateway")?.requests ?? 0;
  // k2b-ui gap: a Cells.Cell trend of more than about twelve bars runs over a long value in a narrow cell; neighbouring
  // intervals are summed until at most twelve bars stand, so the history stays real and keeps beside its figure
  const hourly = timeseries.map((point) => point.requests);
  const step = Math.ceil(hourly.length / TREND_BARS);
  const requestSeries = Array.from({ length: Math.ceil(hourly.length / step) }, (_, index) =>
    hourly.slice(index * step, index * step + step).reduce((sum, value) => sum + value, 0),
  );
  // three cells beside the context column, so the hero keeps room for its history
  const cells: KeyCell[] = [
    // k2b-ui gap: hero band (look.md rule 1); until it lands the requests of the window lead, with their real history
    {
      icon: "arrows-exchange",
      label: t.requests,
      value: totals.error ? "—" : number(windowRequests),
      meta: totals.error ? t.unavailable : unmatched > 0 ? t.unmatchedRequests({ count: number(unmatched), range }) : range,
      tone: unmatched > 0 ? "warn" : undefined,
      trend:
        requestSeries.length > 1
          ? {
              values: requestSeries,
              label: t.requestsTrend({ total: number(windowRequests), peak: number(Math.max(...requestSeries)) }),
            }
          : undefined,
    },
    {
      icon: "route",
      label: t.gatewayRoutesTitle,
      value: snapshot ? number(snapshot.routeCount) : "—",
      meta: snapshot ? `v${snapshot.tableVersion}` : t.noRouter,
    },
    {
      icon: "clock",
      label: t.uptime,
      value: snapshot ? uptime(Date.now() - snapshot.startedAt, locale) : "—",
      meta: snapshot
        ? t.sinceTime({
            time: new Date(snapshot.startedAt).toLocaleTimeString(locale, {
              hour: "2-digit",
              minute: "2-digit",
              timeZone: dateConfig.timeZone,
            }),
          })
        : t.noRouterSnapshot,
    },
  ];

  return () => (
    <AdminLayout c={c} ui="v2" title={areaText(locale).gateway}>
      <RoutesScreen
        nav={observabilityAdminNav(c, locale, attention, "gateway")}
        apps={apps.map((app) => ({ id: app.id, label: app.label }))}
        state={state}
        cells={cells}
        warnings={(snapshot?.routeWarnings ?? []).map(
          (warning) => `${warning.prefix} · ${warning.appId}: ${warning.reason}${warning.detail ? ` (${warning.detail})` : ""}`,
        )}
        rows={rows}
        total={all.length}
        trafficError={totals.error}
        // the apps by their requests in the window, from the totals already read; the gateway's own unmatched ones stay out
        byApp={[...appTotals.entries()]
          .filter(([id, totals]) => id !== "gateway" && totals.requests > 0)
          .sort((left, right) => right[1].requests - left[1].requests)
          .slice(0, BY_APP)
          .map(([id, totals]) => ({ ...appOf(id), requests: totals.requests }))}
      />
    </AdminLayout>
  );
});
