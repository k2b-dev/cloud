import { lazySync } from "@k2b/cloud";
import type { ServiceError } from "@k2b/stdlib";
import type { Lock } from "@k2b/sync";
import { redis } from "bun";
import { withLeaseHeartbeat } from "./lease-heartbeat";

export const MAIL_PROVIDER_OPERATION_LEASE_MS = 5 * 60_000;

/**
 * Jobs of one kind, such as folder syncs or sends, that one Mail process runs at once. Only the
 * job holding a remote mailbox's provider lease works on it, and the others resubmit, so each
 * place serves another mailbox: an unreachable mailbox holds one place while it waits for its
 * provider, not the queue. A provider host with as many unreachable mailboxes as places still
 * holds every place for the length of its connection timeouts.
 */
export const MAIL_PROVIDER_JOB_CONCURRENCY = 4;

export const mailProviderOperationMutex = lazySync((sync) =>
  sync.mutex({
    id: "mail:remote-resource-sync",
    ttlMs: MAIL_PROVIDER_OPERATION_LEASE_MS,
    retry: { maxAttempts: 1 },
  }),
);

/**
 * Which waiting job takes the provider lease of a remote mailbox first: a folder sync, which
 * brings in new mail, then user commands such as moves and sends, then background work such as
 * body hydration.
 */
export type ProviderLeasePriority = "sync" | "command" | "background";

// A waiter counts as having waited this much longer than it has. A lower priority therefore lets
// a higher one that starts waiting after it go first for at most the difference, 30 seconds per
// step, and then takes its turn: no waiter starves.
const LEASE_HEAD_START_MS: Record<ProviderLeasePriority, number> = { sync: 60_000, command: 30_000, background: 0 };

// Waiters retry while they wait, the next in line most often. A waiter counts as present until
// its retry is due plus a grace for a busy job queue; the turn goes to the first present waiter,
// so one that comes back late does not keep a free lease from the others. It keeps its place
// while it is away and loses it only after the place TTL, for example because its job ended.
const LEASE_RETRY_STEP_MS = 1_000;
const LEASE_RETRY_MAX_MS = 4_000;
const LEASE_RETRY_JITTER_MS = 500;
const LEASE_PRESENCE_GRACE_MS = 2_000;
const LEASE_PLACE_TTL_MS = 5 * 60_000;

// KEYS: the waiters' places and until when each counts as present. ARGV: waiter, head start,
// retry step, retry maximum, jitter, presence grace, place TTL. Registers the waiter, keeping
// the better of its place from an earlier try and the new one, and returns its position among
// the present waiters and when it should retry.
const enterLeaseLineScript = `
  local time = redis.call("TIME")
  local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
  local placeTtl = tonumber(ARGV[7])
  local gone = redis.call("ZRANGEBYSCORE", KEYS[2], "-inf", now - placeTtl)
  for _, waiter in ipairs(gone) do
    redis.call("ZREM", KEYS[1], waiter)
    redis.call("ZREM", KEYS[2], waiter)
  end
  redis.call("ZADD", KEYS[1], "LT", now - tonumber(ARGV[2]), ARGV[1])
  local position = 0
  for _, waiter in ipairs(redis.call("ZRANGE", KEYS[1], 0, -1)) do
    if waiter == ARGV[1] then break end
    local presentUntil = redis.call("ZSCORE", KEYS[2], waiter)
    if presentUntil and tonumber(presentUntil) >= now then position = position + 1 end
  end
  local retryAfter = math.min(tonumber(ARGV[3]) * (position + 1), tonumber(ARGV[4])) + tonumber(ARGV[5])
  redis.call("ZADD", KEYS[2], now + retryAfter + tonumber(ARGV[6]), ARGV[1])
  redis.call("PEXPIRE", KEYS[1], placeTtl)
  redis.call("PEXPIRE", KEYS[2], placeTtl)
  return { position, retryAfter }
`;

const leaseLineKeys = (resource: string): [string, string] => [
  `mail:provider-lease-line:{${resource}}:places`,
  `mail:provider-lease-line:{${resource}}:present`,
];

const leaveLeaseLine = async (resource: string, waiter: string): Promise<void> => {
  const [places, present] = leaseLineKeys(resource);
  await Promise.all([redis.send("ZREM", [places, waiter]), redis.send("ZREM", [present, waiter])]);
};

export type ProviderLeaseTurn = { lock: Lock; retryAfterMs: null } | { lock: null; retryAfterMs: number };

/**
 * Takes the provider lease of a remote mailbox when it is `waiter`'s turn. Waiters line up by
 * priority and by how long they have waited, so a job that releases the lease and asks again
 * lines up anew instead of taking it straight back. A job that does not get the lease keeps its
 * place and retries after `retryAfterMs`; `waiter` must stay the same across those tries. A
 * waiter that comes back late is passed over until it returns, without losing its place. The
 * line is ephemeral Valkey state: losing it only loses the order, never the lease.
 */
export const acquireProviderLease = async (params: {
  resource: string;
  waiter: string;
  priority: ProviderLeasePriority;
  ttlMs: number;
}): Promise<ProviderLeaseTurn> => {
  const reply: unknown = await redis.send("EVAL", [
    enterLeaseLineScript,
    "2",
    ...leaseLineKeys(params.resource),
    params.waiter,
    String(LEASE_HEAD_START_MS[params.priority]),
    String(LEASE_RETRY_STEP_MS),
    String(LEASE_RETRY_MAX_MS),
    String(Math.floor(Math.random() * LEASE_RETRY_JITTER_MS)),
    String(LEASE_PRESENCE_GRACE_MS),
    String(LEASE_PLACE_TTL_MS),
  ]);
  if (!Array.isArray(reply)) throw new Error("The provider lease line returned no position");
  const position = Number(reply[0]);
  const retryAfterMs = Number(reply[1]);
  if (position === 0) {
    const lock = await mailProviderOperationMutex().acquire({ resource: params.resource, ttlMs: params.ttlMs });
    if (lock) {
      try {
        await leaveLeaseLine(params.resource, params.waiter);
      } catch (error) {
        await mailProviderOperationMutex()
          .release(lock)
          .catch(() => false);
        throw error;
      }
      return { lock, retryAfterMs: null };
    }
  }
  return { lock: null, retryAfterMs };
};

/**
 * Delay before a job retries after finding the provider lease busy: the delay its busy error
 * carries from `acquireProviderLease`. Contention is routine, so callers resubmit with this delay
 * instead of consuming a delivery attempt.
 */
export const providerBusyRetryAfterMs = (error: unknown): number => {
  const value = Number((error as { retryAfterMs?: unknown } | null)?.retryAfterMs);
  return Number.isFinite(value) && value > 0 ? value : LEASE_RETRY_MAX_MS;
};

const lifecycleBarrierMutex = lazySync((sync) =>
  sync.mutex({
    id: "mail:remote-resource-sync",
    ttlMs: MAIL_PROVIDER_OPERATION_LEASE_MS,
    retry: { maxAttempts: 41, delayMs: 250 },
  }),
);

const acquireMailboxProviderBarrier = async (remoteResourceIds: readonly string[]): Promise<Lock[] | null> => {
  const locks: Lock[] = [];
  try {
    for (const remoteResourceId of [...new Set(remoteResourceIds)].sort()) {
      const lock = await lifecycleBarrierMutex().acquire({ resource: remoteResourceId, ttlMs: MAIL_PROVIDER_OPERATION_LEASE_MS });
      if (!lock) {
        await Promise.all(
          locks.map((held) =>
            lifecycleBarrierMutex()
              .release(held)
              .catch(() => undefined),
          ),
        );
        return null;
      }
      locks.push(lock);
    }
    return locks;
  } catch (error) {
    await Promise.all(
      locks.map((held) =>
        lifecycleBarrierMutex()
          .release(held)
          .catch(() => undefined),
      ),
    );
    throw error;
  }
};

const releaseMailboxProviderBarrier = async (locks: readonly Lock[]): Promise<void> => {
  await Promise.all(
    locks.map((lock) =>
      lifecycleBarrierMutex()
        .release(lock)
        .catch(() => undefined),
    ),
  );
};

/**
 * Returned when a provider operation cannot take the barrier because synchronization or another
 * provider operation still holds the mailbox. The stable code lets clients offer a plain retry.
 */
export const providerBusy = (message: string): ServiceError<"PROVIDER_BUSY"> => ({ code: "PROVIDER_BUSY", message, status: 409 });

type ProviderOperationBarrierResult<T> = { acquired: false } | { acquired: true; value: T };

const mailboxProviderOperationKey = (mailboxId: string): string => `mailbox:${mailboxId}`;

export const withProviderOperationBarrier = async <T>(
  remoteResourceIds: readonly string[],
  work: (assertLeaseActive: () => Promise<void>) => Promise<T>,
): Promise<ProviderOperationBarrierResult<T>> => {
  const locks = await acquireMailboxProviderBarrier(remoteResourceIds);
  if (!locks) return { acquired: false };
  try {
    const value = await withLeaseHeartbeat({
      intervalMs: Math.floor(MAIL_PROVIDER_OPERATION_LEASE_MS / 3),
      heartbeat: async () => {
        const extended = await Promise.all(
          locks.map((lock) =>
            lifecycleBarrierMutex()
              .extend(lock, { ttlMs: MAIL_PROVIDER_OPERATION_LEASE_MS })
              .catch(() => false),
          ),
        );
        if (extended.some((active) => !active)) {
          throw Object.assign(new Error("Mailbox provider operation barrier was lost"), {
            code: "MAIL_PROVIDER_OPERATION_LEASE_LOST",
          });
        }
      },
      work,
    });
    return { acquired: true, value };
  } finally {
    await releaseMailboxProviderBarrier(locks);
  }
};

export const withMailboxProviderOperationBarrier = async <T>(
  mailboxId: string,
  remoteResourceIds: readonly string[],
  work: (assertLeaseActive: () => Promise<void>) => Promise<T>,
): Promise<ProviderOperationBarrierResult<T>> =>
  withProviderOperationBarrier([mailboxProviderOperationKey(mailboxId), ...remoteResourceIds], work);
