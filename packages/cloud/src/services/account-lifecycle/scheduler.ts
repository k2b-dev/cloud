import type { JobContext, Worker } from "@k2b/sync";
import { lazySync } from "../../_internal/process-sync";
import { logger, logging, trace } from "../logging";
import { providers } from "../providers";
import { get as getSetting } from "../settings";
import { syncOps } from "../sync-ops";
import { accountLifecycle } from "./index";
import type { AccountLifecycleNotificationSender } from "./notification-sender";

const log = logger("auth:lifecycle:scheduler");
const ipaSyncLog = logger("auth:ipa:sync");
const reminderLog = logger("auth:reminder:daily");
const guestCleanupLog = logger("auth:guest:cleanup");
const localUserCleanupLog = logger("auth:local-user:cleanup");
const auditCleanupLog = logger("auth:lifecycle:audit:cleanup");
const ipaBackfillLog = logger("auth:ipa:backfill");
const localUserBackfillLog = logger("auth:local-user:backfill");
const guestBackfillLog = logger("auth:guest:backfill");
const logCleanupLog = logger("logging");
const DEFAULT_IPA_SYNC_CRON = "*/5 * * * *";
const IPA_SYNC_LEASE_MS = 120_000;
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

const getCronSetting = async (key: string, fallback: string): Promise<string> => {
  const value = String((await getSetting<string>(key)) || "").trim();
  return value.length > 0 ? value : fallback;
};

const getTimezoneSetting = async (): Promise<string> => {
  const value = String((await getSetting<string>("app.timezone")) || "").trim();
  return value.length > 0 ? value : "Europe/Berlin";
};

// ── Jobs ───────────────────────────────────────────────────────────────

const ipaSyncJob = lazySync((sync) => {
  const handle = sync.job<null>({
    id: "auth:ipa:sync",
    delivery: { ackWaitMs: IPA_SYNC_LEASE_MS, maxAttempts: 3, backoffMs: [1000, 2000] },
  });
  syncOps.registerDeadLetters({ name: "auth:ipa:sync", kind: "job", store: handle.deadLetters });
  return handle;
});
const processIpaSyncJob = async (ctx: JobContext<null>): Promise<void> => {
  await trace.withSpan(
    {
      name: "FreeIPA account sync",
      source: "auth:ipa:sync",
      appId: "core",
      category: "job",
      kind: "consumer",
    },
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

const reminderJob = lazySync((sync) => {
  const handle = sync.job<null>({
    id: "auth:reminder:daily",
    delivery: { ackWaitMs: 180_000, maxAttempts: 3, backoffMs: [1000, 2000] },
  });
  syncOps.registerDeadLetters({ name: "auth:reminder:daily", kind: "job", store: handle.deadLetters });
  return handle;
});
const processReminderJob = async (ctx: JobContext<null>): Promise<void> => {
  await trace.withSpan(
    {
      name: "Account expiry reminders",
      source: "auth:reminder:daily",
      appId: "core",
      category: "job",
      kind: "consumer",
    },
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

const guestCleanupJob = lazySync((sync) => {
  const handle = sync.job<null>({
    id: "auth:guest:cleanup",
    delivery: { ackWaitMs: 120_000, maxAttempts: 3, backoffMs: [1000, 2000] },
  });
  syncOps.registerDeadLetters({ name: "auth:guest:cleanup", kind: "job", store: handle.deadLetters });
  return handle;
});
const processGuestCleanupJob = async (ctx: JobContext<null>): Promise<void> => {
  await trace.withSpan(
    {
      name: "Expired guest cleanup",
      source: "auth:guest:cleanup",
      appId: "core",
      category: "job",
      kind: "consumer",
    },
    async () => {
      if (ctx.signal.aborted) return abortedSummary();
      const summary = await accountLifecycle.cleanupExpiredGuests();
      guestCleanupLog.info("Expired guest cleanup complete", toCleanupLog(summary));
      return summary;
    },
    { summarize: (summary) => summary },
  );
};

const localUserCleanupJob = lazySync((sync) => {
  const handle = sync.job<null>({
    id: "auth:local-user:cleanup",
    delivery: { ackWaitMs: 120_000, maxAttempts: 3, backoffMs: [1000, 2000] },
  });
  syncOps.registerDeadLetters({ name: "auth:local-user:cleanup", kind: "job", store: handle.deadLetters });
  return handle;
});
const processLocalUserCleanupJob = async (ctx: JobContext<null>): Promise<void> => {
  await trace.withSpan(
    {
      name: "Expired local user cleanup",
      source: "auth:local-user:cleanup",
      appId: "core",
      category: "job",
      kind: "consumer",
    },
    async () => {
      if (ctx.signal.aborted) return abortedSummary();
      const summary = await accountLifecycle.cleanupExpiredLocalUsers();
      localUserCleanupLog.info("Expired local user cleanup complete", toCleanupLog(summary));
      return summary;
    },
    { summarize: (summary) => summary },
  );
};

const auditCleanupJob = lazySync((sync) => {
  const handle = sync.job<null>({
    id: "auth:lifecycle:audit:cleanup",
    delivery: { ackWaitMs: 120_000, maxAttempts: 3, backoffMs: [1000, 2000] },
  });
  syncOps.registerDeadLetters({ name: "auth:lifecycle:audit:cleanup", kind: "job", store: handle.deadLetters });
  return handle;
});
const processAuditCleanupJob = async (ctx: JobContext<null>): Promise<void> => {
  await trace.withSpan(
    {
      name: "Lifecycle audit cleanup",
      source: "auth:lifecycle:audit:cleanup",
      appId: "core",
      category: "job",
      kind: "consumer",
    },
    async () => {
      if (ctx.signal.aborted) return abortedSummary();
      const summary = await accountLifecycle.cleanupLifecycleAudit();
      auditCleanupLog.info("Lifecycle audit cleanup complete", toCleanupLog(summary));
      return summary;
    },
    { summarize: (summary) => summary },
  );
};

const logCleanupJob = lazySync((sync) => {
  const handle = sync.job<null>({
    id: "app:logs:cleanup",
    delivery: { ackWaitMs: 120_000, maxAttempts: 3, backoffMs: [1000, 2000] },
  });
  syncOps.registerDeadLetters({ name: "app:logs:cleanup", kind: "job", store: handle.deadLetters });
  return handle;
});
const processLogCleanupJob = async (ctx: JobContext<null>): Promise<void> => {
  await trace.withSpan(
    {
      name: "Log cleanup",
      source: "logging",
      appId: "core",
      category: "job",
      kind: "consumer",
    },
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

const ipaBackfillJob = lazySync((sync) => {
  const handle = sync.job<null>({
    id: "auth:ipa:backfill",
    delivery: { ackWaitMs: 300_000, maxAttempts: 2, backoffMs: [2000, 4000] },
  });
  syncOps.registerDeadLetters({ name: "auth:ipa:backfill", kind: "job", store: handle.deadLetters });
  return handle;
});
const processIpaBackfillJob = async (ctx: JobContext<null>): Promise<void> => {
  await trace.withSpan(
    {
      name: "IPA expiry backfill",
      source: "auth:ipa:backfill",
      appId: "core",
      category: "job",
      kind: "consumer",
    },
    async () => {
      if (ctx.signal.aborted) return abortedSummary();
      const summary = await accountLifecycle.runIpaBackfill();
      ipaBackfillLog.info("IPA expiry backfill complete", toBackfillLog(summary));
      return summary;
    },
    { summarize: (summary) => summary },
  );
};

const guestBackfillJob = lazySync((sync) => {
  const handle = sync.job<null>({
    id: "auth:guest:backfill",
    delivery: { ackWaitMs: 300_000, maxAttempts: 2, backoffMs: [2000, 4000] },
  });
  syncOps.registerDeadLetters({ name: "auth:guest:backfill", kind: "job", store: handle.deadLetters });
  return handle;
});
const processGuestBackfillJob = async (ctx: JobContext<null>): Promise<void> => {
  await trace.withSpan(
    {
      name: "Guest expiry backfill",
      source: "auth:guest:backfill",
      appId: "core",
      category: "job",
      kind: "consumer",
    },
    async () => {
      if (ctx.signal.aborted) return abortedSummary();
      const summary = await accountLifecycle.runGuestBackfill();
      guestBackfillLog.info("Guest expiry backfill complete", toBackfillLog(summary));
      return summary;
    },
    { summarize: (summary) => summary },
  );
};

const localUserBackfillJob = lazySync((sync) => {
  const handle = sync.job<null>({
    id: "auth:local-user:backfill",
    delivery: { ackWaitMs: 300_000, maxAttempts: 2, backoffMs: [2000, 4000] },
  });
  syncOps.registerDeadLetters({ name: "auth:local-user:backfill", kind: "job", store: handle.deadLetters });
  return handle;
});
const processLocalUserBackfillJob = async (ctx: JobContext<null>): Promise<void> => {
  await trace.withSpan(
    {
      name: "Local user expiry backfill",
      source: "auth:local-user:backfill",
      appId: "core",
      category: "job",
      kind: "consumer",
    },
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

const lifecycleScheduler = lazySync((sync) => {
  const handle = sync.scheduler({ id: "auth-lifecycle", delivery: { maxAttempts: 1 } });
  syncOps.registerScheduler({ name: "auth-lifecycle", scheduler: handle });
  return handle;
});

let started = false;
let workers: Worker[] = [];
let registered = false;
let registerPromise: Promise<void> | null = null;

/**
 * Register (or update) a cron-triggered schedule that fans out to the given
 * job. `scheduler.create` is idempotent by id — same cron/tz keeps `nextRunAt`
 * intact; a change resets it. We submit one dispatch per slot using the slot
 * timestamp as idempotency key so misfires don't double-run.
 */
const createSchedule = async (config: {
  id: string;
  cron: string;
  tz: string;
  family: string;
  label: string;
  source?: string;
  submit: (key: string) => Promise<unknown>;
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
    process: async (ctx) => {
      await config.submit(`slot:${ctx.slot.getTime()}`);
    },
  });
};

const createScheduleWithFallback = async (config: {
  id: string;
  cron: string;
  fallbackCron: string;
  tz: string;
  submit: (key: string) => Promise<unknown>;
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
    submit: (key) => ipaSyncJob().submit({ key, input: null, coalesce: true }),
  });

  await createSchedule({
    id: "auth:reminder:daily",
    cron: reminderCron,
    tz: scheduleTz,
    family: "auth:reminders",
    label: "Daily account reminders",
    submit: (key) => reminderJob().submit({ key, input: null, coalesce: true }),
  });

  await createSchedule({
    id: "auth:guest:cleanup",
    cron: cleanupCron,
    tz: scheduleTz,
    family: "auth:cleanup",
    label: "Guest account cleanup",
    submit: (key) => guestCleanupJob().submit({ key, input: null, coalesce: true }),
  });

  await createSchedule({
    id: "auth:local-user:cleanup",
    cron: cleanupCron,
    tz: scheduleTz,
    family: "auth:cleanup",
    label: "Local user cleanup",
    submit: (key) => localUserCleanupJob().submit({ key, input: null, coalesce: true }),
  });

  await createSchedule({
    id: "auth:lifecycle:audit:cleanup",
    cron: cleanupCron,
    tz: scheduleTz,
    family: "auth:cleanup",
    label: "Account lifecycle audit cleanup",
    submit: (key) => auditCleanupJob().submit({ key, input: null, coalesce: true }),
  });

  await createSchedule({
    id: "app:logs:cleanup",
    cron: cleanupCron,
    tz: scheduleTz,
    family: "app:cleanup",
    label: "Application log cleanup",
    submit: (key) => logCleanupJob().submit({ key, input: null, coalesce: true }),
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
      workers.push(await ipaBackfillJob().process({}, processIpaBackfillJob));
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

  // Manual-only backfill triggers. Scheduled jobs are run through schedulerControl.
  submitIpaBackfill: async (): Promise<string> => (await ipaBackfillJob().submit({ key: `manual:${Date.now()}`, input: null })).jobId,
  submitLocalUserBackfill: async (): Promise<string> =>
    (await localUserBackfillJob().submit({ key: `manual:${Date.now()}`, input: null })).jobId,
  submitGuestBackfill: async (): Promise<string> => (await guestBackfillJob().submit({ key: `manual:${Date.now()}`, input: null })).jobId,

  metrics: () => ({
    started,
    registered,
    active: workers.reduce((total, worker) => total + worker.active, 0),
    capacity: workers.reduce((total, worker) => total + worker.capacity, 0),
  }),
  listSchedules: async () => lifecycleScheduler().list(),
};
