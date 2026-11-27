import { sql } from "@k2b/cloud";

/**
 * The counts Mail's caches run against Postgres when a key is cold or Valkey is down (the view counts, the year of
 * mail) share one budget per process: one fewer than the pool has connections, so a cold morning or a cache outage
 * always leaves one connection for the rest of Mail. Each cache decides what it does when the budget is spent.
 */
const running = new Set<Promise<unknown>>();

/** How many cached-read counts may run at once in this process, all caches together. */
export const cachedReadLoadLimit = (): number => Math.max(1, (sql.options.max ?? 10) - 1);

/** How many run now. */
export const cachedReadLoadsRunning = (): number => running.size;

/** Settles when one of the running counts settles, or at once when none runs. */
export const cachedReadLoadSettled = (): Promise<unknown> =>
  running.size === 0 ? Promise.resolve() : Promise.race([...running].map((task) => task.catch(() => undefined)));

/** Runs one count and keeps it in the shared budget while it runs. The caller checks the budget first. */
export const trackCachedReadLoad = async <T>(load: () => Promise<T>): Promise<T> => {
  const task = load();
  running.add(task);
  try {
    return await task;
  } finally {
    running.delete(task);
  }
};
