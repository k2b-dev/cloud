import { lazySync, redis } from "@k2b/cloud";
import { logger } from "@k2b/cloud/services";
import type { ServiceError } from "@k2b/stdlib";
import type { Lock } from "@k2b/sync";
import { withLeaseHeartbeat } from "./lease-heartbeat";
import { isProviderTimeout } from "./provider-errors";

const log = logger("mail:provider-lease");

export const MAIL_PROVIDER_OPERATION_LEASE_MS = 5 * 60_000;

/**
 * Jobs of one kind, such as folder syncs or sends, that one Mail process runs at once. Only the
 * job holding a remote mailbox's provider lease works on it; the others resubmit or, for folder
 * syncs, park until a release wakes them, so each place serves another mailbox: an unreachable mailbox holds one place while it waits for its
 * provider, not the queue. The provider breaker below keeps mailboxes whose provider timed out
 * from taking more than one place per process while they try it again.
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
 * User commands such as moves and sends take turns with other provider work. Within that other
 * work, folder syncs and first-attempt body hydration get a head start over background retries.
 */
export type ProviderLeasePriority = "sync" | "command" | "background";

// A waiter counts as having waited this much longer than it has. A lower priority therefore lets
// a higher one that starts waiting after it keep an earlier natural place for at most the
// difference, 30 seconds per step. Commands and other work alternate over this natural order.
const LEASE_HEAD_START_MS: Record<ProviderLeasePriority, number> = { sync: 60_000, command: 30_000, background: 0 };

// A waiter that asks to age ranks as a command once it has waited this long: by then it has let
// every folder sync that started waiting after it go first for the whole head start that syncs
// have over background work. Longer waits come only from the length of the line, which grows with
// the account's folders, so from then on it alternates with the other work like a command.
const LEASE_AGING_MS = LEASE_HEAD_START_MS.sync - LEASE_HEAD_START_MS.background;

// Waiters retry while they wait, the next in line most often; folder syncs park instead (see
// `acquireProviderLease` and `LEASE_WOKEN_PRESENCE_MS`). A waiter counts as present until
// its retry is due plus a grace for a busy job queue; the turn goes to the first present waiter,
// so one that comes back late does not keep a free lease from the others; a woken folder sync
// keeps it for its job's start, at most `LEASE_WOKEN_PRESENCE_MS`. A waiter keeps its place
// while it is away and loses it only after the place TTL, for example because its job ended.
const LEASE_RETRY_STEP_MS = 250;
const LEASE_RETRY_MAX_MS = 4_000;
const LEASE_RETRY_JITTER_MS = 500;
const LEASE_PRESENCE_GRACE_MS = 2_000;
const LEASE_PLACE_TTL_MS = 5 * 60_000;
// A woken waiter keeps the lease for its job this long: two runs of the minute scheduler, whose
// wake renews it, so a job that is slow to start is not passed over, and one that never starts
// keeps a free lease from the others for at most this long.
const LEASE_WOKEN_PRESENCE_MS = 2 * 60_000;

// Work under the lease that failed because the provider did not answer before a timeout, such as
// a host that lets each connection attempt wait for it, opens the remote mailbox's breaker. While
// it is open, nobody gets the lease and nobody connects; the turn says how long the breaker stays
// open (`unreachableForMs`). Folder syncs and rediscoveries end without using an attempt and do not
// count as done: they record the mailbox as unreachable, and the scheduler queues them again once
// the window ends or a person asks for a sync; a folder sync the provider's push asked for comes
// back once, when the window ends, to keep its rank. Other jobs, such as commands and body downloads,
// wait as for a busy lease: they keep their place and ask again within the line's longest retry,
// so when the breaker closes early, for example after a person's manual sync reached the provider,
// the job next in line takes the lease within seconds.
//
// After the window, the breaker remembers it until provider work of the mailbox succeeds, and the
// job next in line probes the provider. Each Mail process probes one such mailbox at a time, so
// once each has timed out, mailboxes whose providers do not answer, however many and on however
// many hosts, take at most one of a process's places with connection attempts that wait for
// their timeout; their other jobs wait without a place. Another timeout reopens the breaker for
// twice as long. Completed folder syncs, body downloads, and rediscovery close it, and so do IMAP
// push when it connects and a replaced connection whose verification the provider answered. A
// refused or dropped connection fails fast and opens nothing, so it does not hold back the
// mailbox's next sync. Commands and draft work record a timeout too, so a probe of theirs does
// not leave the breaker closed for the next job, but they do not close it: they settle provider
// failures in their own records and can finish without reaching the provider. Sends record
// nothing, because an SMTP timeout says nothing about the mailbox's IMAP server.
//
// The first window is one connection timeout (15 seconds in the IMAP and SMTP connectors). The
// longest window is the 15-minute cadence at which the scheduler verifies each binding again
// (submitDueWork in sync-runtime): a provider that keeps dropping connection attempts, such as a
// host that blocks this installation's address, is asked no more often than that, instead of every
// minute by each folder check, rediscovery, and IMAP push reconnect. The scheduler queues no
// folder check and IMAP push does not connect while the window is open. A person's manual sync
// ends the window at once; a provider that answers again is found at the next probe after the
// window, by a scheduled check or IMAP push, at most one longest window later. Up to a quarter of
// the window is added at random, so mailboxes of one host that failed together do not all ask to
// probe at the same moment. A breaker that no job asks about for one longest window after its
// window ended forgets it.
const BREAKER_FIRST_WINDOW_MS = 15_000;
const BREAKER_MAX_WINDOW_MS = 15 * 60_000;
const BREAKER_JITTER_FRACTION = 0.25;

// What `enterLeaseLineScript` reports about the mailbox's breaker.
const BREAKER_OPEN = 1;
const BREAKER_PROBE = 2;

// The order of a mailbox's line, shared by the scripts below. KEYS: places, presence,
// priorities, last turn. Returns the present waiters, each with its effective score and natural
// rank: effective score, then rank, gives every present waiter the same total order. `asking`
// counts as present.
const lineOrderLua = `
  local function lineOrder(placesKey, presentKey, prioritiesKey, turnKey, now, asking)
    local function class(priority)
      if priority == "command" then return "command" end
      if priority == "sync" or priority == "background" then return "other" end
    end
    local lastWaiter = redis.call("HGET", turnKey, "waiter")
    local demoted = class(redis.call("HGET", turnKey, "priority"))
    local present = {}
    local demotedMin
    local places = redis.call("ZRANGE", placesKey, 0, -1, "WITHSCORES")
    for rank = 1, #places, 2 do
      local waiter = places[rank]
      local presentUntil = redis.call("ZSCORE", presentKey, waiter)
      if waiter == asking or (presentUntil and tonumber(presentUntil) >= now) then
        local entry = { waiter = waiter, score = tonumber(places[rank + 1]), rank = rank, class = class(redis.call("HGET", prioritiesKey, waiter)) }
        table.insert(present, entry)
        -- The last holder's continuation keeps its natural place between batches.
        if demoted and entry.class == demoted and waiter ~= lastWaiter then
          demotedMin = math.min(demotedMin or entry.score, entry.score)
        end
      end
    end
    for _, entry in ipairs(present) do
      entry.effective = entry.score
      if demotedMin and entry.class and entry.class ~= demoted then entry.effective = math.min(entry.score, demotedMin - 1) end
    end
    return present
  end
  local function before(a, b)
    return a.effective < b.effective or (a.effective == b.effective and a.rank < b.rank)
  end
  local function now()
    local time = redis.call("TIME")
    return (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
  end
`;

// KEYS: places, presence, breaker, priorities, last turn, entry times, parked, and woken, all for
// one mailbox. ARGV: waiter, head start, retry step, retry maximum, jitter, presence grace, place
// TTL, breaker memory, priority, aging (milliseconds, or 0 for none). Registers the waiter,
// keeping the better of its earlier place and the new one, and returns its position among
// present waiters, when it should retry, whether the breaker is open, remembers a window that
// ended, or neither, its place, the priority it ranks with, how long the breaker stays open, and
// what it left when it parked. A
// waiter that parked asks again with the better of its parked priority and the new one, and an
// aging waiter ranks as `command` once it has waited long enough. Its wait counts from its first
// ask, not from its place, which also moves with the priority it asks with.
const enterLeaseLineScript = `
  ${lineOrderLua}
  local now = now()
  local placeTtl = tonumber(ARGV[7])
  local gone = redis.call("ZRANGEBYSCORE", KEYS[2], "-inf", now - placeTtl)
  for _, waiter in ipairs(gone) do
    redis.call("ZREM", KEYS[1], waiter)
    redis.call("ZREM", KEYS[2], waiter)
    redis.call("HDEL", KEYS[4], waiter)
    redis.call("HDEL", KEYS[6], waiter)
    redis.call("HDEL", KEYS[7], waiter)
    redis.call("HDEL", KEYS[8], waiter)
  end
  redis.call("ZADD", KEYS[1], "LT", now - tonumber(ARGV[2]), ARGV[1])
  local priority = ARGV[9]
  local parked = redis.call("HGET", KEYS[7], ARGV[1])
  if parked then
    redis.call("HDEL", KEYS[7], ARGV[1])
    redis.call("HDEL", KEYS[8], ARGV[1])
    local strength = { background = 1, sync = 2, command = 3 }
    local held = redis.call("HGET", KEYS[4], ARGV[1])
    if held and (strength[held] or 0) > (strength[priority] or 0) then priority = held end
  end
  local aging = tonumber(ARGV[10])
  if aging > 0 then
    redis.call("HSETNX", KEYS[6], ARGV[1], now)
    if now - tonumber(redis.call("HGET", KEYS[6], ARGV[1])) >= aging then priority = "command" end
    redis.call("PEXPIRE", KEYS[6], placeTtl)
  end
  redis.call("HSET", KEYS[4], ARGV[1], priority)
  local present = lineOrder(KEYS[1], KEYS[2], KEYS[4], KEYS[5], now, ARGV[1])
  local asking
  for _, entry in ipairs(present) do
    if entry.waiter == ARGV[1] then asking = entry end
  end
  local position = 0
  for _, entry in ipairs(present) do
    if before(entry, asking) then position = position + 1 end
  end
  local retryAfter = math.min(tonumber(ARGV[3]) * (position + 1), tonumber(ARGV[4])) + math.floor(tonumber(ARGV[5]) / 5)
  local breaker = 0
  local openFor = 0
  local openUntil = redis.call("HGET", KEYS[3], "until")
  if openUntil and tonumber(openUntil) > now then
    breaker = ${BREAKER_OPEN}
    openFor = tonumber(openUntil) - now
    retryAfter = math.min(tonumber(openUntil) - now, tonumber(ARGV[4])) + tonumber(ARGV[5])
  elseif openUntil then
    breaker = ${BREAKER_PROBE}
    redis.call("PEXPIRE", KEYS[3], ARGV[8])
  end
  redis.call("ZADD", KEYS[2], now + retryAfter + tonumber(ARGV[6]), ARGV[1])
  redis.call("PEXPIRE", KEYS[1], placeTtl)
  redis.call("PEXPIRE", KEYS[2], placeTtl)
  redis.call("PEXPIRE", KEYS[4], placeTtl)
  return { position, retryAfter, breaker, redis.call("ZSCORE", KEYS[1], ARGV[1]), priority, openFor, parked or false }
`;

// KEYS: places, presence, priorities, last turn, parked, woken, breaker. ARGV: waiter, what it
// leaves, place TTL. Parks a waiter that is in line: it stays present with its place and priority
// until the place TTL, without asking again, and `wakeLeaseLineScript` wakes it. Returns its
// position among present waiters, or -1 when it does not park: it is no longer in line, or the
// mailbox's breaker is open or remembers a window, because then no release may end its wait.
const parkInLeaseLineScript = `
  ${lineOrderLua}
  local now = now()
  if not redis.call("ZSCORE", KEYS[1], ARGV[1]) then return -1 end
  if redis.call("HEXISTS", KEYS[7], "until") == 1 then return -1 end
  redis.call("HSET", KEYS[5], ARGV[1], ARGV[2])
  redis.call("HDEL", KEYS[6], ARGV[1])
  redis.call("ZADD", KEYS[2], now + tonumber(ARGV[3]), ARGV[1])
  for _, key in ipairs({ KEYS[1], KEYS[2], KEYS[3], KEYS[5], KEYS[6] }) do redis.call("PEXPIRE", key, ARGV[3]) end
  local present = lineOrder(KEYS[1], KEYS[2], KEYS[3], KEYS[4], now, ARGV[1])
  local parked
  for _, entry in ipairs(present) do
    if entry.waiter == ARGV[1] then parked = entry end
  end
  local position = 0
  for _, entry in ipairs(present) do
    if before(entry, parked) then position = position + 1 end
  end
  return position
`;

// KEYS: places, presence, priorities, last turn, parked, woken. ARGV: presence of a woken waiter,
// place TTL. When the first present waiter is parked, marks it woken, gives it that presence, and
// returns its name and what it left; otherwise returns nothing. A woken waiter keeps what it left
// until it asks again, so its rank and input survive the wake, and a wake whose job never ran is
// repeated by the next release or scheduler run while the waiter is still present.
const wakeLeaseLineScript = `
  ${lineOrderLua}
  local now = now()
  local first
  for _, entry in ipairs(lineOrder(KEYS[1], KEYS[2], KEYS[3], KEYS[4], now, nil)) do
    if not first or before(entry, first) then first = entry end
  end
  if not first then return false end
  local parked = redis.call("HGET", KEYS[5], first.waiter)
  if not parked then return false end
  redis.call("HSET", KEYS[6], first.waiter, 1)
  redis.call("PEXPIRE", KEYS[6], ARGV[2])
  redis.call("ZADD", KEYS[2], now + tonumber(ARGV[1]), first.waiter)
  return { first.waiter, parked }
`;

// KEYS: the mailbox's breaker. ARGV: first window, longest window, jitter fraction. Doubles the
// window the breaker remembers, up to the longest, and returns how long it is open.
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

// One hash tag, so the line, its last turn, and the breaker of a mailbox live together.
const leaseLineKeys = (resource: string) =>
  [
    `mail:provider-lease-line:{${resource}}:places`,
    `mail:provider-lease-line:{${resource}}:present`,
    `mail:provider-lease-line:{${resource}}:breaker`,
    `mail:provider-lease-line:{${resource}}:priorities`,
    `mail:provider-lease-line:{${resource}}:turn`,
    `mail:provider-lease-line:{${resource}}:entered`,
    `mail:provider-lease-line:{${resource}}:parked`,
    `mail:provider-lease-line:{${resource}}:woken`,
  ] as const;

/** Lines `waiter` up for the provider lease of `resource` with the script above and returns its reply. */
const enterLeaseLine = (resource: string, waiter: string, priority: ProviderLeasePriority, ages: boolean): Promise<unknown> =>
  redis.send("EVAL", [
    enterLeaseLineScript,
    "8",
    ...leaseLineKeys(resource),
    waiter,
    String(LEASE_HEAD_START_MS[priority]),
    String(LEASE_RETRY_STEP_MS),
    String(LEASE_RETRY_MAX_MS),
    String(Math.floor(Math.random() * LEASE_RETRY_JITTER_MS)),
    String(LEASE_PRESENCE_GRACE_MS),
    String(LEASE_PLACE_TTL_MS),
    String(BREAKER_MAX_WINDOW_MS),
    priority,
    String(ages ? LEASE_AGING_MS : 0),
  ]);

/** The keys of the park and wake scripts above. */
const parkingKeys = (resource: string): string[] => {
  const [places, present, , priorities, turn, , parked, woken] = leaseLineKeys(resource);
  return [places, present, priorities, turn, parked, woken];
};

const parkInLeaseLine = async (resource: string, waiter: string, left: string): Promise<number> =>
  Number(
    await redis.send("EVAL", [
      parkInLeaseLineScript,
      "7",
      ...parkingKeys(resource),
      leaseLineKeys(resource)[2],
      waiter,
      left,
      String(LEASE_PLACE_TTL_MS),
    ]),
  );

/**
 * Wakes a parked waiter in the provider lease line of a remote mailbox. It wakes nobody unless the
 * waiter next in line is parked; that one gets the presence of a waiter that just asked, and the
 * function passed to `onParkedProviderWaiterWake` gets what it left. A waker that fails parks it
 * again. Valkey errors are ignored: the scheduler's next run wakes the line again.
 */
export const wakeParkedProviderWaiter = async (resource: string): Promise<void> => {
  if (!waker) return;
  const reply = await redis
    .send("EVAL", [wakeLeaseLineScript, "6", ...parkingKeys(resource), String(LEASE_WOKEN_PRESENCE_MS), String(LEASE_PLACE_TTL_MS)])
    .catch(() => null);
  if (!Array.isArray(reply) || !waker) return;
  const [waiter, left] = [String(reply[0]), String(reply[1])];
  try {
    await waker(waiter, left);
  } catch {
    await parkInLeaseLine(resource, waiter, left).catch(() => undefined);
  }
};

let waker: ((waiter: string, left: string) => Promise<void>) | null = null;

/**
 * Sets what wakes a parked waiter: given its name and what it left when it parked, it starts the
 * waiter's job again. The job that parks waiters sets it once. Returns the one it replaced.
 */
export const onParkedProviderWaiterWake = (
  wake: ((waiter: string, left: string) => Promise<void>) | null,
): ((waiter: string, left: string) => Promise<void>) | null => {
  const replaced = waker;
  waker = wake;
  return replaced;
};

// KEYS: places, presence, priorities, last turn, entry times, parked, woken. ARGV: waiter, acquired
// priority or empty, place TTL, keep place. Record an acquired turn and leave the line together,
// unless the caller needs to keep its place while taking another lock. Leaving later does not
// change the turn. A waiter that leaves is no longer parked.
const leaveLeaseLineScript = `
  if ARGV[2] ~= "" then
    redis.call("HSET", KEYS[4], "waiter", ARGV[1], "priority", ARGV[2])
    redis.call("PEXPIRE", KEYS[4], ARGV[3])
  end
  redis.call("HDEL", KEYS[6], ARGV[1])
  redis.call("HDEL", KEYS[7], ARGV[1])
  if ARGV[4] ~= "1" then
    redis.call("ZREM", KEYS[1], ARGV[1])
    redis.call("ZREM", KEYS[2], ARGV[1])
    redis.call("HDEL", KEYS[3], ARGV[1])
    redis.call("HDEL", KEYS[5], ARGV[1])
  end
`;

const leaveLeaseLine = async (
  resource: string,
  waiter: string,
  acquired?: { priority: ProviderLeasePriority; keepPlace?: boolean },
): Promise<void> => {
  const [places, present, , priorities, turn, entered, parked, woken] = leaseLineKeys(resource);
  await redis.send("EVAL", [
    leaveLeaseLineScript,
    "7",
    places,
    present,
    priorities,
    turn,
    entered,
    parked,
    woken,
    waiter,
    acquired?.priority ?? "",
    String(LEASE_PLACE_TTL_MS),
    acquired?.keepPlace ? "1" : "0",
  ]);
};

/**
 * A turn, or when to ask again. `unreachableForMs` is set while the mailbox's provider breaker is
 * open, that is while its provider did not answer a connection attempt and is not asked again
 * yet. `left` is what the waiter left when it last parked, so a new job of the same waiter can
 * take it over. A parked waiter has `parked` and asks again only when woken.
 */
export type ProviderLeaseTurn =
  | { lock: Lock; place: number; retryAfterMs: null; left: string | null }
  | { lock: null; retryAfterMs: number; unreachableForMs: number | null; left: string | null; parked: boolean };

// The lease with which this process probes a provider that timed out, or "taking" while it asks
// for one, and until when it counts: a holder that never released it does not block probes past
// its lease TTL.
const leasePriority = (value: unknown, fallback: ProviderLeasePriority): ProviderLeasePriority =>
  value === "sync" || value === "command" || value === "background" ? value : fallback;

let probeLease: Lock | "taking" | null = null;
let probeLeaseUntil = 0;

/**
 * Takes the provider lease of a remote mailbox when it is `waiter`'s turn. Waiters line up by
 * priority and by how long they have waited. Each acquired lease records a turn: commands and
 * other provider work alternate while both are present. The last holder keeps its natural place
 * when it asks again, so a folder's next batch, or the mailbox's next command after a command
 * turn, is not moved back; other jobs line up anew after their turn. A waiting
 * command waits for at most the running operation and one further sync or background batch;
 * a waiting folder sync waits for at most one command turn. A job that does not get the lease
 * keeps its place and retries after `retryAfterMs`; `waiter` must stay the same across those tries. A
 * waiter that comes back late is passed over until it returns, without losing its place. While
 * the mailbox's provider breaker is open, nobody takes the lease; after it, the waiter next in
 * line takes it once no other mailbox's probe holds this process's probe. With `park`, a waiter
 * that finds the lease held parks instead of asking again: it keeps its place and priority, and
 * the release that makes it next in line wakes it (`onParkedProviderWaiterWake`). It does not park
 * while the breaker is open or this process's probe is taken, because no release ends those
 * waits. Release the lease with
 * `releaseProviderLease`, passing `next` when the job continues with another turn so it lines up
 * before letting go. The line, its last turn, and the breaker are ephemeral Valkey state: losing
 * them only loses the order and the pause, never the lease. With `keepPlace`, the waiter stays in
 * line with its lease, for a caller in this module that needs another lock before using it and
 * leaves the line once it holds both.
 */
export const acquireProviderLease = async (params: {
  resource: string;
  waiter: string;
  priority: ProviderLeasePriority;
  ttlMs: number;
  keepPlace?: boolean;
  /** Ranks the waiter as a command once it has waited in line for the aging time above. */
  ages?: boolean;
  /** Parks a waiter that finds the lease held; given what it left last time, returns what it leaves now. */
  park?: (left: string | null) => string;
}): Promise<ProviderLeaseTurn> => {
  const reply = await enterLeaseLine(params.resource, params.waiter, params.priority, params.ages === true);
  if (!Array.isArray(reply)) throw new Error("The provider lease line returned no position");
  const breaker = Number(reply[2]);
  const left = typeof reply[6] === "string" ? reply[6] : null;
  const busy = {
    lock: null,
    retryAfterMs: Number(reply[1]),
    unreachableForMs: breaker === BREAKER_OPEN ? Number(reply[5]) : null,
    left,
    parked: false,
  } as const;
  if (breaker === BREAKER_OPEN) return busy;
  const probe = breaker === BREAKER_PROBE;
  if (probe && probeLease !== null && performance.now() < probeLeaseUntil) return busy;
  const take = async (): Promise<Lock | null> => {
    if (probe) {
      probeLease = "taking";
      probeLeaseUntil = performance.now() + params.ttlMs;
    }
    let lock: Lock | null = null;
    try {
      lock = await mailProviderOperationMutex().acquire({ resource: params.resource, ttlMs: params.ttlMs });
      // The turn counts with the priority the waiter ranked with, so an aged waiter's turn is a
      // command turn and the other work goes next.
      if (lock) await leaveLeaseLine(params.resource, params.waiter, { ...params, priority: leasePriority(reply[4], params.priority) });
    } catch (error) {
      if (lock) await releaseProviderLease(lock);
      lock = null;
      throw error;
    } finally {
      if (probe) probeLease = lock;
    }
    return lock;
  };
  let lock = Number(reply[0]) === 0 ? await take() : null;
  if (lock) return { lock, place: Number(reply[3]), retryAfterMs: null, left };
  // A probe ends with the release of whichever mailbox holds this process's probe, which wakes
  // nobody here, so a waiter of a mailbox that may probe asks again instead of parking. Taking
  // the lease after parking would also act on the breaker state the waiter saw before it parked.
  if (!params.park || probe) return busy;
  // A waiter next in line whose lease the holder released while it parked would wait for a wake
  // that already happened, so it asks once more after parking. Every later release wakes it.
  const leaves = params.park(left);
  const position = await parkInLeaseLine(params.resource, params.waiter, leaves);
  if (position < 0) return busy;
  if (position === 0) lock = await take();
  if (lock) return { lock, place: Number(reply[3]), retryAfterMs: null, left: leaves };
  return { ...busy, parked: true };
};

/**
 * Whether a release woke `waiter` since it parked. A job that parked checks this before it ends:
 * a wake that came while it still ran started no new job, so it continues itself instead.
 */
export const providerLeaseWaiterWoken = async (resource: string, waiter: string): Promise<boolean> =>
  Number(await redis.send("HEXISTS", [leaseLineKeys(resource)[7], waiter]).catch(() => 1)) === 1;

// KEYS: places, presence, priorities. ARGV: holder's place, yield to foreground work.
// Reports whether a present waiter should end the body batch, without changing the line.
const providerLeaseWaitedForScript = `
  local time = redis.call("TIME")
  local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
  for _, waiter in ipairs(redis.call("ZRANGE", KEYS[1], 0, -1)) do
    local place = tonumber(redis.call("ZSCORE", KEYS[1], waiter))
    local priority = redis.call("HGET", KEYS[3], waiter)
    local foregroundWaiting = ARGV[2] == "1" and (priority == "sync" or priority == "command")
    local presentUntil = redis.call("ZSCORE", KEYS[2], waiter)
    if (place < tonumber(ARGV[1]) or foregroundWaiting) and presentUntil and tonumber(presentUntil) >= now then return 1 end
  end
  return 0
`;

/**
 * Answers whether a present waiter goes ahead of this lease's place in line. Work that holds
 * the lease in units, such as body downloads, ends its turn after the current unit. With
 * `yieldToForeground`, a first-attempt body also yields to a later sync or command, so the
 * waiter waits for one unit instead of a whole batch. Valkey errors let the turn run on:
 * losing the line only loses the order.
 */
export const providerLeaseWaitedFor = async (
  turn: { lock: Lock; place: number },
  options: { yieldToForeground?: boolean } = {},
): Promise<boolean> => {
  const [places, present, , priorities] = leaseLineKeys(turn.lock.resource);
  return redis
    .send("EVAL", [
      providerLeaseWaitedForScript,
      "3",
      places,
      present,
      priorities,
      String(turn.place),
      options.yieldToForeground ? "1" : "0",
    ])
    .then((reply) => Number(reply) === 1)
    .catch(() => false);
};

// KEYS: places, presence. Reports whether present work other than a folder sync is in line.
const otherWorkWaitsScript = `
  local time = redis.call("TIME")
  local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
  for _, waiter in ipairs(redis.call("ZRANGE", KEYS[1], 0, -1)) do
    if string.sub(waiter, 1, 12) ~= "sync-folder:" then
      local presentUntil = redis.call("ZSCORE", KEYS[2], waiter)
      if presentUntil and tonumber(presentUntil) >= now then return 1 end
    end
  end
  return 0
`;

/**
 * Whether work other than a folder sync, such as a send, a command or a body download, waits for
 * the resource's lease. A Valkey error answers yes, so a caller only skips what is optional.
 */
export const providerLeaseWaitedForByOtherWork = async (resource: string): Promise<boolean> => {
  const [places, present] = leaseLineKeys(resource);
  return redis
    .send("EVAL", [otherWorkWaitsScript, "2", places, present])
    .then((reply) => Number(reply) === 1)
    .catch(() => true);
};

// KEYS: places, presence. ARGV: name prefix. Counts the present waiters whose name has the prefix.
const presentWaitersScript = `
  local time = redis.call("TIME")
  local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
  local count = 0
  for _, waiter in ipairs(redis.call("ZRANGE", KEYS[1], 0, -1)) do
    if string.sub(waiter, 1, string.len(ARGV[1])) == ARGV[1] then
      local presentUntil = redis.call("ZSCORE", KEYS[2], waiter)
      if presentUntil and tonumber(presentUntil) >= now then count = count + 1 end
    end
  end
  return count
`;

/** How many present waiters for the resource's lease have names starting with `prefix`; Valkey errors answer 0. */
export const providerLeaseWaiterCount = async (resource: string, prefix: string): Promise<number> => {
  const [places, present] = leaseLineKeys(resource);
  return redis
    .send("EVAL", [presentWaitersScript, "2", places, present, prefix])
    .then((reply) => Number(reply) || 0)
    .catch(() => 0);
};

/**
 * Releases a lease from `acquireProviderLease`. A job that continues passes `next` to line up
 * before letting go, so a job that asks between its turns does not take the lease just because
 * the holder was briefly out of line. It lines up anew: a command that waited longer than the
 * head-start difference still goes first. Then it wakes the waiter next in line if that one
 * parked. Valkey errors lose only the order, never the release; a release that fails leaves the
 * lease to expire, and the scheduler wakes the line.
 */
export const releaseProviderLease = async (lock: Lock, next?: { waiter: string; priority: ProviderLeasePriority }): Promise<void> => {
  if (next) await enterLeaseLine(lock.resource, next.waiter, next.priority, false).catch(() => undefined);
  if (probeLease === lock) probeLease = null;
  await mailProviderOperationMutex()
    .release(lock)
    .catch(() => false);
  await wakeParkedProviderWaiter(lock.resource);
};

/**
 * Records a failure of work that held the provider lease of `resource`. A provider that did not
 * answer before a timeout opens the breaker described above, or reopens it for longer; other
 * failures leave it as it is. Returns how long the breaker is open, or `null` when it opened
 * nothing. Valkey errors are ignored: a breaker that does not open only costs the connection
 * attempts it would have saved, and the job keeps its own error.
 */
export const recordProviderFailure = async (resource: string, error: unknown): Promise<number | null> => {
  if (!isProviderTimeout(error)) return null;
  const openForMs: unknown = await redis
    .send("EVAL", [
      openBreakerScript,
      "1",
      leaseLineKeys(resource)[2],
      String(BREAKER_FIRST_WINDOW_MS),
      String(BREAKER_MAX_WINDOW_MS),
      String(Math.random() * BREAKER_JITTER_FRACTION),
    ])
    .catch(() => null);
  if (openForMs === null) return null;
  // Once per window: work on the mailbox stops trying its mail server until the window ends.
  log.warn("Mail server did not answer in time; pausing attempts for the mailbox", {
    remoteResourceId: resource,
    pauseMs: Number(openForMs),
    code: (error as { code?: unknown } | null)?.code,
  });
  return Number(openForMs);
};

/**
 * Records that the provider of `resource` answered: a sync, body download, or rediscovery under
 * its lease completed, IMAP push connected, or the verification of a replaced connection
 * succeeded. Closes the breaker and forgets its window, so waiting jobs run at their next try
 * and the parked waiter next in line is woken.
 * Valkey errors are ignored: a breaker that stays open closes at the end of its window.
 */
export const recordProviderReachable = async (resource: string): Promise<void> => {
  const closed = Number(await redis.send("DEL", [leaseLineKeys(resource)[2]]).catch(() => 0));
  // Waiters that parked before the breaker opened wait for a release that a closed breaker does
  // not bring; the waiter next in line goes on now.
  if (closed > 0) await wakeParkedProviderWaiter(resource);
};

// KEYS: the mailbox's breaker. Ends an open window and keeps its length, so the next job probes.
const endBreakerWindowScript = `
  if redis.call("EXISTS", KEYS[1]) == 1 then redis.call("HSET", KEYS[1], "until", 0) end
`;

/**
 * A person asked to sync or check the mailbox now: the next job tries the provider at once
 * instead of waiting for the breaker's window. The breaker keeps the window's length, so a provider
 * that still does not answer waits the doubled window again, not the first one; a probe that
 * reaches it closes the breaker. Valkey errors are ignored, as for `recordProviderReachable`.
 */
export const resetProviderBreaker = async (resource: string): Promise<void> => {
  await redis.send("EVAL", [endBreakerWindowScript, "1", leaseLineKeys(resource)[2]]).catch(() => undefined);
};

// KEYS: the mailbox's breaker. Returns how long it stays open, or 0.
const breakerOpenForScript = `
  local openUntil = redis.call("HGET", KEYS[1], "until")
  if not openUntil then return 0 end
  local time = redis.call("TIME")
  local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
  return math.max(0, tonumber(openUntil) - now)
`;

/**
 * How long the provider breaker of `resource` stays open, or 0 when work may try the provider.
 * Valkey errors answer 0: the caller then tries the provider as without a breaker.
 */
export const providerBreakerOpenForMs = async (resource: string): Promise<number> =>
  redis
    .send("EVAL", [breakerOpenForScript, "1", leaseLineKeys(resource)[2]])
    .then((reply) => Number(reply) || 0)
    .catch(() => 0);

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

// The barrier holds the same lease as provider work, so its release wakes a parked waiter too.
const releaseMailboxProviderBarrier = async (locks: readonly Lock[]): Promise<void> => {
  await Promise.all(
    locks.map((lock) =>
      lifecycleBarrierMutex()
        .release(lock)
        .catch(() => undefined),
    ),
  );
  for (const lock of locks) await wakeParkedProviderWaiter(lock.resource);
};

/**
 * Returned when a provider operation cannot take the barrier because synchronization or another
 * provider operation still holds the mailbox. The stable code lets clients offer a plain retry.
 */
export const providerBusy = (message: string): ServiceError<"PROVIDER_BUSY"> => ({ code: "PROVIDER_BUSY", message, status: 409 });

type ProviderOperationBarrierResult<T> = { acquired: false } | { acquired: true; value: T };

const mailboxProviderOperationKey = (mailboxId: string): string => `mailbox:${mailboxId}`;

/** Runs `work` while it renews `locks`; a lock it cannot renew fails the work as a lost lease. */
const withHeldProviderLocks = <T>(locks: readonly Lock[], work: (assertLeaseActive: () => Promise<void>) => Promise<T>): Promise<T> =>
  withLeaseHeartbeat({
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

export const withProviderOperationBarrier = async <T>(
  remoteResourceIds: readonly string[],
  work: (assertLeaseActive: () => Promise<void>) => Promise<T>,
): Promise<ProviderOperationBarrierResult<T>> => {
  const locks = await acquireMailboxProviderBarrier(remoteResourceIds);
  if (!locks) return { acquired: false };
  try {
    return { acquired: true, value: await withHeldProviderLocks(locks, work) };
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

export type ProviderOperationTurn<T> = { acquired: false; retryAfterMs: number } | { acquired: true; value: T };

/**
 * Runs `work` with the same exclusivity as `withMailboxProviderOperationBarrier` on one remote
 * mailbox, but takes its turn in the mailbox's provider lease line as a user command instead of
 * polling past it: folder syncs that keep a large mailbox busy cannot pass it forever. Returns
 * when to try again while it is not `waiter`'s turn; `waiter` must stay the same across tries to
 * keep its place. The mailbox-wide key, held only by short lifecycle changes, is taken without
 * waiting once the lease is held; `waiter` leaves the line only once it holds both, so a short
 * lifecycle change does not cost it its place.
 */
export const withMailboxProviderOperationTurn = async <T>(
  params: { mailboxId: string; remoteResourceId: string; waiter: string },
  work: (assertLeaseActive: () => Promise<void>) => Promise<T>,
): Promise<ProviderOperationTurn<T>> => {
  const turn = await acquireProviderLease({
    resource: params.remoteResourceId,
    waiter: params.waiter,
    priority: "command",
    ttlMs: MAIL_PROVIDER_OPERATION_LEASE_MS,
    keepPlace: true,
  });
  if (!turn.lock) return { acquired: false, retryAfterMs: turn.retryAfterMs };
  const lease = turn.lock;
  try {
    const mailboxLock = await mailProviderOperationMutex().acquire({
      resource: mailboxProviderOperationKey(params.mailboxId),
      ttlMs: MAIL_PROVIDER_OPERATION_LEASE_MS,
    });
    if (!mailboxLock) return { acquired: false, retryAfterMs: LEASE_RETRY_STEP_MS };
    try {
      await leaveLeaseLine(params.remoteResourceId, params.waiter);
      return { acquired: true, value: await withHeldProviderLocks([lease, mailboxLock], work) };
    } finally {
      await mailProviderOperationMutex()
        .release(mailboxLock)
        .catch(() => false);
    }
  } finally {
    await releaseProviderLease(lease);
  }
};
