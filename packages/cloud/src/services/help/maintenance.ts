import { logger } from "../logging";
import { cleanupHelp } from "./store";

const log = logger("help:maintenance");
/** Core owns the timer; stop waits for the current bounded deletion. */
export const startHelpMaintenance = (): (() => Promise<void>) => {
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const run = () => {
    inFlight = cleanupHelp()
      .catch((error) => {
        log.error("Expired Help cleanup failed", { error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(run, 60_000);
      });
  };
  timer = setTimeout(run, 60_000);
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await inFlight;
  };
};
