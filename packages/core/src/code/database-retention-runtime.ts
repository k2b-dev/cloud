import { lazySync } from "@k2b/cloud";
import type { Worker } from "@k2b/sync";
import type { CoreNotificationSender } from "../notifications";
import { codeDatabaseDeletionOutbox, expireUnusedCodeDatabases, notifyUnusedCodeDatabases } from "./database-retention";

const scheduler = lazySync((sync) =>
  sync.scheduler({ id: "code-database-retention", owner: "core", delivery: { maxAttempts: 1, ackWaitMs: 60_000 } }),
);
let worker: Worker | undefined;
let shutdown: AbortController | undefined;
export const codeDatabaseRetentionRuntime = {
  async start(sender: Pick<CoreNotificationSender, "sendCodeDatabaseExpiry">) {
    shutdown = new AbortController();
    const stopped = shutdown.signal;
    await scheduler().create({
      id: "expire",
      cron: "*/5 * * * *",
      timezone: "UTC",
      misfire: "latest",
      process: async ({ signal }) => {
        const runSignal = AbortSignal.any([signal, stopped, AbortSignal.timeout(20_000)]);
        await expireUnusedCodeDatabases(new Date(), runSignal);
        await notifyUnusedCodeDatabases(sender, new Date(), runSignal);
      },
    });
    worker = await scheduler().process({ concurrency: 1 });
    codeDatabaseDeletionOutbox.start();
  },
  async stop() {
    shutdown?.abort();
    worker?.stop();
    await worker?.drain();
    worker = undefined;
    await codeDatabaseDeletionOutbox.stop();
  },
};
