/** Keep an app discoverable even when the ephemeral registry is recreated. */

import { APP_REGISTRY_TTL_MS } from "./registry";

const HEARTBEAT_INTERVAL_MS = 60_000;
const HEARTBEAT_WRITE_TIMEOUT_MS = 10_000;
const HEARTBEAT_RETRY_MS = 5_000;
const HEARTBEAT_STALE_MARGIN_MS = 15_000;

/** The subset of a @k2b/sync `Ephemeral<T>` the heartbeat needs. */
type HeartbeatRegistry<T> = {
  upsert: (input: { key: string; value: T }) => Promise<unknown>;
  /** Renews the lease; false when the key is absent. */
  touch: (input: { key: string }) => Promise<boolean>;
  delete: (input: { key: string }) => Promise<unknown>;
};

type HeartbeatOptions<T> = {
  registry: HeartbeatRegistry<T>;
  key?: string;
  intervalMs?: number;
  retryMs?: number;
  staleAfterMs?: number;
  writeTimeoutMs?: number;
  onError?: (error: unknown) => void;
  onStale?: (error: unknown) => void;
};

export const createHeartbeat = <T>(appId: string, entry: T, options: HeartbeatOptions<T>) => {
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const retryMs = options.retryMs ?? Math.min(HEARTBEAT_RETRY_MS, intervalMs);
  const staleAfterMs = options.staleAfterMs ?? APP_REGISTRY_TTL_MS - HEARTBEAT_STALE_MARGIN_MS;
  const writeTimeoutMs = options.writeTimeoutMs ?? HEARTBEAT_WRITE_TIMEOUT_MS;
  const registry = options.registry;
  const onError = options.onError ?? ((error: unknown) => console.error(`[app:${appId}] Registry heartbeat failed`, error));
  const onStale = options.onStale;

  if (![intervalMs, retryMs, staleAfterMs, writeTimeoutMs].every((value) => Number.isFinite(value) && value > 0)) {
    throw new RangeError("Heartbeat timings must be positive finite numbers");
  }

  let timer: Timer | null = null;
  let inFlight: Promise<void> | null = null;
  let running = false;
  let lastSuccessAt = 0;
  let staleReported = false;
  const key = options.key ?? `apps/${appId}`;

  const noteSuccess = (): void => {
    if (!running) return;
    lastSuccessAt = Date.now();
    staleReported = false;
  };

  const register = async (): Promise<void> => {
    await registry.upsert({ key, value: entry });
    noteSuccess();
  };

  const refresh = async (): Promise<void> => {
    // Touch renews the existing entry (and emits a registry invalidation).
    // Avoid rebuilding the manifest here. A missing entry is repaired
    // immediately, preserving restart-free registry recovery.
    const touched = await registry.touch({ key });
    if (!touched) await registry.upsert({ key, value: entry });
    noteSuccess();
  };

  const writeWithTimeout = async (write: Promise<void>): Promise<void> => {
    let timer: Timer | null = null;
    let timedOut = false;
    void write
      .then(async () => {
        // A write that completed after its timeout must not resurrect a stopped app.
        if (timedOut && !running) await registry.delete({ key }).catch(() => false);
      })
      .catch(() => undefined);
    try {
      await Promise.race([
        write,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error(`Registry write timed out after ${writeTimeoutMs}ms`));
          }, writeTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const refreshWithTimeout = (): Promise<void> => writeWithTimeout(refresh());

  const reportError = (error: unknown): void => {
    try {
      onError(error);
    } catch {
      // Error reporting must never stop future registration attempts.
    }
    if (!staleReported && lastSuccessAt > 0 && Date.now() - lastSuccessAt >= staleAfterMs) {
      staleReported = true;
      try {
        onStale?.(error);
      } catch {
        // A failed stale callback must not disable heartbeat recovery.
      }
    }
  };

  const schedule = (delayMs: number) => {
    if (!running || timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!running) return;

      let nextDelayMs = intervalMs;
      const operation = refreshWithTimeout();
      inFlight = operation;
      void operation
        .catch((error) => {
          nextDelayMs = retryMs;
          reportError(error);
        })
        .finally(() => {
          if (inFlight === operation) inFlight = null;
          schedule(nextDelayMs);
        });
    }, delayMs);
  };

  return {
    start: async () => {
      if (running) {
        await inFlight;
        return;
      }
      running = true;
      const operation = writeWithTimeout(register());
      inFlight = operation;
      try {
        await operation;
      } catch (error) {
        running = false;
        throw error;
      } finally {
        if (inFlight === operation) inFlight = null;
      }
      schedule(intervalMs);
    },
    stop: async () => {
      if (!running) return;
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;

      try {
        await inFlight;
      } catch {
        // Recurring heartbeat failures are already reported above. Removal is
        // still required so a stopped app cannot remain discoverable.
      }
      inFlight = null;
      await registry.delete({ key });
    },
  };
};
