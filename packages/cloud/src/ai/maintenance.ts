import type { Worker } from "@k2b/sync";
import { lazySync } from "../_internal/process-sync";
import { coreSettings } from "../services";
import { logger, trace } from "../services/logging";

import { enrichDirtyAiConversations } from "./enrich";
import { learnAiMemoriesFromPrivateChats } from "./memory-learning";

const log = logger("ai:maintenance");

export const AI_ENRICH_CRON_SETTING_KEY = "ai.enrich_cron";
export const AI_MEMORY_LEARNING_CRON_SETTING_KEY = "ai.memory_learning_cron";
const DEFAULT_ENRICH_CRON = "*/10 * * * *";

const getCronSetting = async (key: string, fallback: string): Promise<string> => {
  const value = String((await coreSettings.get<string>(key)) || "").trim();
  return value.length > 0 ? value : fallback;
};

const getTimezoneSetting = async (): Promise<string> => {
  const value = String((await coreSettings.get<string>("app.timezone")) || "").trim();
  return value.length > 0 ? value : "Europe/Berlin";
};

// ── Job ────────────────────────────────────────────────────────────────

const enrichJob = lazySync((sync) => {
  const handle = sync.job<void>({
    id: "ai:chat:enrich",
    owner: "cloud",
    delivery: { ackWaitMs: 900_000, maxAttempts: 3, backoffMs: [2_000, 4_000] },
  });

  return handle;
});
const reindexJob = lazySync((sync) => {
  const handle = sync.job<{ conversationId: string }>({
    id: "ai:chat:reindex",
    owner: "cloud",
    delivery: { ackWaitMs: 300_000, maxAttempts: 2, backoffMs: [2_000] },
  });

  return handle;
});
const memoryLearningJob = lazySync((sync) => {
  const handle = sync.job<void>({
    id: "ai:memory:learn",
    owner: "cloud",
    delivery: { ackWaitMs: 900_000, maxAttempts: 3, backoffMs: [2_000, 4_000] },
  });

  return handle;
});
const workers: Worker[] = [];

const startWorkers = async (): Promise<void> => {
  workers.push(
    await enrichJob().process({ concurrency: 1 }, async (context) => {
      const summary = await trace.withSpan(
        {
          name: "AI chat enrichment",
          source: "ai:chat:enrich",
          appId: "ai",
          category: "job",
          kind: "consumer",
          spanKey: trace.syncSpanKey("job", "ai:chat:enrich", context.jobId),
        },
        () => enrichDirtyAiConversations({ signal: context.signal, heartbeat: () => context.heartbeat() }),
        { summarize: (summary) => summary },
      );
      if (summary.scanned > 0) log.info("Chat enrichment run complete", { ...summary });
    }),
  );
  workers.push(
    await reindexJob().process({ concurrency: 1 }, async (context) => {
      await trace.withSpan(
        {
          name: "AI chat reindex (manual)",
          source: "ai:chat:reindex",
          appId: "ai",
          category: "job",
          kind: "consumer",
          spanKey: trace.syncSpanKey("job", "ai:chat:reindex", context.jobId),
        },
        () =>
          enrichDirtyAiConversations({
            conversationId: context.input.conversationId,
            signal: context.signal,
            heartbeat: () => context.heartbeat(),
          }),
        { summarize: (summary) => summary },
      );
    }),
  );
  workers.push(
    await memoryLearningJob().process({ concurrency: 1 }, async (context) => {
      const summary = await trace.withSpan(
        {
          name: "AI memory learning",
          source: "ai:memory:learn",
          appId: "ai",
          category: "job",
          kind: "consumer",
          spanKey: trace.syncSpanKey("job", "ai:memory:learn", context.jobId),
        },
        () => learnAiMemoriesFromPrivateChats({ signal: context.signal, heartbeat: () => context.heartbeat() }),
        { summarize: (summary) => summary },
      );
      if (summary.scanned > 0) log.info("Memory learning run complete", { ...summary });
    }),
  );
};

// ── Schedule ───────────────────────────────────────────────────────────

const aiScheduler = lazySync((sync) => {
  const handle = sync.scheduler({ id: "ai-maintenance", owner: "cloud", delivery: { maxAttempts: 1 } });

  return handle;
});

let started = false;
let registered = false;
let registerPromise: Promise<void> | null = null;

const createSchedule = async (config: {
  id: string;
  cron: string;
  tz: string;
  submit: (key: string) => Promise<string>;
  label: string;
  family: string;
  resourceKind: string;
  resourceId: string;
}): Promise<void> => {
  await aiScheduler().create({
    id: config.id,
    cron: config.cron,
    timezone: config.tz,
    meta: {
      appId: "ai",
      family: config.family,
      label: config.label,
      source: config.id,
      resourceKind: config.resourceKind,
      resourceId: config.resourceId,
      resourceLabel: config.label,
      detailHref: "/admin/settings?tab=ai",
    },
    process: async (context) => {
      await config.submit(`slot:${context.slot.getTime()}`);
    },
  });
};

/**
 * Coalescing submit for scheduled runs: one stable idempotency key means at
 * most one scheduled run is queued or running at a time. On slow models a run
 * can outlast the cron interval — extra slots must not pile up in the queue
 * (they would also starve manual work); the dirty scan catches up next slot.
 * The key is released on completion.
 */
const submitScheduledRun = (): Promise<string> =>
  enrichJob()
    .submit({ key: "scheduled", input: undefined, coalesce: true })
    .then((receipt) => receipt.jobId);
const submitMemoryLearning = (): Promise<string> =>
  memoryLearningJob()
    .submit({ key: "run", input: undefined, coalesce: true })
    .then((receipt) => receipt.jobId);

const doRegister = async (): Promise<void> => {
  const [tz, enrichCron, memoryLearningCron] = await Promise.all([
    getTimezoneSetting(),
    getCronSetting(AI_ENRICH_CRON_SETTING_KEY, DEFAULT_ENRICH_CRON),
    getCronSetting(AI_MEMORY_LEARNING_CRON_SETTING_KEY, DEFAULT_ENRICH_CRON),
  ]);
  try {
    await createSchedule({
      id: "ai:chat:enrich",
      cron: enrichCron,
      tz,
      submit: () => submitScheduledRun(),
      label: "Chat enrichment",
      family: "ai:chat",
      resourceKind: "ai-enrichment",
      resourceId: "chat-enrichment",
    });
  } catch (error) {
    if (enrichCron === DEFAULT_ENRICH_CRON) throw error;
    log.warn("Invalid configured enrichment cron, falling back to default", {
      key: AI_ENRICH_CRON_SETTING_KEY,
      configuredCron: enrichCron,
      fallbackCron: DEFAULT_ENRICH_CRON,
      error: error instanceof Error ? error.message : String(error),
    });
    await createSchedule({
      id: "ai:chat:enrich",
      cron: DEFAULT_ENRICH_CRON,
      tz,
      submit: () => submitScheduledRun(),
      label: "Chat enrichment",
      family: "ai:chat",
      resourceKind: "ai-enrichment",
      resourceId: "chat-enrichment",
    });
  }
  try {
    await createSchedule({
      id: "ai:memory:learn",
      cron: memoryLearningCron,
      tz,
      submit: () => submitMemoryLearning(),
      label: "Personal memory learning",
      family: "ai:memory",
      resourceKind: "ai-memory-learning",
      resourceId: "personal-memory-learning",
    });
  } catch (error) {
    if (memoryLearningCron === DEFAULT_ENRICH_CRON) throw error;
    log.warn("Invalid configured memory learning cron, falling back to default", {
      key: AI_MEMORY_LEARNING_CRON_SETTING_KEY,
      configuredCron: memoryLearningCron,
      fallbackCron: DEFAULT_ENRICH_CRON,
      error: error instanceof Error ? error.message : String(error),
    });
    await createSchedule({
      id: "ai:memory:learn",
      cron: DEFAULT_ENRICH_CRON,
      tz,
      submit: () => submitMemoryLearning(),
      label: "Personal memory learning",
      family: "ai:memory",
      resourceKind: "ai-memory-learning",
      resourceId: "personal-memory-learning",
    });
  }
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

/** AI maintenance jobs (chat enrichment). Started next to the AI runtime; leases make this horizontally safe. */
export const aiMaintenanceJobs = {
  start: async (): Promise<void> => {
    if (started) return;
    try {
      await ensureRegistered();
      await startWorkers();
      workers.push(await aiScheduler().process());
      started = true;
      await submitScheduledRun();
      await submitMemoryLearning();
    } catch (error) {
      await aiMaintenanceJobs.stop();
      throw error;
    }
  },

  stop: async (): Promise<void> => {
    const active = workers.splice(0);
    for (const worker of active) worker.stop();
    await Promise.all(active.map((worker) => worker.drain()));
    started = false;
    registered = false;
    registerPromise = null;
  },

  /** Manual full run (admin/testing). */
  submitEnrichmentRun: (): Promise<string> =>
    enrichJob()
      .submit({ key: `manual:${crypto.randomUUID()}`, input: undefined })
      .then((receipt) => receipt.jobId),

  /** Manual full memory-learning run (admin/testing). */
  submitMemoryLearningRun: (): Promise<string> => submitMemoryLearning(),

  /**
   * User-triggered reindex of one conversation on the dedicated reindex queue
   * (never waits behind scheduled batch runs). The stable per-conversation key
   * coalesces rapid clicks while a reindex is queued or running; it is
   * released on completion, so the next click after that starts a fresh run.
   * A click that joins a running reindex starts no second run; changes the
   * running pass missed stay dirty and the scheduled enrichment picks them up.
   */
  submitConversationReindex: (conversationId: string): Promise<string> =>
    reindexJob()
      .submit({
        key: `reindex:${conversationId}`,
        coalesce: true,
        input: { conversationId },
      })
      .then((receipt) => receipt.jobId),
};
