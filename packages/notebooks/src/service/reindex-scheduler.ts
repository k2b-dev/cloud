/**
 * Periodic derived-data reindex scheduler.
 *
 * Re-derives `note_links`, `note_tags`, and `note_attachments` for every
 * note across every notebook on a configurable cron schedule (default
 * "every 12 hours" by default). This is a safety net — every save
 * already reindexes via `reindexNoteRefsSafe`, so the periodic pass mostly
 * heals drift from:
 *   - failed reindex attempts (logged but not retried per-save)
 *   - markdown written via direct DB writes / migrations
 *   - schema additions (e.g. when we added the index tables, existing
 *     notes had no rows — the first scheduler tick backfills them)
 *
 * Cron string is read from `notebooks.reindex_cron` setting; admins can
 * change it from `/admin/notebooks` → Settings.
 *
 */

import type { Worker } from "@k2b/sync";
import { lazySync } from "@valentinkolb/cloud";
import { logger, get as settingsGet } from "@valentinkolb/cloud/services";
import { reindexAll } from "./note-refs";
import { yjsSnapshotWorker } from "./yjs-snapshot-worker";

const log = logger("notebooks:reindex");

const DEFAULT_REINDEX_CRON = "0 */12 * * *";
const SETTING_KEY = "notebooks.reindex_cron";
const SNAPSHOT_RECONCILE_CRON = "0 * * * *";

const getCron = async (): Promise<string> => {
  const value = String((await settingsGet<string>(SETTING_KEY)) || "").trim();
  return value.length > 0 ? value : DEFAULT_REINDEX_CRON;
};

const getTimezone = async (): Promise<string> => {
  const value = String((await settingsGet<string>("app.timezone")) || "").trim();
  return value.length > 0 ? value : "Europe/Berlin";
};

/** Run a single reindex pass with start/end logging + duration metric. */
const runReindex = async (params: { trigger: "scheduler"; onProgress?: () => Promise<void> }): Promise<void> => {
  const startedAt = Date.now();
  log.info("Notebook derived-data reindex started", { trigger: params.trigger });
  try {
    const summary = await reindexAll({ onProgress: params.onProgress });
    const durationMs = Date.now() - startedAt;
    if (summary.failed > 0) {
      log.warn("Notebook derived-data reindex finished with partial failures", {
        trigger: params.trigger,
        durationMs,
        notebooks: summary.notebooks,
        notes: summary.notes,
        failed: summary.failed,
      });
    } else {
      log.info("Notebook derived-data reindex finished", {
        trigger: params.trigger,
        durationMs,
        notebooks: summary.notebooks,
        notes: summary.notes,
      });
    }
  } catch (error) {
    log.error("Notebook derived-data reindex crashed", {
      trigger: params.trigger,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};

type ReindexTrigger = "scheduler";

const reindexJob = lazySync((sync) =>
  sync.job<{ trigger: ReindexTrigger }>({
    id: "notebooks:reindex",
    delivery: { ackWaitMs: 300_000, maxInFlight: 1, maxAttempts: 3, backoffMs: [5_000, 10_000] },
  }),
);
const reindexScheduler = lazySync((sync) => sync.scheduler({ id: "notebooks:reindex" }));
let jobWorker: Worker | undefined;
let scheduleWorker: Worker | undefined;

const startWorkers = async (): Promise<void> => {
  jobWorker ??= await reindexJob().process({}, async (ctx) => {
    ctx.signal.throwIfAborted();
    let lastHeartbeatAt = Date.now();
    await runReindex({
      trigger: ctx.input.trigger,
      onProgress: async () => {
        ctx.signal.throwIfAborted();
        if (Date.now() - lastHeartbeatAt < 60_000) return;
        await ctx.heartbeat();
        lastHeartbeatAt = Date.now();
      },
    });
  });
  scheduleWorker ??= await reindexScheduler().process({});
};

// Module-local lifecycle state. App lifecycle hooks fire sequentially so
// plain flags are enough — no mutex needed.
let started = false;
let registered = false;
let registerPromise: Promise<void> | null = null;

const createSchedule = async (cron: string, tz: string): Promise<void> => {
  await reindexScheduler().create({
    id: "notebooks:reindex",
    cron,
    timezone: tz,
    meta: {
      appId: "notebooks",
      family: "notebooks:maintenance",
      label: "Notebook references reindex",
      source: "notebooks:reindex",
    },
    process: async (ctx) => {
      await reindexJob().submit({ key: ctx.runId, input: { trigger: "scheduler" } });
    },
  });
  log.info("Reindex schedule registered", { cron, tz });
};

/**
 * Hourly safety net for the Yjs snapshot worker: notes whose topic moved past
 * their stored snapshot without a settled snapshot job (lost enqueue, crashed
 * process, dead letter) get their snapshot re-queued.
 */
const createSnapshotReconcileSchedule = async (tz: string): Promise<void> => {
  await reindexScheduler().create({
    id: "notebooks:yjs-snapshot-reconcile",
    cron: SNAPSHOT_RECONCILE_CRON,
    timezone: tz,
    meta: {
      appId: "notebooks",
      family: "notebooks:maintenance",
      label: "Notebook snapshot reconcile",
      source: "notebooks:yjs-snapshot-reconcile",
    },
    process: async (ctx) => {
      await yjsSnapshotWorker.reconcile({ signal: ctx.signal, heartbeat: ctx.heartbeat });
    },
  });
};

const registerSchedule = async (cron?: string): Promise<void> => {
  const [tz, resolvedCron] = await Promise.all([getTimezone(), cron ? Promise.resolve(cron) : getCron()]);
  await createSnapshotReconcileSchedule(tz);
  try {
    await createSchedule(resolvedCron, tz);
    registered = true;
  } catch (error) {
    // Invalid cron in settings → fall back to default and log the issue
    // so admins notice their value was rejected.
    if (!cron && resolvedCron !== DEFAULT_REINDEX_CRON) {
      log.warn("Invalid configured reindex cron, falling back to default", {
        key: SETTING_KEY,
        configuredCron: resolvedCron,
        fallbackCron: DEFAULT_REINDEX_CRON,
        timezone: tz,
        error: error instanceof Error ? error.message : String(error),
      });
      await createSchedule(DEFAULT_REINDEX_CRON, tz);
      registered = true;
      return;
    }
    throw error;
  }
};

const ensureRegistered = async (): Promise<void> => {
  if (registered) return;
  if (!registerPromise) {
    registerPromise = registerSchedule().finally(() => {
      registerPromise = null;
    });
  }
  await registerPromise;
};

export const reindexRuntime = {
  start: async (): Promise<void> => {
    if (!started) {
      await ensureRegistered();
      await startWorkers();
      started = true;
    }
    await ensureRegistered();
  },

  stop: async (): Promise<void> => {
    scheduleWorker?.stop();
    jobWorker?.stop();
    await Promise.all([scheduleWorker?.drain(), jobWorker?.drain()]);
    scheduleWorker = undefined;
    jobWorker = undefined;
    started = false;
    registered = false;
    registerPromise = null;
  },

  /** Read the current cron — used by the admin settings UI. */
  getCron,

  /** Update the cron + reschedule. Used by the admin settings API. */
  updateCron: async (cron: string): Promise<void> => {
    const normalized = cron.trim();
    if (!normalized) throw new Error("Reindex cron must not be empty.");
    if (!started) {
      await ensureRegistered();
      await startWorkers();
      started = true;
    }
    await registerSchedule(normalized);
    log.info("Reindex cron updated", { cron: normalized });
  },
};
