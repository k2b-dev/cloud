import type { Worker } from "@k2b/sync";
import { lazySync, listApps, listAppsDetailed, watchAppRegistry } from "@valentinkolb/cloud";
import type { AppLifecycle } from "@valentinkolb/cloud/contracts";
import { get as getSetting, logger, superviseRuntimeTask, trace } from "@valentinkolb/cloud/services";
import { runHealthWebhookCheck, startHealthWebhookDelivery, stopHealthWebhookDelivery } from "./health-webhooks";
import { migrate } from "./migrate";
import { listRegisteredAppStatus, markOfflineLogged, upsertRegisteredApps } from "./registered-apps";
import { cleanupTelemetry, consumeTelemetry } from "./telemetry";

const log = logger("gateway-ops");
const offlineLog = logger("gateway-ops:registered-apps");

const OFFLINE_AFTER_MS = 10 * 60 * 1000;
const OFFLINE_LOG_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_CLEANUP_CRON = "0 4 * * *";
const DEFAULT_HEALTH_CRON = "*/5 * * * *";
const TELEMETRY_CLEANUP_CRON = "17 3 * * *";
const HEALTH_SCHEDULE_ID = "gateway:health-webhook-check";
const OFFLINE_AUDIT_ID = "gateway:registered-apps:offline-audit";
const SCHEDULER_ID = "gateway-ops-lifecycle";

const gatewayOpsScheduler = lazySync((sync) => sync.scheduler({ id: SCHEDULER_ID }));
const offlineAuditJob = lazySync((sync) =>
  sync.job<void>({ id: OFFLINE_AUDIT_ID, delivery: { ackWaitMs: 120_000, maxAttempts: 3, backoffMs: [1_000, 2_000] } }),
);

let registryWatcherAbort: AbortController | null = null;
let registryWatcherTask: Promise<void> | null = null;
let telemetryAbort: AbortController | null = null;
let telemetryTask: Promise<void> | null = null;
let schedulerWorker: Worker | null = null;
let offlineAuditWorker: Worker | null = null;

let registryRefreshInFlight = false;

const isAbortError = (error: unknown): boolean => error instanceof Error && error.name === "AbortError";

const delay = async (ms: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
};

const fmtDuration = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (!parts.length || seconds) parts.push(`${seconds}s`);
  return parts.join(" ");
};

const getCronSetting = async (key: string, fallback: string): Promise<string> => {
  const value = String((await getSetting<string>(key)) || "").trim();
  return value.length > 0 ? value : fallback;
};

const getTimezoneSetting = async (): Promise<string> => {
  const value = String((await getSetting<string>("app.timezone")) || "").trim();
  return value.length > 0 ? value : "Europe/Berlin";
};

const getPositiveIntegerSetting = async (key: string, fallback: number): Promise<number> => {
  const value = Number(await getSetting<number | string>(key));
  return Number.isFinite(value) && value >= 1 ? Math.trunc(value) : fallback;
};

const runOfflineAudit = async (signal: AbortSignal): Promise<void> => {
  if (signal.aborted) return;
  const liveApps = await listAppsDetailed();
  const rows = await listRegisteredAppStatus(liveApps);
  const now = Date.now();

  for (const appStatus of rows) {
    if (appStatus.isOnline || appStatus.offlineForMs < OFFLINE_AFTER_MS) continue;
    if (appStatus.lastOfflineLoggedAt && now - appStatus.lastOfflineLoggedAt < OFFLINE_LOG_INTERVAL_MS) continue;
    const offlineFor = fmtDuration(appStatus.offlineForMs);
    offlineLog.error(`Registered app "${appStatus.id}" has been offline for ${offlineFor}`, {
      appId: appStatus.id,
      appName: appStatus.name,
      lastSeenAt: new Date(appStatus.lastSeenAt).toISOString(),
      offlineForMs: appStatus.offlineForMs,
      offlineFor,
      baseUrl: appStatus.baseUrl,
      routes: appStatus.routes,
    });
    await markOfflineLogged(appStatus.id);
  }
};

export const refreshRegisteredApps = async (): Promise<void> => {
  await upsertRegisteredApps(await listApps());
};

const refreshRegisteredAppsOnce = async (): Promise<void> => {
  if (registryRefreshInFlight) return;
  registryRefreshInFlight = true;
  try {
    await refreshRegisteredApps();
  } catch (error) {
    log.error("Registered app refresh failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    registryRefreshInFlight = false;
  }
};

const startRegistryWatcher = (): void => {
  if (registryWatcherTask) return;
  registryWatcherAbort = new AbortController();
  registryWatcherTask = superviseRuntimeTask({
    name: "Registered apps watcher",
    signal: registryWatcherAbort.signal,
    run: (signal) => watchAppRegistry({ signal, onChange: refreshRegisteredAppsOnce }),
    onError: ({ error, failureCount, retryInMs }) =>
      log.error("Registry watcher failed; restarting", {
        error: error instanceof Error ? error.message : String(error),
        failureCount,
        retryInMs,
      }),
  });
};

const stopRegistryWatcher = async (): Promise<void> => {
  registryWatcherAbort?.abort();
  await registryWatcherTask?.catch(() => undefined);
  registryWatcherAbort = null;
  registryWatcherTask = null;
};

const createOfflineAuditSchedule = async (): Promise<void> => {
  const [cron, timezone] = await Promise.all([getCronSetting("app.cleanup_schedule", DEFAULT_CLEANUP_CRON), getTimezoneSetting()]);
  await gatewayOpsScheduler().create({
    id: OFFLINE_AUDIT_ID,
    cron,
    timezone,
    meta: {
      appId: "gateway-ops",
      family: "gateway:registered-apps",
      label: "Registered app offline audit",
      source: OFFLINE_AUDIT_ID,
    },
    process: async (context) => {
      await trace.withSpan(
        {
          spanKey: trace.syncSpanKey("scheduler", SCHEDULER_ID, context.runId),
          name: "Registered app offline audit",
          source: OFFLINE_AUDIT_ID,
          appId: "gateway-ops",
          category: "schedule",
        },
        async () => {
          await offlineAuditJob().submit({ key: `slot:${context.slot.getTime()}`, input: undefined });
        },
      );
    },
  });
};

const createHealthWebhookSchedule = async (cronOverride?: string): Promise<void> => {
  const [cron, timezone] = await Promise.all([
    cronOverride ? Promise.resolve(cronOverride) : getCronSetting("gateway.health_check_schedule", DEFAULT_HEALTH_CRON),
    getTimezoneSetting(),
  ]);
  await gatewayOpsScheduler().create({
    id: HEALTH_SCHEDULE_ID,
    cron,
    timezone,
    meta: {
      appId: "gateway-ops",
      family: "gateway:health",
      label: "Gateway health webhook check",
      source: HEALTH_SCHEDULE_ID,
    },
    process: async (context) => {
      await trace.withSpan(
        {
          spanKey: trace.syncSpanKey("scheduler", SCHEDULER_ID, context.runId),
          name: "Gateway health webhook check",
          source: HEALTH_SCHEDULE_ID,
          appId: "gateway-ops",
          category: "schedule",
        },
        async () => {
          await runHealthWebhookCheck();
        },
      );
    },
  });
};

const createTelemetryCleanupSchedule = async (): Promise<void> => {
  const timezone = await getTimezoneSetting();
  await gatewayOpsScheduler().create({
    id: "gateway:telemetry:cleanup",
    cron: TELEMETRY_CLEANUP_CRON,
    timezone,
    meta: {
      appId: "gateway-ops",
      family: "gateway:telemetry",
      label: "Gateway telemetry cleanup",
      source: "gateway:telemetry:cleanup",
    },
    process: async (context) => {
      await trace.withSpan(
        {
          spanKey: trace.syncSpanKey("scheduler", SCHEDULER_ID, context.runId),
          name: "Gateway telemetry cleanup",
          source: "gateway:telemetry:cleanup",
          appId: "gateway-ops",
          category: "schedule",
        },
        async () => {
          const [eventsDays, rollupsDays, traceDays] = await Promise.all([
            getPositiveIntegerSetting("gateway.telemetry_event_retention_days", 14),
            getPositiveIntegerSetting("gateway.telemetry_rollup_retention_days", 90),
            getPositiveIntegerSetting("logs.trace_retention_days", 30),
          ]);
          const [telemetry, traces] = await Promise.all([
            cleanupTelemetry({ eventsDays, rollupsDays }),
            trace.cleanup({ days: traceDays }),
          ]);
          const summary = { events: telemetry.events, rollups: telemetry.rollups, traces };
          log.info("Observability retention cleanup completed", summary);
          return summary;
        },
        { summarize: (summary) => summary },
      );
    },
  });
};

export const updateHealthSchedule = async (cron: string): Promise<void> => {
  await createHealthWebhookSchedule(cron);
};

const startScheduler = async (): Promise<void> => {
  await createOfflineAuditSchedule();
  await createHealthWebhookSchedule();
  await createTelemetryCleanupSchedule();
  schedulerWorker ??= await gatewayOpsScheduler().process();
  offlineAuditWorker ??= await offlineAuditJob().process({}, (context) => runOfflineAudit(context.signal));
};

const stopScheduler = async (): Promise<void> => {
  const workers = [schedulerWorker, offlineAuditWorker];
  schedulerWorker = null;
  offlineAuditWorker = null;
  await Promise.all(workers.map((worker) => worker?.drain()));
};

const startTelemetryConsumer = (): void => {
  if (telemetryTask) return;
  telemetryAbort = new AbortController();
  const signal = telemetryAbort.signal;
  telemetryTask = (async () => {
    while (!signal.aborted) {
      try {
        await consumeTelemetry(signal);
      } catch (error) {
        if (isAbortError(error) || signal.aborted) return;
        log.error("Gateway telemetry consumer failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        await delay(5_000, signal);
      }
    }
  })().finally(() => {
    if (telemetryAbort?.signal === signal) telemetryAbort = null;
    telemetryTask = null;
  });
};

const stopTelemetryConsumer = async (): Promise<void> => {
  telemetryAbort?.abort();
  const task = telemetryTask;
  telemetryAbort = null;
  telemetryTask = null;
  if (task) await task.catch(() => undefined);
};

export const gatewayOpsLifecycle: AppLifecycle = {
  setup: async () => {
    await migrate();
    await refreshRegisteredApps();
  },

  start: async () => {
    startRegistryWatcher();
    await startScheduler();
    await startHealthWebhookDelivery();
    startTelemetryConsumer();
    log.info("Gateway Ops started");
  },

  stop: async () => {
    await stopRegistryWatcher();
    await stopTelemetryConsumer();
    await stopScheduler();
    await stopHealthWebhookDelivery();
  },
};
