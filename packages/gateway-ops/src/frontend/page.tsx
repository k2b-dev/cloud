import { readAppRegistrySnapshot } from "@k2b/cloud";
import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { formatNumber as fmtCount } from "@k2b/cloud/shared";
import { latestGatewayRouteSnapshot } from "@k2b/cloud/services";
import { SearchBar } from "@k2b/cloud/ssr/islands";
import { DataTable, type DataTableColumn, StatCell, StatGrid } from "@k2b/ui";
import { ssr } from "../config";
import { gatewayOpsMessages } from "../messages";
import { areaText, ObservabilityArea, ObservabilityPane, readAttention } from "../observability/_components/ObservabilityArea";
import { DEFAULT_TELEMETRY_RANGE, isTelemetryRange, TELEMETRY_RANGES, type TelemetryRange } from "../observability/telemetry/contracts";
import { getTelemetryAppTotals, getTelemetryPrefixTotals } from "../observability/telemetry/service";
import RangeTabs from "./RangeTabs";

const TELEMETRY_RANGE_KEYS = Object.keys(TELEMETRY_RANGES) as TelemetryRange[];

/** Keeps the current path and any search filter while swapping the window. */
const rangeUrl = (url: URL, range: TelemetryRange): string => {
  const params = new URLSearchParams(url.searchParams);
  if (range === DEFAULT_TELEMETRY_RANGE) params.delete("range");
  else params.set("range", range);
  const query = params.toString();
  return query ? `${url.pathname}?${query}` : url.pathname;
};

const fmtUptime = (ms: number, locale: string) => {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${fmtCount(ms / 3_600_000, { locale, decimals: 1 })}h`;
};

type GatewayRouteRow = {
  prefix: string;
  appId: string;
  count: number;
  errors: number;
};

// ── Page ─────────────────────────────────────────────────────────────────────

/**
 * Routes across all apps: the router's table with the traffic of each prefix. The per-app view lives in
 * Administration › Apps, where every app ID here leads.
 */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const dateConfig = getDateConfig(c);
  const { t } = gatewayOpsMessages.resolve([locale]);
  const url = new URL(c.req.url);
  const range = isTelemetryRange(url.searchParams.get("range"))
    ? (url.searchParams.get("range") as TelemetryRange)
    : DEFAULT_TELEMETRY_RANGE;
  const [registry, routerSnapshot, appTotals, prefixTotals] = await Promise.all([
    readAppRegistrySnapshot(),
    latestGatewayRouteSnapshot(),
    // Router counters are cumulative since the process started, so a long-lived
    // router reports a healthy lifetime average while it is failing right now.
    // Traffic numbers come from windowed telemetry rollups instead; the router
    // snapshot still owns the route table itself.
    getTelemetryAppTotals(range),
    getTelemetryPrefixTotals(range),
  ]);
  const routeHits = new Map([...prefixTotals].map(([prefix, totals]) => [prefix, { count: totals.requests, errors: totals.errors }]));
  const windowRequests = [...appTotals.values()].reduce((sum, totals) => sum + totals.requests, 0);
  const unmatchedRequests = appTotals.get("gateway")?.requests ?? 0;
  const withCapabilities = registry.apps.filter((app) => app.id !== "gateway" && app.id !== "gateway-router" && app.capabilities);

  // Route data with hit counts, server-side filtered
  const searchQuery = url.searchParams.get("search")?.toLowerCase().trim() ?? "";
  const allRoutes = (routerSnapshot?.routes ?? [])
    .map((r) => {
      const hit = routeHits.get(r.prefix);
      return { prefix: r.prefix, appId: r.appId, count: hit?.count ?? 0, errors: hit?.errors ?? 0 };
    })
    .sort((a, b) => b.count - a.count);
  const filteredRoutes = searchQuery ? allRoutes.filter((r) => r.prefix.includes(searchQuery) || r.appId.includes(searchQuery)) : allRoutes;
  const routeColumns: DataTableColumn<GatewayRouteRow>[] = [
    { id: "prefix", header: t.prefix, value: (route) => route.prefix },
    { id: "app", header: t.app, value: (route) => route.appId },
    {
      id: "hits",
      header: t.hits,
      subtitle: range,
      value: (route) => route.count,
      headerClass: "text-right",
      cellClass: "text-right tabular-nums",
    },
    { id: "errors", header: t.errors, value: (route) => route.errors, headerClass: "text-right", cellClass: "text-right tabular-nums" },
  ];
  const attention = await readAttention();
  return () => (
    <ObservabilityArea c={c} locale={locale} section="gateway" attention={attention}>
      <ObservabilityPane label={areaText(locale).gateway} description={t.gatewayRoutesDescription}>
        <RangeTabs
          caption={t.trafficWindow}
          label={t.trafficWindow}
          current={range}
          items={TELEMETRY_RANGE_KEYS.map((option) => ({ id: option, href: rangeUrl(url, option) }))}
        />

        {/* ── Stats — see skills/cloud-app/references/frontend.md § Stats ── */}
        <StatGrid columns={4}>
          <StatCell
            value={routerSnapshot?.routeCount ?? 0}
            label={t.gatewayRoutesTitle}
            sub={routerSnapshot ? `v${routerSnapshot.tableVersion}` : t.noRouter}
          />
          <StatCell
            value={fmtCount(windowRequests, { locale })}
            label={t.requests}
            sub={unmatchedRequests > 0 ? t.unmatchedRequests({ count: fmtCount(unmatchedRequests, { locale }), range }) : range}
            href={`/admin/observability/telemetry?range=${range}`}
            accent={unmatchedRequests > 0 ? { tone: "amber", icon: "ti ti-alert-triangle" } : undefined}
          />
          <StatCell value={withCapabilities.length} label={t.capabilities} sub={t.providers} />
          <StatCell
            value={routerSnapshot ? fmtUptime(Date.now() - routerSnapshot.startedAt, locale) : "—"}
            label={t.uptime}
            sub={
              routerSnapshot
                ? t.sinceTime({
                    time: new Date(routerSnapshot.startedAt).toLocaleTimeString(locale, {
                      hour: "2-digit",
                      minute: "2-digit",
                      timeZone: dateConfig.timeZone,
                    }),
                  })
                : t.noRouterSnapshot
            }
          />
        </StatGrid>

        {/* ── Routes: title + search + table (same pattern as logs) ── */}
        <DataTable.Panel>
          <DataTable.Header
            title={t.gatewayRoutesTitle}
            subtitle={
              searchQuery
                ? t.filteredRoutesCount({
                    count: fmtCount(filteredRoutes.length, { locale }),
                    total: fmtCount(allRoutes.length, { locale }),
                  })
                : t.routesCount({ count: allRoutes.length })
            }
          />
          <DataTable.Controls>
            <SearchBar
              placeholder={t.filterRoutes}
              ariaLabel={t.filterRoutesLabel}
              action={rangeUrl(new URL("/admin/observability/gateway/routes", url), range)}
              value={searchQuery}
            />
          </DataTable.Controls>
          <DataTable
            rows={filteredRoutes}
            columns={routeColumns}
            getRowId={(route) => route.prefix}
            hoverRows
            highlightColumns={false}
            density="compact"
            surface="plain"
            empty={t.noMatchingRoutes({ query: searchQuery })}
            renderCell={({ row: route, col }) => {
              if (col.id === "prefix") return <code class="text-[10px] text-primary">{route.prefix}</code>;
              if (col.id === "app")
                return (
                  <a class="text-[10px] text-dimmed hover:underline" href={`/admin/apps?app=${encodeURIComponent(route.appId)}`}>
                    {route.appId}
                  </a>
                );
              if (col.id === "hits")
                return <span class="text-[10px] text-dimmed">{route.count > 0 ? fmtCount(route.count, { locale }) : "—"}</span>;
              if (col.id === "errors") {
                return route.errors > 0 ? (
                  <span class="text-[10px] tabular-nums text-red-500">{fmtCount(route.errors, { locale })}</span>
                ) : (
                  <span class="text-[10px] text-dimmed">—</span>
                );
              }
              return "";
            }}
          />
        </DataTable.Panel>
      </ObservabilityPane>
    </ObservabilityArea>
  );
});
