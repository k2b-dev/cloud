import { logger } from "@k2b/cloud/services";
import { expireCodeRuns } from "./store";

/** Core lifecycle owns one bounded batch per minute; replicas skip each other's locked rows. Stop drains the in-flight batch. */
export const startCodeRunRetention = (): (() => Promise<void>) => {
  let pending: Promise<void> | undefined;
  const sweep = () => {
    if (pending) return;
    pending = expireCodeRuns({ now: new Date(), limit: 1000 })
      .then(() => undefined)
      .catch((error) => {
        logger("core:code-retention").error("Code run retention failed; the next sweep will retry", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        pending = undefined;
      });
  };
  sweep();
  const timer = setInterval(sweep, 60_000);
  timer.unref?.();
  return async () => {
    clearInterval(timer);
    await pending;
  };
};
