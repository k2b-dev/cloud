import type { Mutex } from "@k2b/sync";
import { expBackoff } from "@k2b/sync/retry";
import { logger } from "../services/logging";
import { lazySync, waitForNats } from "./process-sync";

const SETUP_LEASE_MS = 60_000;
const setupMutex = lazySync((sync) => sync.mutex({ id: "app-setup", owner: "cloud", ttlMs: SETUP_LEASE_MS, retry: { maxAttempts: 1 } }));

const scheduleRenewal = (renew: () => Promise<void> | undefined, intervalMs: number): (() => void) => {
  const timer = setInterval(() => void renew(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
};

/** Internal seam for testing lease timing without NATS or wall-clock waits. */
export const runExclusive = async ({
  mutex,
  resource,
  run,
  leaseMs = SETUP_LEASE_MS,
  sleep = Bun.sleep,
  now = Date.now,
  schedule = scheduleRenewal,
  log = logger("setup"),
}: {
  mutex: Pick<Mutex, "ready" | "acquire" | "extend" | "release">;
  resource: string;
  run: () => Promise<void>;
  leaseMs?: number;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
  schedule?: typeof scheduleRenewal;
  log?: Pick<ReturnType<typeof logger>, "info" | "warn" | "error">;
}): Promise<void> => {
  const startedAt = now();
  const nats = { application: resource };
  await waitForNats(() => mutex.ready(), nats);
  let lastWaitLog = Number.NEGATIVE_INFINITY;
  let attempt = 1;
  let lock = await waitForNats(() => mutex.acquire({ resource }), nats);
  while (!lock) {
    if (now() - lastWaitLog >= 30_000) {
      lastWaitLog = now();
      log.info("waiting for setup on another replica", { appId: resource, waitedMs: now() - startedAt });
    }
    await sleep(Math.min(2_000, expBackoff(attempt++, { baseMs: 250, maxMs: 2_000, jitter: 0.2 })));
    lock = await waitForNats(() => mutex.acquire({ resource }), nats);
  }

  const lease = lock;
  let lost = false;
  let running = true;
  let confirmedExpiresAt = lease.expiresAt.getTime();
  let renewing: Promise<void> | undefined;
  const checkExpiry = () => {
    if (running && now() >= confirmedExpiresAt) lost = true;
  };
  const cancelRenewal = schedule(() => {
    // Check even when an earlier extend is still in flight or the event loop was delayed.
    checkExpiry();
    if (renewing || lost) return;
    renewing = (async () => {
      try {
        const extended = await mutex.extend(lease);
        // extend mutates the handle; check the previous confirmed expiry first.
        checkExpiry();
        if (extended) confirmedExpiresAt = lease.expiresAt.getTime();
        else lost = true;
      } catch (error) {
        log.warn("setup lease renewal failed", { appId: resource, error });
        checkExpiry();
      }
    })().finally(() => {
      renewing = undefined;
    });
    return renewing;
  }, leaseMs / 3);

  try {
    try {
      await run();
    } finally {
      checkExpiry();
      running = false;
      cancelRenewal();
      // Do not race a release against an unfinished renewal.
      await renewing;
      if (lost) {
        log.error("setup lease lost; another replica may have run setup concurrently; restarting so setup reruns", { appId: resource });
      }
    }
    if (lost) throw new Error(`Setup lease lost for application "${resource}"`);
  } finally {
    try {
      if (!(await mutex.release(lease))) log.warn("setup lease release failed; it will expire", { appId: resource });
    } catch (error) {
      log.warn("setup lease release failed; it will expire", { appId: resource, error });
    }
  }
};

export const runSetupExclusively = (appId: string, setup: () => Promise<void>): Promise<void> =>
  runExclusive({ mutex: setupMutex(), resource: appId, run: setup });
