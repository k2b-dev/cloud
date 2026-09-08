import type { DeliveryConfig, JobContext, Worker } from "@k2b/sync";
import { lazySync } from "../../_internal/process-sync";
import { logger, logging, trace } from "../logging";
import { providers } from "../providers";
import { get as getSetting } from "../settings";
import { accountLifecycle } from "./index";
import { declareIpaBackfill, prepareIpaBackfill, processIpaBackfillAccount } from "./ipa-backfill";
import type { AccountLifecycleNotificationSender } from "./notification-sender";

const log = logger("auth:lifecycle:scheduler");
const ipaSyncLog = logger("auth:ipa:sync");
const reminderLog = logger("auth:reminder:daily");
const guestCleanupLog = logger("auth:guest:cleanup");
const localUserCleanupLog = logger("auth:local-user:cleanup");
const auditCleanupLog = logger("auth:lifecycle:audit:cleanup");
const localUserBackfillLog = logger("auth:local-user:backfill");
const guestBackfillLog = logger("auth:guest:backfill");
const logCleanupLog = logger("logging");
const DEFAULT_IPA_SYNC_CRON = "*/5 * * * *";
const IPA_SYNC_LEASE_MS = 120_000;
// Scheduled scans retry in minutes: a short FreeIPA or database blip must not
// dead-letter a slot; anything longer surfaces once as a dead letter and the
// next slot retries anyway.
const SCAN_RETRY = { maxAttempts: 3, backoffMs: [60_000, 300_000] } satisfies Partial<DeliveryConfig>;
const ipaSyncMutex = lazySync((sync) => sync.mutex({ id: "auth:ipa:sync", ttlMs: IPA_SYNC_LEASE_MS, retry: { maxAttempts: 1 } }));
let notificationSender: AccountLifecycleNotificationSender | null = null;

type JobSummary = {
  scanned: number;
  changed: number;
  skipped: number;
  failed: number;
};

const abortedSummary = (): JobSummary => ({ scanned: 0, changed: 0, skipped: 0, failed: 0 });

const toDemotionLog = (summary: JobSummary) => ({
  expiredCandidates: summary.scanned,
  demotedToGuest: summary.changed,
  skipped: summary.skipped,
  failed: summary.failed,
});

const toReminderLog = (summary: JobSummary) => ({
  candidates: summary.scanned,
  sent: summary.changed,
  skipped: summary.skipped,
  failed: summary.failed,
});

const toCleanupLog = (summary: JobSummary) => ({
  candidates: summary.scanned,
  deleted: summary.changed,
  skipped: summary.skipped,
  failed: summary.failed,
});

const toBackfillLog = (summary: JobSummary) => ({
  candidates: summary.scanned,
  updated: summary.changed,
  skipped: summary.skipped,
  failed: summary.failed,
});

/** Presentation of the run span Sync already opened for this job (`trace.syncSpanKey`). */
const jobSpan = (ctx: JobContext<null>, id: string, name: string, source = id) => ({
  name,
  source,
  appId: "core",
  category: "job" as const,
  kind: "consumer" as const,
  spanKey: trace.syncSpanKey("job", id, ctx.jobId),
});

const getCronSetting = async (key: string, fallback: string): Promise<string> => {
  const value = String((await getSetting<string>(key)) || "").trim();
  return value.length > 0 ? value : fallback;
};

const getTimezoneSetting = async (): Promise<string> => {
  const value = String((await getSetting<string>("app.timezone")) || "").trim();
  return value.length > 0 ? value : "Europe/Berlin";
};

// ── Jobs ───────────────────────────────────────────────────────────────

const ipaSyncJob = lazySync((sync) =>
  sync.job<null>({
    id: "auth:ipa:sync",
    delivery: { ackWaitMs: IPA_SYNC_LEASE_MS, ...SCAN_RETRY },
  }),
);
const processIpaSyncJob = async (ctx: JobContext<null>): Promise<void> => {
  await trace.withSpan(
    jobSpan(ctx, "auth:ipa:sync", "FreeIPA account sync"),
    async () => {
      if (ctx.signal.aborted) return abortedSummary();
      const lock = await ipaSyncMutex().acquire({ resource: "global" });
      if (!lock) {
        ipaSyncLog.info("Sync skipped", { reason: "already_running" });
        return abortedSummary();
      }
      const heartbeat = async () => {
        await ctx.heartbeat();
        if (!(await ipaSyncMutex().extend(lock, { ttlMs: IPA_SYNC_LEASE_MS }))) {
          throw new Error("Lost FreeIPA synchronization lock");
        }
      };
      try {
        try {
          await providers.ipa.sync.run({ signal: ctx.signal, heartbeat });
        } catch (error) {
          ipaSyncLog.error("Sync step failed", { step: "sync", error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
        await heartbeat();
        try {
          const summary = await accountLifecycle.demoteExpiredIpaUsers({ signal: ctx.signal, heartbeat });
          ipaSyncLog.info("Expired IPA demotion complete", toDemotionLog(summary));
          return summary;
        } catch (error) {
          ipaSyncLog.error("Expired IPA demotion step failed", {
            step: "demote-expired",
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      } finally {
        await ipaSyncMutex()
          .release(lock)
          .catch((error) => {
            ipaSyncLog.error("Failed to release synchronization lock", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
    },
    { summarize: (summary) => summary },
  );
};

const reminderJob = lazySync((sync) =>
  sync.job<null>({
    id: "auth:reminder:daily",
    delivery: { ackWaitMs: 180_000, ...SCAN_RETRY },
  }),
);
const processReminderJob = async (ctx: JobContext<null>): Promise<void> => {
  await trace.withSpan(
    jobSpan(ctx, "auth:reminder:daily", "Account expiry reminders"),
    async () => {
      if (ctx.signal.aborted) return abortedSummary();
      if (!notificationSender) throw new Error("Account lifecycle notification sender is not configured");
      const summary = await accountLifecycle.sendExpiryReminders(notificationSender);
      reminderLog.info("Reminder run complete", toReminderLog(summary));
      return summary;
    },
    { summarize: (summary) => summary },
  );
};

const guestCleanupJob = lazySync((sync) =>
  sync.job<null>({
    id: "auth:guest:cleanup",
    delivery: { ackWaitMs: 120_000, ...SCAN_RETRY },
  }),
);
const processGuestCleanupJob = async (ctx: JobContext<null>): Promise<void> => {
  await trace.withSpan(
    jobSpan(ctx, "auth:guest:cleanup", "Expired guest cleanup"),
    async () => {
      if (ctx.signal.aborted) return abortedSummary();
      const summary = await accountLifecycle.cleanupExpiredGuests();
      guestCleanupLog.info("Expired guest cleanup complete", toCleanupLog(summary));
      return summary;
    },
    { summarize: (summary) => summary },
  );
};

const localUserCleanupJob = lazySync((sync) =>
  sync.job<null>({
    id: "auth:local-user:cleanup",
    delivery: { ackWaitMs: 120_000, ...SCAN_RETRY },
  }),
);
const processLocalUserCleanupJob = async (ctx: JobContext<null>): Promise<void> => {
  await trace.withSpan(
    jobSpan(ctx, "auth:local-user:cleanup", "Expired local user cleanup"),
    async () => {
      if (ctx.signal.aborted) return abortedSummary();
      const summary = await accountLifecycle.cleanupExpiredLocalUsers();
      localUserCleanupLog.info("Expired local user cleanup complete", toCleanupLog(summary));
      return summary;
    },
    { summarize: (summary) => summary },
  );
};

const auditCleanupJob = lazySync((sync) =>
  sync.job<null>({
    id: "auth:lifecycle:audit:cleanup",
    delivery: { ackWaitMs: 120_000, ...SCAN_RETRY },
  }),
);
const processAuditCleanupJob = async (ctx: JobContext<null>): Promise<void> => {
  await trace.withSpan(
    jobSpan(ctx, "auth:lifecycle:audit:cleanup", "Lifecycle audit cleanup"),
    async () => {
      if (ctx.signal.aborted) return abortedSummary();
      const summary = await accountLifecycle.cleanupLifecycleAudit();
      auditCleanupLog.info("Lifecycle audit cleanup complete", toCleanupLog(summary));
      return summary;
    },
    { summarize: (summary) => summary },
  );
};

const logCleanupJob = lazySync((sync) =>
  sync.job<null>({
    id: "app:logs:cleanup",
    delivery: { ackWaitMs: 120_000, ...SCAN_RETRY },
  }),
);
const processLogCleanupJob = async (ctx: JobContext<null>): Promise<void> => {
  await trace.withSpan(
    jobSpan(ctx, "app:logs:cleanup", "Log cleanup", "logging"),
    async () => {
      if (ctx.signal.aborted) return { deleted: 0, retentionDays: 0 };
      const configured = Number((await getSetting<number | string | null>("logs.retention_days")) ?? 30);
      const retentionDays = Number.isFinite(configured) ? configured : 30;
      const summary = await logging.cleanup(retentionDays);
      logCleanupLog.info("Log cleanup complete", { deleted: summary.deleted, retentionDays });
      return { deleted: summary.deleted, retentionDays };
    },
    { summarize: (summary) => summary },
  );
};

const ipaBackfill = lazySync(declareIpaBackfill);

const guestBackfillJob = lazySync((sync) =>
  sync.job<null>({
    id: "auth:guest:backfill",
    delivery: { ackWaitMs: 300_000, maxAttempts: 2, backoffMs: [2000, 4000] },
  }),
);
const processGuestBackfillJob = async (ctx: JobContext<null>): Promise<void> => {
  await trace.withSpan(
    jobSpan(ctx, "auth:guest:backfill", "Guest expiry backfill"),
    async () => {
      if (ctx.signal.aborted) return abortedSummary();
      const summary = await accountLifecycle.runGuestBackfill();
      guestBackfillLog.info("Guest expiry backfill complete", toBackfillLog(summary));
      return summary;
    },
    { summarize: (summary) => summary },
  );
};

const localUserBackfillJob = lazySync((sync) =>
  sync.job<null>({
    id: "auth:local-user:backfill",
    delivery: { ackWaitMs: 300_000, maxAttempts: 2, backoffMs: [2000, 4000] },
  }),
);
const processLocalUserBackfillJob = async (ctx: JobContext<null>): Promise<void> => {
  await trace.withSpan(
    jobSpan(ctx, "auth:local-user:backfill", "Local user expiry backfill"),
    async () => {
      if (ctx.signal.aborted) return abortedSummary();
      const summary = await accountLifecycle.runLocalUserBackfill();
      localUserBackfillLog.info("Local user expiry backfill complete", toBackfillLog(summary));
      return summary;
    },
    { summarize: (summary) => summary },
  );
};

// ── Scheduler ──────────────────────────────────────────────────────────

const lifecycleScheduler = lazySync((sync) => sync.scheduler({ id: "auth-lifecycle", delivery: { maxAttempts: 1 } }));

let started = false;
let workers: Worker[] = [];
let registered = false;
let registerPromise: Promise<void> | null = null;

/**
 * Register (or update) a cron-triggered schedule that fans out to the given
 * job. `scheduler.create` is idempotent by id — same cron/tz keeps `nextRunAt`
 * intact; a change resets it. Each slot submits with the job's stable
 * `scheduled` key and `coalesce`: at most one scan is queued or running, a slot
 * that fires during a run joins it, and the key is released when the run
 * settles. Scans read their whole work set, so a joined slot loses nothing.
 */
const createSchedule = async (config: {
  id: string;
  cron: string;
  tz: string;
  family: string;
  label: string;
  source?: string;
  submit: () => Promise<unknown>;
}): Promise<void> => {
  const source = config.source ?? config.id;
  await lifecycleScheduler().create({
    id: config.id,
    cron: config.cron,
    timezone: config.tz,
    misfire: "latest",
    meta: {
      appId: "core",
      family: config.family,
      label: config.label,
      source,
    },
    process: async () => {
      await config.submit();
    },
  });
};

const createScheduleWithFallback = async (config: {
  id: string;
  cron: string;
  fallbackCron: string;
  tz: string;
  submit: () => Promise<unknown>;
  settingsKey: string;
  family: string;
  label: string;
  source?: string;
}): Promise<void> => {
  try {
    await createSchedule({
      id: config.id,
      cron: config.cron,
      tz: config.tz,
      family: config.family,
      label: config.label,
      source: config.source,
      submit: config.submit,
    });
  } catch (error) {
    if (config.cron === config.fallbackCron) throw error;
    log.warn("Invalid configured cron, falling back to default", {
      key: config.settingsKey,
      configuredCron: config.cron,
      fallbackCron: config.fallbackCron,
      timezone: config.tz,
      error: error instanceof Error ? error.message : String(error),
    });
    await createSchedule({
      id: config.id,
      cron: config.fallbackCron,
      tz: config.tz,
      family: config.family,
      label: config.label,
      source: config.source,
      submit: config.submit,
    });
  }
};

const doRegister = async (): Promise<void> => {
  const [scheduleTz, ipaSyncCron, reminderCron, cleanupCron] = await Promise.all([
    getTimezoneSetting(),
    getCronSetting("freeipa.sync_cron", DEFAULT_IPA_SYNC_CRON),
    getCronSetting("user.account.reminder_cron", "0 9 * * *"),
    getCronSetting("app.cleanup_schedule", "0 4 * * *"),
  ]);

  await createScheduleWithFallback({
    id: "auth:ipa:sync",
    cron: ipaSyncCron,
    fallbackCron: DEFAULT_IPA_SYNC_CRON,
    tz: scheduleTz,
    settingsKey: "freeipa.sync_cron",
    family: "auth:ipa",
    label: "FreeIPA account sync",
    submit: () => ipaSyncJob().submit({ key: "scheduled", input: null, coalesce: true }),
  });

  await createSchedule({
    id: "auth:reminder:daily",
    cron: reminderCron,
    tz: scheduleTz,
    family: "auth:reminders",
    label: "Daily account reminders",
    submit: () => reminderJob().submit({ key: "scheduled", input: null, coalesce: true }),
  });

  await createSchedule({
    id: "auth:guest:cleanup",
    cron: cleanupCron,
    tz: scheduleTz,
    family: "auth:cleanup",
    label: "Guest account cleanup",
    submit: () => guestCleanupJob().submit({ key: "scheduled", input: null, coalesce: true }),
  });

  await createSchedule({
    id: "auth:local-user:cleanup",
    cron: cleanupCron,
    tz: scheduleTz,
    family: "auth:cleanup",
    label: "Local user cleanup",
    submit: () => localUserCleanupJob().submit({ key: "scheduled", input: null, coalesce: true }),
  });

  await createSchedule({
    id: "auth:lifecycle:audit:cleanup",
    cron: cleanupCron,
    tz: scheduleTz,
    family: "auth:cleanup",
    label: "Account lifecycle audit cleanup",
    submit: () => auditCleanupJob().submit({ key: "scheduled", input: null, coalesce: true }),
  });

  await createSchedule({
    id: "app:logs:cleanup",
    cron: cleanupCron,
    tz: scheduleTz,
    family: "app:cleanup",
    label: "Application log cleanup",
    submit: () => logCleanupJob().submit({ key: "scheduled", input: null, coalesce: true }),
  });

  registered = true;
};

const ensureRegistered = async (): Promise<void> => {
  if (registered) return;
  if (!registerPromise) {
    registerPromise = doRegister().finally(() => {
      registerPromise = null;
    });
  }
  await registerPromise;
};

export const lifecycleJobs = {
  start: async (config: { notificationSender: AccountLifecycleNotificationSender }): Promise<void> => {
    notificationSender = config.notificationSender;
    if (started) return;
    await ensureRegistered();
    try {
      workers.push(await ipaSyncJob().process({}, processIpaSyncJob));
      workers.push(await reminderJob().process({}, processReminderJob));
      workers.push(await guestCleanupJob().process({}, processGuestCleanupJob));
      workers.push(await localUserCleanupJob().process({}, processLocalUserCleanupJob));
      workers.push(await auditCleanupJob().process({}, processAuditCleanupJob));
      workers.push(await logCleanupJob().process({}, processLogCleanupJob));
      workers.push(await ipaBackfill().accounts.process({ concurrency: 1 }, processIpaBackfillAccount));
      workers.push(await ipaBackfill().pump.process());
      workers.push(await guestBackfillJob().process({}, processGuestBackfillJob));
      workers.push(await localUserBackfillJob().process({}, processLocalUserBackfillJob));
      workers.push(await lifecycleScheduler().process());
      started = true;
    } catch (error) {
      for (const worker of workers) worker.stop();
      await Promise.all(workers.map((worker) => worker.drain()));
      workers = [];
      throw error;
    }
  },

  stop: async (): Promise<void> => {
    if (!started) {
      notificationSender = null;
      return;
    }
    for (const worker of workers) worker.stop();
    await Promise.all(workers.map((worker) => worker.drain()));
    workers = [];
    started = false;
    registered = false;
    registerPromise = null;
    notificationSender = null;
  },

  // Manual-only backfill triggers. Scheduled jobs run from their broker schedules
  // (`listSchedules`; Admin Observability Jobs can run a schedule now).
  submitIpaBackfill: async (): Promise<string> => {
    const key = crypto.randomUUID();
    await ipaBackfill().pump.start({ key, input: await prepareIpaBackfill(key) });
    return key;
  },
  submitLocalUserBackfill: async (): Promise<string> =>
    (await localUserBackfillJob().submit({ key: `manual:${Date.now()}`, input: null })).jobId,
  submitGuestBackfill: async (): Promise<string> => (await guestBackfillJob().submit({ key: `manual:${Date.now()}`, input: null })).jobId,

  /** Process-local worker state; schedule state (next run, failures) comes from `listSchedules`. */
  metrics: () => ({
    started,
    registered,
    active: workers.reduce((total, worker) => total + worker.active, 0),
    capacity: workers.reduce((total, worker) => total + worker.capacity, 0),
  }),
  listSchedules: async () => lifecycleScheduler().list(),
};
