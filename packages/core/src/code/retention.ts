import { logger, startRuntimeInterval } from "@k2b/cloud/services";
import { expireCodeChatDrafts } from "./chat-drafts";
import { expireCodePageReports } from "./page-reports";
import { expireCodeRuns } from "./store";

/** Core lifecycle owns one bounded batch per minute; replicas skip each other's locked rows. Stop drains the in-flight batch. */
export const startCodeRunRetention = (): (() => Promise<void>) => {
  const retention = startRuntimeInterval({
    intervalMs: 60_000,
    run: async () => {
      await expireCodeRuns({ now: new Date(), limit: 1000 });
      await expireCodeChatDrafts({ now: new Date(), limit: 1000 });
      await expireCodePageReports({ now: new Date(), limit: 1000 });
    },
    onError: (error) => {
      logger("core:code-retention").error("Code run retention failed; the next sweep will retry", {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
  return () => retention.stop();
};
