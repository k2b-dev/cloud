import { readAppRegistrySnapshot } from "@valentinkolb/cloud";
import { listGatewayRouteSnapshots } from "@valentinkolb/cloud/services";
import { buildAppRuntimeStatuses } from "./app-runtime-status";
import { getGridsOperationalSnapshot, gridsSloStatus, listAppSloWindows } from "./grids-operational-health";
import { getNatsInventorySummary } from "./observability/nats/service";
import { listRegisteredAppStatus } from "./registered-apps";
import { buildSyncOperationalHealth, type SyncOperationalHealth } from "./sync-operational-health";

export type GatewayHealthStatus = "ok" | "warn" | "error";

export type GatewayHealthApp = {
  id: string;
  name: string;
  icon: string;
  status: GatewayHealthStatus;
  online: boolean;
  healthy: boolean;
  lastSeenAt: string;
  offlineForMs: number;
  signals: string[];
  release?: string;
  syncVersion?: string;
};

export type GatewayHealth = {
  status: GatewayHealthStatus;
  checkedAt: string;
  /** Shared broker inspection remains relevant when webhook apps are scoped. */
  sync?: SyncOperationalHealth;
  summary: {
    apps: number;
    healthy: number;
    degraded: number;
    offline: number;
    routes: number;
    requests: number;
    errors: number;
    unmatchedRequests: number;
    gatewayInstances: number;
  };
  apps: GatewayHealthApp[];
};

export const scopeGatewayHealth = (health: GatewayHealth, scopeAppIds?: readonly string[]): GatewayHealth => {
  const scope = scopeAppIds === undefined ? null : new Set(scopeAppIds);
  const apps = scope ? health.apps.filter((app) => scope.has(app.id)) : health.apps;
  const healthy = apps.filter((app) => app.status === "ok").length;
  const offline = apps.filter((app) => !app.online).length;
  const degraded = apps.filter((app) => app.online && app.status !== "ok").length;
  const status: GatewayHealthStatus =
    health.summary.gatewayInstances === 0 || health.sync?.status === "error" || apps.some((app) => app.status === "error")
      ? "error"
      : degraded > 0 || health.sync?.status === "warn"
        ? "warn"
        : "ok";

  return {
    ...health,
    status,
    summary: {
      ...health.summary,
      apps: apps.length,
      healthy,
      degraded,
      offline,
    },
    apps,
  };
};

export const buildGatewayHealth = async (scopeAppIds?: readonly string[]): Promise<GatewayHealth> => {
  const checkedAt = new Date();
  const [registry, snapshots, gridsOperations, gridsSlo, natsInventory] = await Promise.all([
    readAppRegistrySnapshot(),
    listGatewayRouteSnapshots(),
    getGridsOperationalSnapshot(),
    listAppSloWindows("grids"),
    getNatsInventorySummary(),
  ]);
  const registeredApps = await listRegisteredAppStatus(registry.apps);
  const syncOperations = buildSyncOperationalHealth(
    natsInventory,
    registeredApps.map((app) => app.id),
    process.env.SYNC_NAMESPACE ?? "",
  );
  const runtimeStatuses = buildAppRuntimeStatuses(registry.apps, registry.issues);
  const latestSnapshot = snapshots.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;

  const apps = registeredApps.map<GatewayHealthApp>((app) => {
    const fresh = Boolean(app.live && app.live.expiresAt - Date.now() > 30_000);
    let status: GatewayHealthStatus = app.isOnline ? (fresh ? "ok" : "warn") : "error";
    const signals: string[] = [];
    const runtimeStatus = runtimeStatuses.get(app.id);
    if (runtimeStatus?.status === "error") status = "error";
    else if (runtimeStatus?.status === "warn" && status === "ok") status = "warn";
    signals.push(...(runtimeStatus?.signals ?? []));
    const syncStatus = syncOperations.apps.get(app.id);
    if (syncStatus?.status === "error") status = "error";
    else if (syncStatus?.status === "warn" && status === "ok") status = "warn";
    signals.push(...(syncStatus?.signals ?? []));
    if (app.id === "grids" && app.isOnline) {
      const sloStatus = gridsSloStatus(gridsSlo);
      if (gridsOperations?.status === "error" || sloStatus === "error") status = "error";
      else if (status === "ok" && (gridsOperations?.status === "warn" || sloStatus === "warn")) status = "warn";
      if (gridsOperations?.status === "error") signals.push("Grids processing needs intervention");
      else if (gridsOperations?.status === "warn") signals.push("Grids processing is delayed");
      if (sloStatus === "error") signals.push("Grids request availability is burning error budget quickly");
      else if (sloStatus === "warn") signals.push("Grids request availability is burning error budget");
    }
    return {
      id: app.id,
      name: app.name,
      icon: app.icon,
      status,
      online: app.isOnline,
      healthy: status === "ok",
      lastSeenAt: new Date(app.live?.updatedAt ?? app.lastSeenAt).toISOString(),
      offlineForMs: app.offlineForMs,
      signals,
      release: (app.live?.runtime ?? app.runtime)?.release,
      syncVersion: (app.live?.runtime ?? app.runtime)?.syncVersion,
    };
  });

  const knownAppIds = new Set(apps.map((app) => app.id));
  for (const [appId, runtimeStatus] of runtimeStatuses) {
    if (knownAppIds.has(appId)) continue;
    apps.push({
      id: appId,
      name: appId,
      icon: "ti ti-alert-triangle",
      status: runtimeStatus.status,
      online: true,
      healthy: false,
      lastSeenAt: checkedAt.toISOString(),
      offlineForMs: 0,
      signals: runtimeStatus.signals,
    });
  }

  const routeErrors = snapshots.reduce(
    (total, snapshot) => total + snapshot.stats.byRoute.reduce((sum, route) => sum + route.errors, 0),
    0,
  );

  return scopeGatewayHealth(
    {
      status: "ok",
      checkedAt: checkedAt.toISOString(),
      sync: syncOperations.infrastructure,
      summary: {
        apps: 0,
        healthy: 0,
        degraded: 0,
        offline: 0,
        routes: latestSnapshot?.routeCount ?? 0,
        requests: snapshots.reduce((total, snapshot) => total + snapshot.stats.totalRequests, 0),
        errors: routeErrors,
        unmatchedRequests: snapshots.reduce((total, snapshot) => total + snapshot.stats.noRouteCount, 0),
        gatewayInstances: snapshots.length,
      },
      apps,
    },
    scopeAppIds,
  );
};
