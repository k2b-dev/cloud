import type { Worker } from "@k2b/sync";
import { lazySync } from "../../_internal/process-sync";
import { logger } from "../logging";
import { createRuntimeLifecycle, createRuntimeTaskTracker, stopRuntimeJobs } from "../runtime-lifecycle";
import { MAIL_RECOVERY_MS } from "./bulk";
import { processOutgoingMail, recoverOutgoingMail } from "./dispatcher";
import { drainOutgoingMail, dueOutgoingBulkProfiles } from "./drain";
import { retainOutgoingMail } from "./retention";
import { mailAttachments, mailDrainJob, mailSendJob, mailSettled, submitMail, submitMailDrain } from "./sync";

const log = logger("outgoing-mail");
const scheduler = lazySync((sync) =>
  sync.scheduler({ id: "cloud-outgoing-mail-retention", owner: "core", delivery: { maxAttempts: 2, backoffMs: [30_000] } }),
);
const tasks = createRuntimeTaskTracker();
let worker: Worker | undefined;
let drainWorker: Worker | undefined;
let retentionWorker: Worker | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let recovering: Promise<void> | undefined;
const recover = (): Promise<void> => {
  recovering ??= (
    tasks.run(async () => {
      try {
        for (const id of await recoverOutgoingMail()) await submitMail(id);
        for (const id of await dueOutgoingBulkProfiles()) await submitMailDrain(id);
      } catch {
        log.error("Outgoing mail recovery failed; the next scan will retry.");
      }
    }) ?? Promise.resolve()
  ).finally(() => {
    recovering = undefined;
  });
  return recovering;
};
const lifecycle = createRuntimeLifecycle({
  start: async () => {
    tasks.open();
    await Promise.all([mailAttachments().ready(), mailSettled().ready()]);
    worker = await mailSendJob().process({ concurrency: 8 }, ({ input, signal }) => processOutgoingMail(input.id, signal));
    // Heartbeats cover the last attempt beyond the 60-second claim window. Sync owns the per-key claim;
    // PostgreSQL also gates slots and claims rows if a stale run is redelivered.
    drainWorker = await mailDrainJob().process({ concurrency: 4 }, async ({ input, signal, heartbeat, resubmit }) => {
      const delayMs = await drainOutgoingMail(input.profileId, signal, heartbeat);
      if (delayMs !== undefined) resubmit({ delayMs });
    });
    await scheduler().create({
      id: "daily",
      cron: "0 0 * * *",
      timezone: "UTC",
      misfire: "latest",
      process: async ({ signal }) => retainOutgoingMail(signal),
    });
    retentionWorker = await scheduler().process({ concurrency: 1 });
    await recover();
    timer = setInterval(() => void recover(), MAIL_RECOVERY_MS);
    timer.unref();
  },
  stop: async () => {
    clearInterval(timer);
    timer = undefined;
    await stopRuntimeJobs(
      tasks,
      [worker, drainWorker, retentionWorker].filter((item): item is Worker => item !== undefined),
    );
    worker = undefined;
    drainWorker = undefined;
    retentionWorker = undefined;
  },
});
export const startOutgoingMailRuntime = lifecycle.start;
export const stopOutgoingMailRuntime = lifecycle.stop;
