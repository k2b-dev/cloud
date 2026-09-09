import { logger } from "@k2b/cloud/services";
import { runFieldIndexMaintenanceBatch } from "./field-indexes";

const log = logger("grids:field-index-maintenance");
const BUSY_RETRY_MS = 5_000;
const CONTINUE_DELAY_MS = 250;
const IDLE_INTERVAL_MS = 5 * 60_000;

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let currentRun: Promise<void> | null = null;

const schedule = (delayMs: number): void => {
  if (!running) return;
  timer = setTimeout(() => {
    timer = null;
    const task = run();
    currentRun = task;
    void task.finally(() => {
      if (currentRun === task) currentRun = null;
    });
  }, delayMs);
  timer.unref?.();
};

const run = async (): Promise<void> => {
  try {
    const result = await runFieldIndexMaintenanceBatch();
    if (result.changed > 0) log.info("Maintained field indexes", { changed: result.changed });
    schedule(!result.claimed ? BUSY_RETRY_MS : result.hasMore ? CONTINUE_DELAY_MS : IDLE_INTERVAL_MS);
  } catch (error) {
    log.error("Field index maintenance failed", { error: String(error) });
    schedule(BUSY_RETRY_MS);
  }
};

export const startFieldIndexMaintenance = (): void => {
  if (running) return;
  running = true;
  schedule(0);
};

export const stopFieldIndexMaintenance = async (): Promise<void> => {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  await currentRun;
};
