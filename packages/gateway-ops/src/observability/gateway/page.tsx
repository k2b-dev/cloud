import { listApps } from "@k2b/cloud";
import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { latestGatewayRouteSnapshot } from "@k2b/cloud/services";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { gatewayOpsMessages } from "../../messages";
import { observabilityAdminNav } from "../_components/admin-nav";
import type { KeyCell } from "../_components/KeyCells";
import { areaText, readAttention } from "../_components/ObservabilityArea";
import { getTelemetryAppTotals, getTelemetryPrefixTotals } from "../telemetry/service";
import RoutesScreen from "./_components/RoutesScreen.island";
import { ROUTES_SEARCH_MAX, routesQuery } from "./query";

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
  const registered = await listApps().catch(() => []);
  const apps = registered.map((app) => ({
    id: app.id,
    label: app.name || app.id,
    icon: app.icon?.replace(/^ti\s+(ti-)?/, "") || "apps",
  }));
  const query = routesQuery(locale, apps, params.get("app") ?? undefined);
  const parsed = query.parse(params);
  const state =
    parsed.state.search && parsed.state.search.length > ROUTES_SEARCH_MAX ? { ...parsed.state, search: undefined } : parsed.state;
  const range = state.filters.range.kind === "preset" ? state.filters.range.preset : "24h";

  const [snapshot, appTotals, prefixTotals, attention] = await Promise.all([
    latestGatewayRouteSnapshot(),
    getTelemetryAppTotals(range),
    getTelemetryPrefixTotals(range),
    readAttention(),
  ]);
  const number = (value: number) => value.toLocaleString(locale);
  const appOf = (id: string) => apps.find((app) => app.id === id) ?? { id, label: id, icon: "apps" };
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
  const providers = registered.filter((app) => app.id !== "gateway" && app.id !== "gateway-router" && app.capabilities).length;
  const cells: KeyCell[] = [
    {
      icon: "route",
      label: t.gatewayRoutesTitle,
      value: snapshot ? number(snapshot.routeCount) : "—",
      meta: snapshot ? `v${snapshot.tableVersion}` : t.noRouter,
    },
    {
      icon: "arrows-exchange",
      label: t.requests,
      value: number(windowRequests),
      meta: unmatched > 0 ? t.unmatchedRequests({ count: number(unmatched), range }) : range,
      tone: unmatched > 0 ? "warn" : undefined,
    },
    { icon: "plug", label: t.capabilities, value: number(providers), meta: t.providers },
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
      />
    </AdminLayout>
  );
});
