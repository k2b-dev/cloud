import { logger } from "../logging";

const log = logger("auth:deferred");

/**
 * Enumeration-safe requests answer before their lookup and delivery run. That
 * work takes a few Postgres and Valkey round trips, so the backlog stays near
 * zero; it reaches this limit only while a backend stalls. Further requests
 * are then dropped until the backlog shrinks. Their answer is the same either
 * way, so dropping reveals nothing.
 */
export const MAX_DEFERRED_REQUESTS = 100;

const running = new Set<Promise<void>>();
let dropped = 0;

/**
 * Starts `work` without holding up the caller's answer. The returned promise
 * settles when the work has finished or was dropped; it never rejects.
 */
export const run = (label: string, work: () => Promise<void>): Promise<void> => {
  if (running.size >= MAX_DEFERRED_REQUESTS) {
    // One entry per overload episode; a log row per dropped request would add load.
    if (dropped++ === 0) log.warn("Dropping sign-in requests while the backlog is full", { limit: MAX_DEFERRED_REQUESTS });
    return Promise.resolve();
  }
  if (dropped > 0) {
    log.warn("Accepting sign-in requests again", { dropped });
    dropped = 0;
  }
  const task: Promise<void> = work()
    .catch((error) => log.error(`${label} failed`, { error: error instanceof Error ? error.message : String(error) }))
    .finally(() => running.delete(task));
  running.add(task);
  return task;
};

/** Waits for accepted work so a graceful shutdown does not lose it. */
export const drain = async (): Promise<void> => {
  await Promise.all(running);
};
