/** Keep an app discoverable even when the ephemeral registry is recreated. */

import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { APP_REGISTRY_TTL_MS, type AppInstanceRecord, appInstancePrefix } from "./registry";

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

type SnapshotRegistry<T> = {
  snapshot: (input: { prefix: string }) => Promise<{ entries: { key: string; value: T }[] }>;
};

type MembershipRegistry = HeartbeatRegistry<AppInstanceRecord> & SnapshotRegistry<AppInstanceRecord>;

type SharedEntry = {
  read: () => Promise<{ value: unknown } | undefined>;
  write: () => Promise<unknown>;
  remove: () => Promise<unknown>;
  prepare: (() => Promise<void>) | undefined;
};

const entryDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("base64url");

type MembershipLock = {
  withLock: <T>(
    input: { resource: string; ttlMs?: number; signal?: AbortSignal },
    fn: (lock: { expiresAt: Date }) => Promise<T>,
  ) => Promise<T | null>;
};

/** One process membership shared by its app and capability heartbeats. Getters stay lazy until use. */
export const createRegistryMembership = (
  appId: string,
  options: {
    registry: () => MembershipRegistry;
    lock: () => MembershipLock;
    instanceId?: string;
    hostname?: string;
    startedAt?: number;
    writeTimeoutMs?: number;
  },
) => {
  const instanceId = options.instanceId ?? randomBytes(12).toString("base64url");
  const prefix = appInstancePrefix(appId);
  const key = `${prefix}${instanceId}`;
  const value: AppInstanceRecord = {
    appId,
    instanceId,
    hostname: options.hostname ?? hostname(),
    startedAt: options.startedAt ?? Date.now(),
    entries: {},
  };
  const writeTimeoutMs = options.writeTimeoutMs ?? HEARTBEAT_WRITE_TIMEOUT_MS;
  if (!Number.isFinite(writeTimeoutMs) || writeTimeoutMs <= 0) throw new RangeError("Membership write timeout must be positive and finite");
  let left = false;
  const sharedEntries = new Map<string, SharedEntry>();

  // Prepare idempotent dependent data outside the lock to preserve its bounded lease.
  const prepareShared = async (sharedKey: string): Promise<void> => {
    for (const [key, { prepare }] of sharedEntries) {
      if (key !== sharedKey) await prepare?.();
    }
  };

  const locked = async (write: (lock: { expiresAt: Date }) => Promise<void>): Promise<void> => {
    const result = await options
      .lock()
      .withLock({ resource: appId, ttlMs: writeTimeoutMs, signal: AbortSignal.timeout(writeTimeoutMs) }, async (lock) => {
        await write(lock);
        return true;
      });
    if (result === null) throw new Error(`Registry membership lock unavailable for app ${appId}`);
  };
  const upsert = () => options.registry().upsert({ key, value });
  const publishShared = async (): Promise<void> => {
    if (left) return;
    await upsert();
    // Never mix entries from different processes: the capability catalog rejects mismatched manifests.
    for (const { write } of sharedEntries.values()) {
      if (left) return;
      await write();
    }
  };

  return {
    join: async (sharedKey: string, sharedValue: unknown, entry: SharedEntry): Promise<void> => {
      left = false;
      await prepareShared(sharedKey);
      await locked(async () => {
        value.entries[sharedKey] = entryDigest(sharedValue);
        sharedEntries.set(sharedKey, entry);
        await publishShared();
      });
    },
    publish: async (sharedKey: string): Promise<void> => {
      if (left) return;
      await prepareShared(sharedKey);
      await locked(async () => {
        if (left) return;
        await publishShared();
      });
    },
    adopt: async (sharedKey: string): Promise<void> => {
      if (left) return;
      // A live process started after this one covers stored state when all read keys it declares match.
      // Ignore keys it never registered, but heal split pairs when both keys are declared.
      // Start order is total (instance id breaks ties), so two live replicas never take turns.
      const startedLater = (other: AppInstanceRecord): boolean =>
        other.startedAt > value.startedAt || (other.startedAt === value.startedAt && other.instanceId > value.instanceId);
      const needsRepublish = async (): Promise<boolean> => {
        const stored = await Promise.all(
          [...sharedEntries].map(async ([key, { read }]) => {
            const entry = await read();
            return { key, digest: entry ? entryDigest(entry.value) : undefined };
          }),
        );
        if (stored.some(({ digest }) => digest === undefined)) return false;
        if (stored.every(({ key, digest }) => digest === value.entries[key])) return false;
        const snapshot = await options.registry().snapshot({ prefix });
        return !snapshot.entries.some(
          ({ value }) =>
            startedLater(value) &&
            stored.some(({ key }) => key in value.entries) &&
            stored.every(({ key, digest }) => !(key in value.entries) || value.entries[key] === digest),
        );
      };
      if (!(await needsRepublish())) return;
      await prepareShared(sharedKey);
      await locked(async (lock) => {
        if (left) return;
        const stillNeedsRepublish = await needsRepublish();
        if (left || !stillNeedsRepublish) return;
        if (Date.now() > lock.expiresAt.getTime() - writeTimeoutMs / 2) {
          throw new Error("membership lease expired during adoption; shared entry left to its TTL");
        }
        await publishShared();
      });
    },
    renew: async (): Promise<void> => {
      if (left) return;
      if (!(await options.registry().touch({ key }))) {
        await locked(async () => {
          if (!left) await upsert();
        });
      }
    },
    leave: async (): Promise<void> => {
      left = true;
      // A failed delete must never lead to shared removal: leave routing to its TTL.
      // Repeat the delete even after leaving, to remove a late registration write.
      await options.registry().delete({ key });
      await locked(async (lock) => {
        const snapshot = await options.registry().snapshot({ prefix });
        // Ephemeral has no conditional delete, so the remaining lease bounds the removal window.
        // A delete that NATS applies only after the lease expired can still remove a newer
        // replica's entry; that replica restores it on its next refresh (at most 60 s).
        if (Date.now() > lock.expiresAt.getTime() - writeTimeoutMs / 2) {
          throw new Error("membership lease expired during stop; shared entry left to its TTL");
        }
        if (!snapshot.entries.some((entry) => entry.key !== key)) {
          for (const { remove } of sharedEntries.values()) {
            if (Date.now() > lock.expiresAt.getTime() - writeTimeoutMs / 2) {
              throw new Error("membership lease expired during stop; shared entry left to its TTL");
            }
            await remove();
          }
        }
      });
    },
  };
};

type HeartbeatOptions<T> = {
  key?: string;
  /** Publish dependent data before advertising or renewing the app. */
  beforeWrite?: () => Promise<void>;
  intervalMs?: number;
  retryMs?: number;
  staleAfterMs?: number;
  writeTimeoutMs?: number;
  onError?: (error: unknown) => void;
  onStale?: (error: unknown) => void;
} & (
  | { registry: HeartbeatRegistry<T>; membership?: undefined }
  | { registry: HeartbeatRegistry<T> & SnapshotRegistry<T>; membership: ReturnType<typeof createRegistryMembership> }
);

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
  let needsMembershipCleanup = false;
  let lastSuccessAt = 0;
  let staleReported = false;
  const key = options.key ?? `apps/${appId}`;

  const noteSuccess = (): void => {
    if (!running) return;
    lastSuccessAt = Date.now();
    staleReported = false;
  };

  const remove = () => (options.membership ? options.membership.leave() : registry.delete({ key }));
  const upsert = () => registry.upsert({ key, value: entry });

  const register = async (): Promise<void> => {
    await options.beforeWrite?.();
    if (options.membership) {
      const registry = options.registry;
      await options.membership.join(key, entry, {
        read: async () => (await registry.snapshot({ prefix: key })).entries.find((candidate) => candidate.key === key),
        write: upsert,
        remove: () => registry.delete({ key }),
        prepare: options.beforeWrite,
      });
    } else await upsert();
    noteSuccess();
  };

  const refresh = async (): Promise<void> => {
    // Touch renews the existing entry (and emits a registry invalidation).
    // Avoid rebuilding the manifest here. A missing entry is repaired
    // immediately, preserving restart-free registry recovery. The newest live
    // publisher wins; an entry whose publisher left is replaced by this one.
    await options.beforeWrite?.();
    await options.membership?.renew();
    const touched = await registry.touch({ key });
    if (!touched) {
      if (options.membership) await options.membership.publish(key);
      else await upsert();
    } else if (options.membership) {
      await options.membership.adopt(key);
    }
    noteSuccess();
  };

  const writeWithTimeout = async (write: Promise<void>): Promise<void> => {
    let timer: Timer | null = null;
    let timedOut = false;
    // A write that settled after its timeout must not resurrect a stopped app. A failed
    // operation may still have landed earlier steps, such as the liveness key.
    const removeLateWrite = async () => {
      if (timedOut && !running) await remove().catch(() => false);
    };
    void write.then(removeLateWrite, removeLateWrite).catch(() => undefined);
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
      needsMembershipCleanup = options.membership !== undefined;
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
      if (!running && !needsMembershipCleanup) return;
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
      await remove();
      needsMembershipCleanup = false;
    },
  };
};
