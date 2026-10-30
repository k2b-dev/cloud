import { buildRuntimeFromRegistry, type ProcessSync, readAppRegistrySnapshot, startProcessSync, watchAppRegistry } from "@k2b/cloud";
import { env } from "@k2b/cloud/config";
import { readAppDomains } from "@k2b/cloud/contracts/app-domains";
import type { EnvSettingStatus } from "@k2b/cloud/contracts/settings-env";
import {
  buildGatewayRouteSnapshot,
  logger,
  publishGatewayRouteSnapshot,
  removeGatewayRouteSnapshot,
  superviseRuntimeTask,
} from "@k2b/cloud/services";
import { get } from "@k2b/cloud/services/settings";
import { readEnvSettingsStatus } from "@k2b/cloud/services/settings/env-status";
import { sql } from "bun";
import { cloudHostSet, type DomainSnapshot } from "./app-domains";
import { gatewayRouter } from "./config";
import { type AppRouteWarning, buildAppRoutesDetailed } from "./routes";
import { getRouteTable, setRouteTable, stats } from "./stats";
import { buildRouteTable } from "./trie";

const log = logger("gateway");

let domainSnapshot: DomainSnapshot = { cloudHosts: new Set(), domains: new Map(), apps: new Map(), development: env.IS_DEVELOPMENT };
let certResolver = "le";
export const getDomainSnapshot = (): DomainSnapshot => domainSnapshot;
export const getIngressCertResolver = (): string => certResolver;

let currentRuntime = buildRuntimeFromRegistry([]);
let lastRouteHash = "";
let refreshGeneration = 0;
let lastWarningsHash = "";
let lastRouteWarnings: AppRouteWarning[] = [];
let watcherAbort: AbortController | null = null;
let watcherTask: Promise<void> | null = null;
let processSync: ProcessSync | null = null;
// Keep the 30-second presence lease and request counters fresh even when no
// application registry entries change. Also reconcile routing if a registry
// watcher misses a restart notification.
const SNAPSHOT_INTERVAL_MS = 5_000;
let snapshotTimer: ReturnType<typeof setInterval> | null = null;
let snapshotTask: Promise<void> | null = null;
const startedAt = Date.now();

export const getCurrentRuntime = () => currentRuntime;

let envDiagnostics: EnvSettingStatus[] | undefined;
let envDiagnosticsTask: Promise<void> | null = null;
const refreshEnvDiagnostics = (): void => {
  if (envDiagnosticsTask) return;
  envDiagnostics = undefined;
  envDiagnosticsTask = readEnvSettingsStatus()
    .then(
      (status) => {
        envDiagnostics = status;
      },
      () => {
        envDiagnostics = undefined;
      },
    )
    .finally(() => {
      envDiagnosticsTask = null;
    });
};
const publishSnapshot = async (routeHash: string, routeWarnings: AppRouteWarning[]): Promise<void> => {
  const currentDiagnostics = envDiagnostics;
  refreshEnvDiagnostics();
  await publishGatewayRouteSnapshot(
    buildGatewayRouteSnapshot({
      instanceId: gatewayRouter.id,
      envSettings: currentDiagnostics,
      baseUrl: gatewayRouter.baseUrl,
      startedAt,
      routeHash,
      routeWarnings,
      table: getRouteTable(),
      stats,
    }),
  );
};

export const refreshRoutes = async (): Promise<void> => {
  const generation = ++refreshGeneration;
  try {
    // A confirmed invalid snapshot closes its routes, even when every record was rejected.
    // Transport failures still retain the last table through the catch below.
    const [{ apps }, domains, publicUrl, resolver] = await Promise.all([
      readAppRegistrySnapshot(),
      readAppDomains(sql),
      get<string>("app.url"),
      get<string>("gateway.ingress_cert_resolver"),
    ]);
    if (generation !== refreshGeneration) return;
    domainSnapshot = {
      cloudHosts: cloudHostSet(publicUrl, [gatewayRouter.baseUrl], env.IS_DEVELOPMENT),
      domains: new Map(domains.map((domain) => [domain.host, domain])),
      apps: new Map(apps.map((app) => [app.id, app])),
      development: env.IS_DEVELOPMENT,
    };
    certResolver = resolver;
    const { routes: appRoutes, warnings } = buildAppRoutesDetailed(apps);
    const routeHash = JSON.stringify(
      appRoutes.map((r) => [r.prefix, r.appId, r.baseUrl, r.installable]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    const warningsHash = JSON.stringify(warnings);

    if (routeHash !== lastRouteHash) {
      lastRouteHash = routeHash;
      const table = buildRouteTable(appRoutes);
      setRouteTable(table);
      log.info(`Route table rebuilt: ${table.routeCount} routes from ${apps.length} apps`);
    }

    if (warningsHash !== lastWarningsHash) {
      lastWarningsHash = warningsHash;
      lastRouteWarnings = warnings;
      for (const warning of warnings) {
        log.warn("Skipped app route", warning);
      }
    }

    currentRuntime = buildRuntimeFromRegistry(apps);
    await publishSnapshot(routeHash, lastRouteWarnings);
  } catch (error) {
    log.error("Route refresh failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const startRegistryWatcher = (): void => {
  if (watcherTask) return;
  watcherAbort = new AbortController();
  const signal = watcherAbort.signal;
  watcherTask = superviseRuntimeTask({
    name: "Gateway registry watcher",
    signal,
    run: (signal) => watchAppRegistry({ signal, onChange: refreshRoutes }),
    onError: ({ error, failureCount, retryInMs }) =>
      log.error("Registry watcher failed; restarting", {
        error: error instanceof Error ? error.message : String(error),
        failureCount,
        retryInMs,
      }),
  });
};

export const gatewayRuntime = {
  setup: async (): Promise<void> => {
    // The router is not a defineApp() app, so it owns its process Sync instance itself.
    processSync = await startProcessSync({ application: "gateway" });
    await refreshRoutes();
  },

  start: async (): Promise<void> => {
    startRegistryWatcher();
    snapshotTimer ??= setInterval(() => {
      if (snapshotTask) return;
      snapshotTask = refreshRoutes()
        .catch((error) => log.error("Route snapshot renewal failed", { error: error instanceof Error ? error.message : String(error) }))
        .finally(() => {
          snapshotTask = null;
        });
    }, SNAPSHOT_INTERVAL_MS);
  },

  stop: async (): Promise<void> => {
    if (snapshotTimer) clearInterval(snapshotTimer);
    snapshotTimer = null;
    watcherAbort?.abort();
    await watcherTask;
    watcherAbort = null;
    watcherTask = null;
    await snapshotTask;
    await removeGatewayRouteSnapshot(gatewayRouter.id);
    await processSync?.stop();
    processSync = null;
  },
};
