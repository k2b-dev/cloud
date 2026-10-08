import type { Worker } from "@k2b/sync";
import { lazySync } from "../../_internal/process-sync";
import { logger } from "../logging";
import { createRuntimeLifecycle, createRuntimeTaskTracker, stopRuntimeJobs } from "../runtime-lifecycle";
import { processOutgoingMail, recoverOutgoingMail } from "./dispatcher";
import { retainOutgoingMail } from "./retention";
import { mailAttachments, mailSendJob, mailSettled, submitMail } from "./sync";

const log = logger("outgoing-mail");
const scheduler = lazySync((sync) =>
  sync.scheduler({ id: "cloud-outgoing-mail-retention", owner: "core", delivery: { maxAttempts: 2, backoffMs: [30_000] } }),
);
const tasks = createRuntimeTaskTracker();
let worker: Worker | undefined;
let retentionWorker: Worker | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let recovering: Promise<void> | undefined;
const recover = (): Promise<void> => {
  recovering ??= (
    tasks.run(async () => {
      try {
        for (const id of await recoverOutgoingMail()) await submitMail(id);
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
    await scheduler().create({
      id: "daily",
      cron: "0 0 * * *",
      timezone: "UTC",
      misfire: "latest",
      process: async ({ signal }) => retainOutgoingMail(signal),
    });
    retentionWorker = await scheduler().process({ concurrency: 1 });
    await recover();
    timer = setInterval(() => void recover(), 30_000);
    timer.unref();
  },
  stop: async () => {
    clearInterval(timer);
    timer = undefined;
    await stopRuntimeJobs(
      tasks,
      [worker, retentionWorker].filter((item): item is Worker => item !== undefined),
    );
    worker = undefined;
    retentionWorker = undefined;
  },
});
export const startOutgoingMailRuntime = lifecycle.start;
export const stopOutgoingMailRuntime = lifecycle.stop;
