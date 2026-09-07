import { buildRuntimeFromRegistry, listApps, type ProcessSync, startProcessSync, watchAppRegistry } from "@valentinkolb/cloud";
import {
  buildGatewayRouteSnapshot,
  logger,
  publishGatewayRouteSnapshot,
  removeGatewayRouteSnapshot,
  superviseRuntimeTask,
} from "@valentinkolb/cloud/services";
import { gatewayRouter } from "./config";
import { type AppRouteWarning, buildAppRoutesDetailed } from "./routes";
import { getRouteTable, setRouteTable, stats } from "./stats";
import { buildRouteTable } from "./trie";

const log = logger("gateway");

let currentRuntime = buildRuntimeFromRegistry([]);
let lastRouteHash = "";
let lastWarningsHash = "";
let lastRouteWarnings: AppRouteWarning[] = [];
let watcherAbort: AbortController | null = null;
let watcherTask: Promise<void> | null = null;
let processSync: ProcessSync | null = null;
// Keep the 30-second presence lease and request counters fresh even when no
// application registry entries change. This restores the previous 5s cadence.
const SNAPSHOT_INTERVAL_MS = 5_000;
let snapshotTimer: ReturnType<typeof setInterval> | null = null;
let snapshotTask: Promise<void> | null = null;
const startedAt = Date.now();

export const getCurrentRuntime = () => currentRuntime;

const publishSnapshot = async (routeHash: string, routeWarnings: AppRouteWarning[]): Promise<void> => {
  await publishGatewayRouteSnapshot(
    buildGatewayRouteSnapshot({
      instanceId: gatewayRouter.id,
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
  try {
    const apps = await listApps();
    const { routes: appRoutes, warnings } = buildAppRoutesDetailed(apps);
    const routeHash = JSON.stringify(appRoutes.map((r) => `${r.prefix}:${r.baseUrl}`).sort());
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

    await publishSnapshot(routeHash, lastRouteWarnings);
    currentRuntime = buildRuntimeFromRegistry(apps);
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
      snapshotTask = publishSnapshot(lastRouteHash, lastRouteWarnings)
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
