import { DataTable, type DataTableColumn, StatCell, StatGrid } from "@k2b/ui";
import { listAppsDetailed } from "@k2b/cloud";
import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { formatNumber as fmtCount, formatDurationMs as fmtMs, formatPercent as fmtRatio } from "@k2b/cloud/shared";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import ObservabilityChart from "../../frontend/ObservabilityChart.island";
import { listAppSloWindows } from "../../grids-operational-health";
import RouteDetailPanel from "./_components/RouteDetailPanel";
import TelemetryFilterBar, { type TelemetryAppFilterOption } from "./_components/TelemetryFilterBar.island";
import {
  buildTelemetryFilterUrl,
  closeRouteUrl,
  parseTelemetryFilterFromUrl,
  selectRouteUrl,
  type TelemetryFilter,
} from "./_components/types";
import {
  getTelemetryOverview,
  getTelemetryTimeseries,
  listTelemetryApps,
  listTelemetryEvents,
  listTelemetryRoutes,
  SLOW_REQUEST_MS,
  type TelemetryRouteRow,
  type TelemetryRouteSort,
} from "./service";
import { gatewayOpsMessages, type GatewayOpsMessages } from "../../messages";

/** Individual requests shown once a route is selected. */
const DRILLDOWN_EVENT_LIMIT = 100;

const fmtPercent = (part: number, total: number) => (total === 0 ? "—" : `${((part / total) * 100).toFixed(1)}%`);

const legacyTelemetryAppIcons: Record<string, string> = {
  gateway: "ti ti-route-scan",
  logging: "ti ti-list-details",
  notifications: "ti ti-bell-ringing",
  settings: "ti ti-settings",
};

const normalizeIcon = (icon: string | undefined) => {
  if (!icon) return "ti ti-app";
  return icon.startsWith("ti ") ? icon : `ti ${icon}`;
};

/** Error rates only read as a problem above a floor; below it they are noise. */
const isProblemRate = (errors: number, requests: number) => requests >= 20 && errors / requests >= 0.05;

/**
 * DataTable has no sorting of its own, so sortable headers are plain links
 * that swap the `sort` param — server-side ordering, no client state.
 */
const SortableHeader = (props: { filter: TelemetryFilter; sort: TelemetryRouteSort; label: string; t: GatewayOpsMessages }) => {
  const active = props.filter.sort === props.sort;
  return (
    <a
      href={buildTelemetryFilterUrl(props.filter, { sort: props.sort })}
      class={`inline-flex items-center gap-1 hover:text-primary ${active ? "text-primary" : "text-dimmed"}`}
      aria-label={props.t.sortBy({ label: props.label })}
      title={props.t.sortBy({ label: props.label })}
    >
      {props.label}
      {/* Inactive columns keep a dimmed marker so the whole row reads as sortable. */}
      <i class={`ti ti-arrow-down text-[9px] ${active ? "" : "opacity-30"}`} aria-hidden="true" />
    </a>
  );
};

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = gatewayOpsMessages.resolve([locale]);
  const filter = parseTelemetryFilterFromUrl(new URL(c.req.url));
  const sortLabel = filter.sort === "errorRate" ? t.errorRate : filter.sort === "errors" ? t.errors : filter.sort === "requests" ? t.requests : filter.sort === "slow" ? t.slow : t.duration;
  const query = { range: filter.range, appId: filter.appId || undefined, route: filter.route || undefined };

  const [overview, timeseries, routes, telemetryApps, registryApps, events, sloWindows] = await Promise.all([
    getTelemetryOverview(query),
    getTelemetryTimeseries(query),
    listTelemetryRoutes(query, filter.sort, { errorsOnly: filter.errorsOnly, slowOnly: filter.slowOnly }),
    listTelemetryApps(filter.range),
    listAppsDetailed(),
    // Raw events are only worth reading once the user picked a route.
    filter.route ? listTelemetryEvents(query, DRILLDOWN_EVENT_LIMIT) : Promise.resolve([]),
    // Availability objectives are per app, so they only mean something once
    // the view is narrowed to one.
    filter.appId ? listAppSloWindows(filter.appId) : Promise.resolve([]),
  ]);

  const registryById = new Map(registryApps.map((app) => [app.id, app]));
  const appOptions: TelemetryAppFilterOption[] = telemetryApps.map((id) => ({
    id,
    label: id,
    icon: normalizeIcon(registryById.get(id)?.icon ?? legacyTelemetryAppIcons[id]),
  }));

  const requestSeries = timeseries.map((point) => ({ x: new Date(point.at).getTime(), y: point.requests }));
  const errorSeries = timeseries.map((point) => ({ x: new Date(point.at).getTime(), y: point.errors }));

  const routeColumns: DataTableColumn<TelemetryRouteRow>[] = [
    { id: "route", header: t.route },
    { id: "requests", header: <SortableHeader filter={filter} sort="requests" label={t.requests} t={t} />, align: "right" },
    { id: "errors", header: <SortableHeader filter={filter} sort="errorRate" label={t.errorRate} t={t} />, align: "right" },
    { id: "errorCount", header: <SortableHeader filter={filter} sort="errors" label={t.errors} t={t} />, align: "right" },
    { id: "slow", header: <SortableHeader filter={filter} sort="slow" label={t.slow} t={t} />, align: "right" },
    { id: "duration", header: <SortableHeader filter={filter} sort="duration" label={t.averageMaximum} t={t} />, align: "right" },
  ];

  return () => (
    <AdminLayout c={c} title={t.telemetry}>
      <div class="app-rows">
        <div class="min-w-0" style="view-transition-name: admin-telemetry-title">
          <h1 class="text-base font-semibold text-primary">{t.telemetry}</h1>
          <p class="mt-1 text-xs text-dimmed">{t.telemetryDescription}</p>
        </div>

        <TelemetryFilterBar filter={filter} apps={appOptions} />

        <StatGrid columns={5}>
          <StatCell value={fmtCount(overview.requests, { locale })} label={t.requests} sub={filter.range} />
          <StatCell
            value={fmtCount(overview.serverErrors, { locale })}
            label={t.serverErrors}
            sub="5xx"
            valueClass={overview.serverErrors > 0 ? "text-red-500" : undefined}
            accent={overview.serverErrors > 0 ? { tone: "red", icon: "ti ti-alert-circle" } : undefined}
          />
          <StatCell value={fmtCount(overview.clientErrors, { locale })} label={t.clientErrors} sub="4xx excl. 429" />
          <StatCell
            value={fmtCount(overview.rateLimited, { locale })}
            label={t.rateLimited}
            sub="429"
            accent={overview.rateLimited > 0 ? { tone: "amber", icon: "ti ti-hand-stop" } : undefined}
          />
          <StatCell
            value={fmtCount(overview.slowRequests, { locale })}
            label={t.slow}
            sub={`>= ${SLOW_REQUEST_MS}ms`}
            accent={overview.slowRequests > 0 ? { tone: "amber", icon: "ti ti-clock-exclamation" } : undefined}
          />
        </StatGrid>

        <section class="paper p-3">
          <h2 class="text-xs font-semibold text-primary">{t.traffic}</h2>
          <p class="text-[10px] text-dimmed">{t.trafficDescription}</p>
          <ObservabilityChart
            kind="line"
            class="mt-2 h-72 w-full text-dimmed"
            series={[
              { label: t.requests, data: requestSeries },
              { label: t.errors, data: errorSeries },
            ]}
            xFormat="datetime"
            legend
            area
            interactive
          />
        </section>

        {sloWindows.length > 0 ? (
          <section class="paper p-3" aria-labelledby="request-slo-title">
            <h2 id="request-slo-title" class="text-xs font-semibold text-primary">
              {t.requestAvailability}
            </h2>
            <p class="text-[10px] text-dimmed">{t.requestAvailabilityDescription}</p>
            <StatGrid columns={3} size="sm">
              {sloWindows.map((window) => {
                const completeSeconds = window.window === "1h" ? 3600 : window.window === "6h" ? 21_600 : 2_592_000;
                const collecting = window.observedSeconds < completeSeconds * 0.95;
                const missed = !collecting && window.requestCount > 0 && window.availabilityRatio < 0.999;
                return (
                  <StatCell
                    label={window.window}
                    value={window.requestCount === 0 ? t.noTraffic : fmtRatio(window.availabilityRatio, { locale })}
                    sub={
                      collecting
                        ? t.requestsCollecting({ count: fmtCount(window.requestCount, { locale }) })
                        : t.requestCountLabel({ count: fmtCount(window.requestCount, { locale }) })
                    }
                    valueClass={missed ? "text-red-500" : "text-primary"}
                    accent={missed ? { tone: "red", icon: "ti ti-alert-circle" } : undefined}
                  />
                );
              })}
            </StatGrid>
          </section>
        ) : null}

        <div class={filter.route ? "grid min-h-0 gap-2 xl:grid-cols-[minmax(0,1fr)_24rem]" : "min-h-0"}>
          <section class="paper overflow-hidden">
            <div class="px-3 py-2">
              <h2 class="text-xs font-semibold text-primary">{t.gatewayRoutesTitle}</h2>
              <p class="text-[10px] text-dimmed">{t.sortedRoutesDescription({ sort: sortLabel.toLocaleLowerCase(locale) })}</p>
            </div>
            <DataTable
              rows={routes}
              columns={routeColumns}
              getRowId={(row) => `${row.appId} ${row.route}`}
              selectedRowId={filter.route ? `${filter.appId} ${filter.route}` : null}
              hoverRows
              highlightColumns={false}
              density="compact"
              class="overflow-x-auto"
              empty={t.noTrafficRange}
              renderCell={({ row, col }) => {
                if (col.id === "route")
                  return (
                    <a href={selectRouteUrl(filter, row.appId, row.route)} class="flex min-w-0 flex-col hover:text-primary">
                      <code class="truncate text-[10px] text-primary">{row.route}</code>
                      <span class="text-[9px] text-dimmed">{row.appId}</span>
                    </a>
                  );
                if (col.id === "requests") return <span class="text-[10px] tabular-nums text-dimmed">{fmtCount(row.requests, { locale })}</span>;
                if (col.id === "errors")
                  return (
                    <span
                      class={`text-[10px] tabular-nums ${isProblemRate(row.errors, row.requests) ? "text-red-500" : "text-dimmed"}`}
                      title={t.errorsOfRequests({ errors: fmtCount(row.errors, { locale }), requests: fmtCount(row.requests, { locale }) })}
                    >
                      {row.errors === 0 ? "—" : fmtPercent(row.errors, row.requests)}
                    </span>
                  );
                if (col.id === "errorCount")
                  return <span class="text-[10px] tabular-nums text-dimmed">{row.errors === 0 ? "—" : fmtCount(row.errors, { locale })}</span>;
                if (col.id === "slow")
                  return (
                    <span class={`text-[10px] tabular-nums ${row.slowRequests > 0 ? "text-amber-600 dark:text-amber-400" : "text-dimmed"}`}>
                      {row.slowRequests === 0 ? "—" : fmtCount(row.slowRequests, { locale })}
                    </span>
                  );
                if (col.id === "duration")
                  return (
                    <span class="text-[10px] tabular-nums text-dimmed">
                      {fmtMs(row.avgDurationMs, { locale })} <span class="text-dimmed/60">/</span>{" "}
                      <span
                        class={
                          row.maxDurationMs !== null && row.maxDurationMs >= SLOW_REQUEST_MS ? "text-amber-600 dark:text-amber-400" : ""
                        }
                      >
                        {fmtMs(row.maxDurationMs, { locale })}
                      </span>
                    </span>
                  );
                return "";
              }}
            />
          </section>

          {filter.route ? (
            <RouteDetailPanel
              route={filter.route}
              events={events}
              eventLimit={DRILLDOWN_EVENT_LIMIT}
              slowRequestMs={SLOW_REQUEST_MS}
              closeHref={closeRouteUrl(filter)}
            />
          ) : null}
        </div>
      </div>
    </AdminLayout>
  );
});
