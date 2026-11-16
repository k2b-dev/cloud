import {
  buildRuntimeFromRegistry,
  type ProcessSync,
  readAppRegistrySnapshot,
  sql,
  startProcessSync,
  watchAppRegistry,
  watchAppRegistryRemovals,
} from "@k2b/cloud";
import { env } from "@k2b/cloud/config";
import { readAppDomains } from "@k2b/cloud/contracts/app-domains";
import type { EnvSettingStatus } from "@k2b/cloud/contracts/settings-env";
import {
  buildGatewayRouteSnapshot,
  logger,
  publishGatewayRouteSnapshot,
  removeGatewayRouteSnapshot,
  superviseRuntimeTask,
  watchGatewayDomainChanges,
} from "@k2b/cloud/services";
import { maintenanceNeedsRenewal, renewMaintenanceState, watchMaintenanceState } from "@k2b/cloud/services/maintenance-state";
import { get } from "@k2b/cloud/services/settings";
import { readEnvSettingsStatus } from "@k2b/cloud/services/settings/env-status";
import { cloudHostSet, type DomainSnapshot } from "./app-domains";
import { appIconKey, availability, tintAppIcon } from "./availability";
import { gatewayRouter } from "./config";
import { type AppRouteWarning, buildAppRoutesDetailed } from "./routes";
import { getRouteTable, setRouteTable, stats } from "./stats";
import { buildRouteTable } from "./trie";

const log = logger("gateway");
// Keep the configured development entry address usable alongside saved app.url overrides.
const configuredGatewayUrls = [...gatewayRouter.internalUrls, ...(env.IS_DEVELOPMENT && env.APP_URL ? [env.APP_URL] : [])];

let domainSnapshot: DomainSnapshot = {
  cloudHosts: cloudHostSet(env.APP_URL ?? "localhost:3000", configuredGatewayUrls, env.IS_DEVELOPMENT),
  domains: new Map(),
  domainsReady: false,
  apps: new Map(),
  development: env.IS_DEVELOPMENT,
};
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
// Renew the 90-second presence lease and reconcile missed hints every 30 seconds.
const SNAPSHOT_INTERVAL_MS = 30_000;
let domainWatcherTask: Promise<void> | null = null;
let maintenanceWatcherTask: Promise<void> | null = null;
let removalWatcherTask: Promise<void> | null = null;
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
    const { apps } = await readAppRegistrySnapshot();
    if (generation !== refreshGeneration) return;
    domainSnapshot = { ...domainSnapshot, apps: new Map(apps.map((app) => [app.id, app])) };
    availability.updateApps(apps);
    refreshIcons();
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

// Domain/settings database failures must not hold back the registry or its presence lease.
// Retain the last durable assignment snapshot, including removals, until a read succeeds.
let domainTask: Promise<void> | null = null;
let lastDomainSnapshotHash = "";
export const refreshDomains = (): Promise<void> => {
  domainTask ??= (async () => {
    try {
      const [domains, publicUrl, resolver] = await Promise.all([
        readAppDomains(sql),
        get<string>("app.url"),
        get<string>("gateway.ingress_cert_resolver"),
      ]);
      const cloudHosts = cloudHostSet(publicUrl, configuredGatewayUrls, env.IS_DEVELOPMENT);
      const snapshotHash = JSON.stringify([
        [...cloudHosts].sort(),
        domains.map(({ host, appId, redirectTo, createdAt }) => [host, appId, redirectTo, createdAt]).sort(),
      ]);
      if (snapshotHash !== lastDomainSnapshotHash) {
        lastDomainSnapshotHash = snapshotHash;
        for (const { host, appId } of domains) {
          if (cloudHosts.has(host))
            log.warn("App domain conflicts with a Cloud or internal gateway host; excluded from ingress", { host, appId });
        }
      }
      domainSnapshot = {
        ...domainSnapshot,
        cloudHosts,
        domains: new Map(domains.map((domain) => [domain.host, domain])),
        domainsReady: true,
      };
      certResolver = resolver;
    } catch (error) {
      log.error("Domain refresh failed; retaining the last snapshot", { error: error instanceof Error ? error.message : String(error) });
    }
  })().finally(() => {
    domainTask = null;
  });
  return domainTask;
};

// ─── What the gateway shows while the Cloud or an app is away ───────────────

/** Generated app favicons are small SVGs; anything larger is not one. */
const MAX_APP_ICON_BYTES = 16 * 1024;
/** Matches the image settings Core stores as `data:` URIs; a larger logo falls back to the letter tile. */
const MAX_CLOUD_LOGO_CHARS = 512 * 1024;
const ICON_FETCH_TIMEOUT_MS = 3_000;
const BRANDING_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/]+=*$/;

const fetchAppIcon = async (baseUrl: string, appId: string, accent: string | undefined): Promise<string | undefined> => {
  const url = new URL(`/public/${encodeURIComponent(appId)}/favicon.svg`, baseUrl);
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(ICON_FETCH_TIMEOUT_MS) });
  if (!response.ok || !(response.headers.get("Content-Type") ?? "").startsWith("image/svg+xml")) {
    await response.body?.cancel();
    return undefined;
  }
  const declared = Number(response.headers.get("Content-Length") ?? "0");
  if (declared > MAX_APP_ICON_BYTES) {
    await response.body?.cancel();
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > MAX_APP_ICON_BYTES) return undefined;
    chunks.push(chunk);
  }
  if (size === 0) return undefined;
  const svg = tintAppIcon(Buffer.concat(chunks).toString("utf8"), accent);
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
};

let iconTask: Promise<void> | null = null;
/** One fetch per app build, one app at a time, off the request path. */
const refreshIcons = (): void => {
  if (iconTask) return;
  iconTask = (async () => {
    for (const app of availability.iconsDue()) {
      let src: string | undefined;
      try {
        src = await fetchAppIcon(app.baseUrl, app.id, app.appearance?.accent);
      } catch {
        src = undefined;
      }
      availability.setIcon(app.id, appIconKey(app), src);
    }
  })().finally(() => {
    iconTask = null;
  });
};

let brandingTask: Promise<void> | null = null;
/** Name, logo, time zone and default locale for the maintenance page; the last good values stay on failure. */
const refreshBranding = (): Promise<void> => {
  brandingTask ??= (async () => {
    try {
      const [name, logo, timeZone, locale] = await Promise.all([
        get<string>("app.name"),
        get<string>("app.logo"),
        get<string>("app.timezone"),
        get<string>("app.locale"),
      ]);
      let zone = "UTC";
      try {
        zone = new Intl.DateTimeFormat("en", { timeZone: timeZone || "UTC" }).resolvedOptions().timeZone;
      } catch {
        zone = "UTC";
      }
      availability.setBranding({
        name: name?.trim() || "Cloud",
        ...(logo && logo.length <= MAX_CLOUD_LOGO_CHARS && BRANDING_IMAGE.test(logo) ? { logo } : {}),
        timeZone: zone,
        locale: locale || "en",
      });
    } catch (error) {
      log.error("Branding refresh failed; retaining the last values", { error: error instanceof Error ? error.message : String(error) });
    }
  })().finally(() => {
    brandingTask = null;
  });
  return brandingTask;
};

/** Maintenance never ends by itself: keep its 7-day lease alive while it is on. */
const renewMaintenance = (): void => {
  const observed = availability.observedMaintenance();
  if (!observed || !maintenanceNeedsRenewal(observed.updatedAt)) return;
  void renewMaintenanceState().catch((error) =>
    log.error("Maintenance lease renewal failed", { error: error instanceof Error ? error.message : String(error) }),
  );
};

const startMaintenanceWatchers = (signal: AbortSignal): void => {
  maintenanceWatcherTask ??= superviseRuntimeTask({
    name: "Gateway maintenance watcher",
    signal,
    run: (signal) =>
      watchMaintenanceState({
        signal,
        onChange: (observed) => {
          const before = availability.maintenance();
          if (availability.setMaintenance(observed)) log.info("Maintenance mode started");
          else if (before && !observed) log.info("Maintenance mode ended");
          renewMaintenance();
        },
      }),
    // The last known state stays in memory while NATS is unreachable.
    onError: ({ error }) => log.error("Maintenance watcher failed; restarting", { error: String(error) }),
  });
  removalWatcherTask ??= superviseRuntimeTask({
    name: "Gateway app removal watcher",
    signal,
    run: (signal) => watchAppRegistryRemovals({ signal, onRemoval: availability.noteRemoval }),
    onError: ({ error }) => log.error("App removal watcher failed; restarting", { error: String(error) }),
  });
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
    void refreshDomains();
    void refreshBranding();
  },

  start: async (): Promise<void> => {
    startRegistryWatcher();
    domainWatcherTask ??= superviseRuntimeTask({
      name: "Gateway domain watcher",
      signal: watcherAbort!.signal,
      run: (signal) =>
        watchGatewayDomainChanges({
          signal,
          onChange: async () => {
            // A hint during a read can describe a commit newer than that read's snapshot.
            await domainTask;
            await refreshDomains();
          },
        }),
      onError: ({ error }) => log.error("Domain watcher failed; restarting", { error: String(error) }),
    });
    startMaintenanceWatchers(watcherAbort!.signal);
    snapshotTimer ??= setInterval(() => {
      void refreshDomains();
      void refreshBranding();
      renewMaintenance();
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
    await Promise.all([watcherTask, domainWatcherTask, maintenanceWatcherTask, removalWatcherTask]);
    domainWatcherTask = null;
    maintenanceWatcherTask = null;
    removalWatcherTask = null;
    watcherAbort = null;
    watcherTask = null;
    await snapshotTask;
    await domainTask;
    await brandingTask;
    await iconTask;
    await removeGatewayRouteSnapshot(gatewayRouter.id);
    await processSync?.stop();
    processSync = null;
  },
};
