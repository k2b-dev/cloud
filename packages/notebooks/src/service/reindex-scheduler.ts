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
 * One-shot startup backfill: `runtime.start` also kicks off a single
 * background reindex so newly-deployed schema changes get picked up
 * without waiting up to 12h for the first scheduled tick.
 */

import { job, scheduler } from "@k2b/sync";
import { logger, get as settingsGet, trace } from "@valentinkolb/cloud/services";
import { reindexAll } from "./note-refs";

const log = logger("notebooks:reindex");

const DEFAULT_REINDEX_CRON = "0 */12 * * *";
const SETTING_KEY = "notebooks.reindex_cron";

const getCron = async (): Promise<string> => {
  const value = String((await settingsGet<string>(SETTING_KEY)) || "").trim();
  return value.length > 0 ? value : DEFAULT_REINDEX_CRON;
};

const getTimezone = async (): Promise<string> => {
  const value = String((await settingsGet<string>("app.timezone")) || "").trim();
  return value.length > 0 ? value : "Europe/Berlin";
};

/** Run a single reindex pass with start/end logging + duration metric. */
const runReindex = async (params: { trigger: "scheduler" | "startup"; onProgress?: () => Promise<void> }): Promise<void> => {
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

type ReindexTrigger = "scheduler" | "startup";

const reindexJob = job<{ trigger: ReindexTrigger }, void>({
  id: "notebooks:reindex",
  defaults: { leaseMs: 300_000 },
  trace: trace.fromSyncJob<{ trigger: ReindexTrigger }, void>({
    name: "Notebook references reindex",
    source: "notebooks:reindex",
    appId: "notebooks",
    attributes: (event) => ("input" in event && event.input ? { "cloud.notebooks.reindex_trigger": event.input.trigger } : {}),
  }),
  process: async ({ ctx }) => {
    if (ctx.signal.aborted) return;
    let lastHeartbeatAt = Date.now();
    await runReindex({
      trigger: ctx.input.trigger,
      onProgress: async () => {
        if (Date.now() - lastHeartbeatAt < 60_000) return;
        await ctx.heartbeat({ leaseMs: 300_000 });
        lastHeartbeatAt = Date.now();
      },
    });
  },
  after: async ({ ctx }) => {
    if (!ctx.error) return;
    if (ctx.failureCount >= 3) return;
    // Backoff if we crashed — same pattern as ipa-hosts sync.
    ctx.reschedule({ delayMs: ctx.expBackoff({ baseMs: 5_000 }) });
  },
});

const reindexScheduler = scheduler({ id: "notebooks:reindex" });

// Module-local lifecycle state. App lifecycle hooks fire sequentially so
// plain flags are enough — no mutex needed.
let started = false;
let registered = false;
let registerPromise: Promise<void> | null = null;

const createSchedule = async (cron: string, tz: string): Promise<void> => {
  await reindexScheduler.create({
    id: "notebooks:reindex",
    cron,
    tz,
    meta: {
      appId: "notebooks",
      family: "notebooks:maintenance",
      label: "Notebook references reindex",
      source: "notebooks:reindex",
    },
    trace: trace.fromSyncSchedule<void>({
      name: "Notebook references reindex schedule",
      source: "notebooks:reindex",
      appId: "notebooks",
    }),
    process: async ({ ctx }) => {
      await reindexJob.submit({ key: `slot:${ctx.slotTs}`, input: { trigger: "scheduler" } });
    },
  });
  log.info("Reindex schedule registered", { cron, tz });
};

const registerSchedule = async (cron?: string): Promise<void> => {
  const [tz, resolvedCron] = await Promise.all([getTimezone(), cron ? Promise.resolve(cron) : getCron()]);
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
      reindexScheduler.start();
      started = true;
    }
    await ensureRegistered();

    // Fire-and-forget startup backfill via the distributed job. Don't await:
    // app boot stays snappy and only one container owns the job key.
    void reindexJob.submit({ key: "startup:derived-v1", input: { trigger: "startup" } }).catch((error) => {
      log.error("Failed to submit startup derived-data reindex", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  },

  stop: async (): Promise<void> => {
    if (!started) return;
    await reindexScheduler.stop();
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
      reindexScheduler.start();
      started = true;
    }
    await registerSchedule(normalized);
    log.info("Reindex cron updated", { cron: normalized });
  },
};
