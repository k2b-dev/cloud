import { readAppRegistrySnapshot } from "@valentinkolb/cloud";
import { type AuthContext, getLocale } from "@valentinkolb/cloud/server";
import { latestGatewayRouteSnapshot } from "@valentinkolb/cloud/services";
import { AdminLayout } from "@valentinkolb/cloud/ssr";
import { DEFAULT_TELEMETRY_RANGE, isTelemetryRange, TELEMETRY_RANGES, type TelemetryRange } from "../observability/telemetry/contracts";

const TELEMETRY_RANGE_KEYS = Object.keys(TELEMETRY_RANGES) as TelemetryRange[];

/** Keeps the current path and any search filter while swapping the window. */
const rangeUrl = (url: URL, range: TelemetryRange): string => {
  const params = new URLSearchParams(url.searchParams);
  if (range === DEFAULT_TELEMETRY_RANGE) params.delete("range");
  else params.set("range", range);
  const query = params.toString();
  return query ? `${url.pathname}?${query}` : url.pathname;
};

import { ButtonLink, DataTable, type DataTableColumn, NoticeCard, StatCell, StatGrid, StatusBadge } from "@k2b/ui";
import { formatNumber as fmtCount, formatDurationMs as fmtMs } from "@valentinkolb/cloud/shared";
import { SearchBar } from "@valentinkolb/cloud/ssr/islands";
import { type AppRuntimeStatus, buildAppRuntimeStatuses } from "../app-runtime-status";
import { ssr } from "../config";
import { getTelemetryAppTotals, getTelemetryPrefixTotals } from "../observability/telemetry/service";
import { listRegisteredAppStatus, type RegisteredAppStatus } from "../registered-apps";
import RemoveRegisteredAppButton from "./RemoveRegisteredAppButton.island";
import { gatewayOpsMessages, type GatewayOpsMessages } from "../messages";

// ── Helpers ──────────────────────────────────────────────────────────────────

const APP_ICON_CLASSES = "bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400";

const timeAgo = (ts: number, t: GatewayOpsMessages) => {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return t.justNow;
  if (s < 60) return t.secondsAgo({ count: s });
  if (s < 3600) return t.minutesAgo({ count: Math.floor(s / 60) });
  return t.hoursAgo({ count: Math.floor(s / 3600) });
};

const fmtUptime = (ms: number) => {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
};

const Check = () => <i class="ti ti-check text-emerald-500 text-xs" />;
const Dash = () => <i class="ti ti-minus text-zinc-300 dark:text-zinc-600 text-xs" />;

type GatewayAppRow = RegisteredAppStatus & {
  traffic: { count: number; totalMs: number; errors: number } | undefined;
  isHealthy: boolean;
  upSince: number;
  runtimeStatus: AppRuntimeStatus;
};

type GatewayRouteRow = {
  prefix: string;
  appId: string;
  count: number;
  errors: number;
};

// ── Page ─────────────────────────────────────────────────────────────────────

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = gatewayOpsMessages.resolve([locale]);
  const url = new URL(c.req.url);
  const isRoutesPage = url.pathname.endsWith("/routes");
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
  const appTraffic = new Map(
    [...appTotals].map(([appId, totals]) => [
      appId,
      { appId, count: totals.requests, errors: totals.errors, totalMs: (totals.avgDurationMs ?? 0) * totals.requests },
    ]),
  );
  const routeHits = new Map(
    [...prefixTotals].map(([prefix, totals]) => [prefix, { prefix, count: totals.requests, errors: totals.errors, lastSeen: 0 }]),
  );
  const windowRequests = [...appTotals.values()].reduce((sum, totals) => sum + totals.requests, 0);
  const unmatchedRequests = appTotals.get("gateway")?.requests ?? 0;
  const registeredApps = await listRegisteredAppStatus(registry.apps);
  const runtimeStatuses = buildAppRuntimeStatuses(registry.apps, registry.issues);
  const visibleApps = registeredApps.filter((a) => a.id !== "gateway" && a.id !== "gateway-router");

  const navOf = (app: RegisteredAppStatus) => app.live?.nav ?? app.nav;
  const capabilitiesOf = (app: RegisteredAppStatus) => app.live?.capabilities ?? app.capabilities;
  const withNav = visibleApps.filter((a) => navOf(a)?.href);
  const withAdmin = visibleApps.filter((a) => navOf(a)?.adminHref);
  const withCapabilities = visibleApps.filter((a) => capabilitiesOf(a));
  const appCount = visibleApps.length;
  const offlineCount = visibleApps.filter((a) => !a.isOnline).length;

  const appRows = visibleApps
    .map((app) => {
      const traffic = appTraffic.get(app.id);
      const fresh = Boolean(app.live && app.live.expiresAt - Date.now() > 30_000);
      const currentRuntimeStatus = runtimeStatuses.get(app.id);
      const runtimeStatus: AppRuntimeStatus = {
        status: currentRuntimeStatus?.status ?? "ok",
        signals: [...(currentRuntimeStatus?.signals ?? [])],
      };
      if (!app.isOnline) {
        runtimeStatus.status = "error";
        runtimeStatus.signals = [...runtimeStatus.signals, t.noLiveHeartbeat];
      } else if (!fresh && runtimeStatus.status === "ok") {
        runtimeStatus.status = "warn";
        runtimeStatus.signals = [...runtimeStatus.signals, t.heartbeatExpiresSoon];
      }
      const isHealthy = runtimeStatus.status === "ok";
      const upSince = app.live ? Math.max(0, Date.now() - app.live.createdAt) : app.offlineForMs;
      return { ...app, traffic, isHealthy, upSince, runtimeStatus };
    })
    .sort((a, b) => Number(b.isOnline) - Number(a.isOnline) || (b.traffic?.count ?? 0) - (a.traffic?.count ?? 0));
  const healthy = appRows.filter((app) => app.isHealthy);

  // Route data with hit counts, server-side filtered
  const searchQuery = url.searchParams.get("search")?.toLowerCase().trim() ?? "";
  const allRoutes = (routerSnapshot?.routes ?? [])
    .map((r) => {
      const hit = routeHits.get(r.prefix);
      return { prefix: r.prefix, appId: r.appId, count: hit?.count ?? 0, errors: hit?.errors ?? 0 };
    })
    .sort((a, b) => b.count - a.count);
  const filteredRoutes = searchQuery ? allRoutes.filter((r) => r.prefix.includes(searchQuery) || r.appId.includes(searchQuery)) : allRoutes;
  const appColumns: DataTableColumn<GatewayAppRow>[] = [
    { id: "app", header: t.app, value: (app) => app.name },
    { id: "status", header: t.status, value: (app) => app.isOnline, headerClass: "text-center", cellClass: "text-center" },
    { id: "runtime", header: t.release, value: (app) => (app.live?.runtime ?? app.runtime)?.release },
    { id: "baseUrl", header: t.baseUrl, value: (app) => app.baseUrl },
    { id: "nav", header: t.navigation, value: (app) => app.nav?.href, headerClass: "text-center", cellClass: "text-center" },
    { id: "admin", header: t.admin, value: (app) => app.nav?.adminHref, headerClass: "text-center", cellClass: "text-center" },
    {
      id: "capabilities",
      header: t.capabilities,
      value: (app) => app.capabilities,
      headerClass: "text-center",
      cellClass: "text-center",
    },
    {
      id: "heartbeat",
      header: t.heartbeat,
      value: (app) => app.updatedAt,
      headerClass: "text-right",
      cellClass: "text-right whitespace-nowrap",
    },
    {
      id: "upSince",
      header: t.upSince,
      value: (app) => app.upSince,
      headerClass: "text-right",
      cellClass: "text-right whitespace-nowrap",
    },
    {
      id: "requests",
      header: t.requests,
      value: (app) => app.traffic?.count,
      headerClass: "text-right",
      cellClass: "text-right tabular-nums",
    },
    {
      id: "latency",
      header: t.latency,
      value: (app) => (app.traffic ? app.traffic.totalMs / app.traffic.count : null),
      headerClass: "text-right",
      cellClass: "text-right tabular-nums",
    },
    {
      id: "errors",
      header: t.errors,
      subtitle: range,
      value: (app) => app.traffic?.errors,
      headerClass: "text-right",
      cellClass: "text-right tabular-nums",
    },
    {
      id: "actions",
      header: <span class="sr-only">{t.actions}</span>,
      headerClass: "text-right",
      cellClass: "text-right whitespace-nowrap max-w-none",
    },
  ];
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
  const title = isRoutesPage ? t.gatewayRoutesTitle : t.gatewayAppsTitle;
  return () => (
    <AdminLayout c={c} title={title}>
      <div class="app-rows">
        <div class="min-w-0" style="view-transition-name: admin-gateway-title">
          <h1 class="text-base font-semibold text-primary">{title}</h1>
          <p class="mt-1 text-xs text-dimmed">
            {isRoutesPage ? t.gatewayRoutesDescription : t.gatewayAppsDescription}
          </p>
        </div>

        <nav class="flex flex-wrap items-center gap-1" aria-label={t.trafficWindow}>
          <span class="mr-1 text-[10px] text-dimmed">{t.trafficWindow}</span>
          {TELEMETRY_RANGE_KEYS.map((option) => (
            <ButtonLink
              href={rangeUrl(url, option)}
              variant={option === range ? "primary" : "secondary"}
              size="sm"
              aria-current={option === range ? "true" : undefined}
            >
              {option}
            </ButtonLink>
          ))}
        </nav>

        {/* ── Stats — see skills/cloud-app/references/frontend.md § Stats ── */}
        <StatGrid columns={6}>
          <StatCell value={appCount} label={t.apps} sub={t.navAdminSummary({ nav: withNav.length, admin: withAdmin.length })} />
          <StatCell
            value={routerSnapshot?.routeCount ?? 0}
            label={t.gatewayRoutesTitle}
            sub={routerSnapshot ? `v${routerSnapshot.tableVersion}` : t.noRouter}
          />
          <StatCell
            value={fmtCount(windowRequests)}
            label={t.requests}
            sub={unmatchedRequests > 0 ? t.unmatchedRequests({ count: fmtCount(unmatchedRequests), range }) : range}
            href={`/admin/observability/telemetry?range=${range}`}
            accent={unmatchedRequests > 0 ? { tone: "amber", icon: "ti ti-alert-triangle" } : undefined}
          />
          <StatCell value={withCapabilities.length} label={t.capabilities} sub={t.providers} />
          <StatCell
            value={routerSnapshot ? fmtUptime(Date.now() - routerSnapshot.startedAt) : "—"}
            label={t.uptime}
            sub={
              routerSnapshot
                ? t.sinceTime({ time: new Date(routerSnapshot.startedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) })
                : t.noRouterSnapshot
            }
          />
          <StatCell
            value={`${healthy.length}/${appCount}`}
            label={t.healthy}
            sub={
              healthy.length === appCount ? t.allSystems : t.healthSummary({ offline: offlineCount, degraded: appCount - healthy.length - offlineCount })
            }
            accent={healthy.length === appCount ? { tone: "emerald", icon: "ti ti-check" } : { tone: "red", icon: "ti ti-alert-circle" }}
          />
        </StatGrid>

        {/* ── Apps Table ── */}
        {!isRoutesPage ? (
          <section class="paper overflow-hidden">
            {registry.issues.length > 0 ? (
              <NoticeCard
                tone="danger"
                title={t.invalidRegistryEntries({ count: registry.issues.length })}
                detail={registry.issues.map((issue) => `${issue.key}: ${issue.reason}`).join(" · ")}
                class="m-3"
              />
            ) : null}
            <div class="flex flex-col gap-2 px-3 py-3">
              <div>
                <h2 class="text-xs font-semibold text-primary">{t.apps}</h2>
                <p class="text-[10px] text-dimmed">{t.registeredApps({ count: appRows.length })}</p>
              </div>
            </div>
            <DataTable
              rows={appRows}
              columns={appColumns}
              getRowId={(app) => app.id}
              hoverRows
              highlightColumns={false}
              rowClass={(app) =>
                app.runtimeStatus.status === "error"
                  ? "bg-red-50/50 dark:bg-red-950/20"
                  : app.runtimeStatus.status === "warn"
                    ? "bg-amber-50/50 dark:bg-amber-950/20"
                    : ""
              }
              class="overflow-x-auto"
              tableClass="w-full text-sm"
              renderCell={({ row: app, col }) => {
                if (col.id === "app") {
                  return (
                    <div class="flex items-center gap-2">
                      <div class={`w-6 h-6 rounded grid place-items-center shrink-0 ${APP_ICON_CLASSES}`}>
                        <i class={`${app.icon} text-[10px]`} />
                      </div>
                      <span class="font-medium text-primary text-xs">{app.name}</span>
                      <code class="text-[9px] text-dimmed">{app.id}</code>
                    </div>
                  );
                }
                if (col.id === "baseUrl") return <code class="text-[10px] text-dimmed">{app.baseUrl}</code>;
                if (col.id === "status") {
                  const label = !app.isOnline
                    ? t.offline
                    : app.runtimeStatus.status === "error"
                      ? t.incompatible
                      : app.runtimeStatus.status === "warn"
                        ? t.degraded
                        : t.live;
                  return (
                    <div class="flex max-w-64 flex-col items-center gap-1">
                      <StatusBadge
                        tone={app.runtimeStatus.status === "warn" ? "warning" : app.runtimeStatus.status}
                        label={label}
                        title={app.runtimeStatus.signals.join("\n") || undefined}
                      />
                      {app.runtimeStatus.signals.length > 0 ? (
                        <span class="text-[9px] leading-tight text-dimmed">{app.runtimeStatus.signals[0]}</span>
                      ) : null}
                    </div>
                  );
                }
                if (col.id === "runtime") {
                  const runtime = app.live?.runtime ?? app.runtime;
                  return (
                    <div class="flex flex-col whitespace-nowrap">
                      <code class="text-[10px] text-primary">{runtime?.release ?? t.unknown}</code>
                      <span class="text-[9px] text-dimmed">Sync {runtime?.syncVersion ?? t.unknown}</span>
                    </div>
                  );
                }
                if (col.id === "nav") return navOf(app)?.href ? <Check /> : <Dash />;
                if (col.id === "admin") {
                  const adminHref = navOf(app)?.adminHref;
                  return adminHref ? (
                    <a href={adminHref} class="text-emerald-500 hover:text-emerald-700">
                      <i class="ti ti-check text-xs" />
                    </a>
                  ) : (
                    <Dash />
                  );
                }
                if (col.id === "capabilities") return capabilitiesOf(app) ? <Check /> : <Dash />;
                if (col.id === "heartbeat") {
                  return (
                    <span class={`text-[10px] ${app.isHealthy ? "text-emerald-600 dark:text-emerald-400" : "text-red-500"}`}>
                      <i class={`ti ${app.isHealthy ? "ti-heartbeat" : "ti-alert-triangle"} text-[9px]`} />{" "}
                      {app.isOnline ? timeAgo(app.live!.updatedAt, t) : t.lastSeen({ value: timeAgo(app.lastSeenAt, t) })}
                    </span>
                  );
                }
                if (col.id === "upSince") {
                  return (
                    <span
                      class={`text-[10px] tabular-nums ${app.isHealthy ? "text-dimmed" : "text-red-500"}`}
                      title={new Date(app.live?.createdAt ?? app.lastSeenAt).toLocaleString(locale)}
                    >
                      {fmtUptime(app.upSince)}
                    </span>
                  );
                }
                if (col.id === "requests")
                  return <span class="text-xs text-dimmed">{app.traffic ? fmtCount(app.traffic.count) : "—"}</span>;
                if (col.id === "latency") {
                  return (
                    <span class="text-xs tabular-nums text-dimmed">
                      {app.traffic && app.traffic.count > 0 ? fmtMs(app.traffic.totalMs / app.traffic.count) : "—"}
                    </span>
                  );
                }
                if (col.id === "errors") {
                  return app.traffic && app.traffic.errors > 0 ? (
                    <span class="text-xs tabular-nums text-red-500">
                      {app.traffic.errors} <span class="text-[9px]">({((app.traffic.errors / app.traffic.count) * 100).toFixed(0)}%)</span>
                    </span>
                  ) : (
                    <span class="text-xs text-dimmed">—</span>
                  );
                }
                if (col.id === "actions") {
                  return <RemoveRegisteredAppButton id={app.id} name={app.name} disabled={app.isOnline} />;
                }
                return "";
              }}
            />
          </section>
        ) : null}

        {/* ── Routes: title + search + table (same pattern as logs) ── */}
        {isRoutesPage ? (
          <section class="paper overflow-hidden">
            <div class="flex flex-col gap-2 px-3 py-3">
              <div>
                <h2 class="text-xs font-semibold text-primary">{t.gatewayRoutesTitle}</h2>
                <p class="text-[10px] text-dimmed">
                  {searchQuery ? t.filteredRoutesCount({ count: filteredRoutes.length, total: allRoutes.length }) : t.routesCount({ count: allRoutes.length })}
                </p>
              </div>
              <SearchBar
                action="/admin/gateway/routes"
                value={searchQuery}
                placeholder={t.filterRoutes}
                ariaLabel={t.filterRoutesLabel}
              />
            </div>
            <DataTable
              rows={filteredRoutes}
              columns={routeColumns}
              getRowId={(route) => route.prefix}
              hoverRows
              highlightColumns={false}
              density="compact"
              class="overflow-x-auto"
              empty={t.noMatchingRoutes({ query: searchQuery })}
              renderCell={({ row: route, col }) => {
                if (col.id === "prefix") return <code class="text-[10px] text-primary">{route.prefix}</code>;
                if (col.id === "app") return <span class="text-[10px] text-dimmed">{route.appId}</span>;
                if (col.id === "hits")
                  return <span class="text-[10px] text-dimmed">{route.count > 0 ? route.count.toLocaleString(locale) : "—"}</span>;
                if (col.id === "errors") {
                  return route.errors > 0 ? (
                    <span class="text-[10px] tabular-nums text-red-500">{route.errors}</span>
                  ) : (
                    <span class="text-[10px] text-dimmed">—</span>
                  );
                }
                return "";
              }}
            />
          </section>
        ) : null}
      </div>
    </AdminLayout>
  );
});
