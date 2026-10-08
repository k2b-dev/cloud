import { lazySync } from "@k2b/cloud";
import { listImapMailProfiles } from "@k2b/cloud/services/outgoing-mail/store";
import type { Worker } from "@k2b/sync";
import { createImapBounceMailbox } from "./imap";
import { abortable, BOUNCE_ERROR_WRITE_BUDGET_MS, pollProfileBounces } from "./poller";

export const BOUNCE_RUN_BUDGET_MS = 4 * 60_000;
export const BOUNCE_ACK_WAIT_MS = BOUNCE_RUN_BUDGET_MS + BOUNCE_ERROR_WRITE_BUDGET_MS + 30_000;
const scheduler = lazySync((sync) =>
  sync.scheduler({
    id: "cloud-outgoing-mail-bounces",
    owner: "core",
    delivery: { maxAttempts: 1, ackWaitMs: BOUNCE_ACK_WAIT_MS },
  }),
);
let worker: Worker | undefined;
let shutdown: AbortController | undefined;
export const pollOutgoingMailBounces = async (signal: AbortSignal): Promise<void> => {
  if (signal.aborted) return;
  const budget = AbortSignal.timeout(BOUNCE_RUN_BUDGET_MS);
  const runSignal = AbortSignal.any([signal, budget]);
  const profiles = await abortable(listImapMailProfiles, runSignal).catch((error: unknown) => {
    if (runSignal.aborted) return [];
    throw error;
  });
  for (const profile of profiles) {
    if (runSignal.aborted) break;
    await pollProfileBounces(profile, () => createImapBounceMailbox(profile, runSignal), runSignal);
  }
};
export const outgoingMailBounceRuntime = {
  async start() {
    if (worker) return;
    shutdown = new AbortController();
    const shutdownSignal = shutdown.signal;
    await scheduler().create({
      id: "poll",
      cron: "*/5 * * * *",
      timezone: "UTC",
      misfire: "latest",
      process: async ({ signal }) => pollOutgoingMailBounces(AbortSignal.any([signal, shutdownSignal])),
    });
    worker = await scheduler().process({ concurrency: 1 });
  },
  async stop() {
    const current = worker;
    worker = undefined;
    shutdown?.abort();
    shutdown = undefined;
    current?.stop();
    await current?.drain();
  },
};
