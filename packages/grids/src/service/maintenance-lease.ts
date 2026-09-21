import { logger } from "@k2b/cloud/services";
import type { Mutex } from "@k2b/sync";

const log = logger("grids:maintenance-lease");

/**
 * Runs `run` while holding a broker lease, or returns `null` when another
 * process holds it. Maintenance work coordinates through `@k2b/sync` leases
 * rather than Postgres session locks because `DATABASE_URL` may run through a
 * transaction pooler, which does not pin a backend between statements.
 *
 * A live holder extends its lease every third of `ttlMs`, so the work is not
 * bounded by the TTL; a crashed holder frees the lease after at most `ttlMs`.
 * A lost lease cannot abort `run` safely: the work is idempotent, so the loss
 * is logged and the extension stops.
 */
export const withMaintenanceLease = async <T>(mutex: Mutex, resource: string, ttlMs: number, run: () => Promise<T>): Promise<T | null> => {
  const lock = await mutex.acquire({ resource, ttlMs });
  if (!lock) return null;
  let held = true;
  let finished = false;
  const extend = async () => {
    const extended = await mutex.extend(lock, { ttlMs }).catch(() => false);
    if (extended || finished || !held) return;
    held = false;
    clearInterval(timer);
    log.warn("Maintenance lease was lost before the work finished", { resource });
  };
  const timer = setInterval(() => void extend(), Math.floor(ttlMs / 3));
  timer.unref?.();
  try {
    return await run();
  } finally {
    finished = true;
    clearInterval(timer);
    if (held) await mutex.release(lock).catch(() => undefined);
  }
};
