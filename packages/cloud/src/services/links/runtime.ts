import { lazySync } from "../../_internal/process-sync";
import { sql } from "../../runtime/clients";
import { logger } from "../logging";
import { cleanupLinksBatch, LINK_CLEANUP_BATCH, setupLinks } from "./store";

// All apps compete for one platform schedule, including replicas and apps sharing a package.
const scheduler = lazySync((sync) =>
  sync.scheduler({
    id: "cloud-links-retention",
    owner: "platform",
    delivery: { maxAttempts: 2, backoffMs: [30_000], ackWaitMs: 60_000 },
  }),
);

/** Provision before app setup and readiness, then drain this worker before NATS during shutdown. */
export const startLinksRuntime = async (): Promise<() => Promise<void>> => {
  await setupLinks(sql);
  const stopping = new AbortController();
  await scheduler().create({
    id: "retention",
    cron: "0 * * * *",
    timezone: "UTC",
    misfire: "latest",
    meta: { family: "links", label: "One-time link cleanup" },
    process: async ({ signal, heartbeat }) => {
      const runSignal = AbortSignal.any([signal, stopping.signal]);
      const deadline = performance.now() + 5 * 60_000;
      let deleted = 0;
      while (!runSignal.aborted && performance.now() < deadline) {
        const count = await cleanupLinksBatch(sql);
        deleted += count;
        if (count < LINK_CLEANUP_BATCH) break;
        await heartbeat();
      }
      if (deleted > 0) logger("links:cleanup").info("Removed old one-time links", { deleted });
    },
  });
  const worker = await scheduler().process({ concurrency: 1 });
  return async () => {
    stopping.abort();
    worker.stop();
    await worker.drain({ timeoutMs: 30_000 });
  };
};
