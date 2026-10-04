import { lazySync } from "@k2b/cloud";
import type { ServiceError } from "@k2b/stdlib";
import type { Lock } from "@k2b/sync";
import { redis } from "bun";
import { withLeaseHeartbeat } from "./lease-heartbeat";
import { isProviderTimeout } from "./provider-errors";

export const MAIL_PROVIDER_OPERATION_LEASE_MS = 5 * 60_000;

/**
 * Jobs of one kind, such as folder syncs or sends, that one Mail process runs at once. Only the
 * job holding a remote mailbox's provider lease works on it, and the others resubmit, so each
 * place serves another mailbox: an unreachable mailbox holds one place while it waits for its
 * provider, not the queue. The provider breaker below keeps a mailbox whose provider does not
 * answer from taking a place again for every job it has queued.
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

// Work under the lease that failed because the provider did not answer before a timeout, such as
// a host that lets each connection attempt wait for it, opens the remote mailbox's breaker. While
// it is open, every job that asks for the lease waits as for a busy lease: it does not connect
// and does not use an attempt. It keeps its place but does not count as present, because it comes
// back only when the window ends; so once the breaker closes, at the end of its window or early,
// for example when IMAP push reaches the provider again, the first job that asks takes the lease
// and probes the provider. One job per mailbox connects; another timeout opens the breaker for
// twice as long, and any success closes it. A refused or dropped connection fails fast and opens
// nothing, so it does not hold back the mailbox's next sync. Folder syncs, body downloads, and
// rediscovery record what they found, as they run for every mailbox; commands, sends, and draft
// work only wait for the breaker, because they settle provider failures in their own records.
//
// The first window is one connection timeout (15 seconds in the IMAP and SMTP connectors), so a
// provider that does not answer keeps at most about half a worker place busy with probes, and
// less as it backs off. The longest window is the one-minute cadence of scheduled folder syncs
// and the longest IMAP push reconnect delay, so a provider that answers again syncs within about
// a minute even without push. Up to a quarter of the window is added at random, so mailboxes of
// one host that failed together do not all probe at the same moment.
const BREAKER_FIRST_WINDOW_MS = 15_000;
const BREAKER_MAX_WINDOW_MS = 60_000;
const BREAKER_JITTER_FRACTION = 0.25;

// KEYS: the waiters' places, until when each counts as present, and the mailbox's breaker. ARGV:
// waiter, head start, retry step, retry maximum, jitter, presence grace, place TTL. Registers the
// waiter, keeping the better of its place from an earlier try and the new one, and returns its
// position among the present waiters, when it should retry, and whether the breaker is open.
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
  local presentUntil = now + retryAfter + tonumber(ARGV[6])
  local breakerOpen = 0
  local openUntil = tonumber(redis.call("HGET", KEYS[3], "until") or "0")
  if openUntil > now then
    breakerOpen = 1
    retryAfter = openUntil - now + tonumber(ARGV[5])
    presentUntil = now - 1
  end
  redis.call("ZADD", KEYS[2], presentUntil, ARGV[1])
  redis.call("PEXPIRE", KEYS[1], placeTtl)
  redis.call("PEXPIRE", KEYS[2], placeTtl)
  return { position, retryAfter, breakerOpen }
`;

// KEYS: the mailbox's breaker. ARGV: first window, longest window, jitter fraction. The breaker
// remembers its last window for one longest window after it closes, so the failure of the probe
// that follows doubles it.
const openBreakerScript = `
  local time = redis.call("TIME")
  local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
  local previous = tonumber(redis.call("HGET", KEYS[1], "window") or "0")
  local window = tonumber(ARGV[1])
  if previous > 0 then window = math.min(previous * 2, tonumber(ARGV[2])) end
  local openFor = window + math.floor(window * tonumber(ARGV[3]))
  redis.call("HSET", KEYS[1], "window", window, "until", now + openFor)
  redis.call("PEXPIRE", KEYS[1], openFor + tonumber(ARGV[2]))
  return openFor
`;

// One hash tag, so the line and the breaker of a mailbox live together.
const leaseLineKeys = (resource: string): [string, string, string] => [
  `mail:provider-lease-line:{${resource}}:places`,
  `mail:provider-lease-line:{${resource}}:present`,
  `mail:provider-lease-line:{${resource}}:breaker`,
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
 * waiter that comes back late is passed over until it returns, without losing its place. While
 * the mailbox's provider breaker is open, nobody takes the lease and `retryAfterMs` is when it
 * closes. The line and the breaker are ephemeral Valkey state: losing them only loses the order
 * and the pause, never the lease.
 */
export const acquireProviderLease = async (params: {
  resource: string;
  waiter: string;
  priority: ProviderLeasePriority;
  ttlMs: number;
}): Promise<ProviderLeaseTurn> => {
  const reply: unknown = await redis.send("EVAL", [
    enterLeaseLineScript,
    "3",
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
  const breakerOpen = Number(reply[2]) === 1;
  if (position === 0 && !breakerOpen) {
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
 * Records a failure of work that held the provider lease of `resource`. A provider that did not
 * answer before a timeout opens the breaker described above, or reopens it for longer; other
 * failures leave it as it is. Valkey errors are ignored: a breaker that does not open only costs
 * the connection attempts it would have saved, and the job keeps its own error.
 */
export const recordProviderFailure = async (resource: string, error: unknown): Promise<void> => {
  if (!isProviderTimeout(error)) return;
  await redis
    .send("EVAL", [
      openBreakerScript,
      "1",
      leaseLineKeys(resource)[2],
      String(BREAKER_FIRST_WINDOW_MS),
      String(BREAKER_MAX_WINDOW_MS),
      String(Math.random() * BREAKER_JITTER_FRACTION),
    ])
    .catch(() => undefined);
};

/**
 * Records that the provider of `resource` answered: work under its lease finished, or IMAP push
 * connected. Closes the breaker, so waiting jobs run at their next try instead of after the
 * window. Valkey errors are ignored: a breaker that stays open closes at the end of its window.
 */
export const recordProviderReachable = async (resource: string): Promise<void> => {
  await redis.send("DEL", [leaseLineKeys(resource)[2]]).catch(() => undefined);
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
