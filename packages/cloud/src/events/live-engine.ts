import { RetentionGapError, SyncLifecycleError, type Topic, type TopicEvent } from "@k2b/sync";
import { z } from "zod";
import type { RequestActor } from "../server/middleware/auth";
import type { AccessSubject } from "../server/services/access";
import { logger } from "../services/logging";
import { type LiveClientMessage, LiveClientMessageSchema } from "./live-protocol";

/** Bounds of every live socket. Code constants; tests only shorten the intervals. */
export const LIVE_LIMITS = {
  ringEvents: 5_000,
  ringBytes: 32 * 1024 ** 2,
  fillWaitMs: 5_000,
  frameBytes: 16 * 1024,
  pendingMessages: 8,
  subscriptions: 16,
  keys: 1_000,
  socketsPerViewer: 16,
  sendBufferBytes: 256 * 1024,
  replayWaitMs: 10_000,
  cacheMs: 2_000,
  cacheEntries: 50_000,
  viewersPerCall: 500,
  callsInFlight: 8,
  sweepInFlight: 4,
  batchEvents: 256,
  sweepMs: 10_000,
  keysEveryRounds: 6,
  progressMs: 30_000,
};

/** The principal a delivery is for. Authorization is per principal, not per credential. */
export type LiveViewer = {
  /** `user:<id>` or `service_account:<id>`. */
  id: string;
  actor: RequestActor;
  accessSubject: AccessSubject;
  /** Credential scopes; empty for sessions. */
  scopes: readonly string[];
};

export type LiveChannel<Scope extends z.ZodType = z.ZodType> = {
  /** The subscribe payload, validated on every `sub`. */
  scope: Scope;
  /** Routing keys of the scope, at most 1,000; `null` when it does not exist or is not readable. */
  keys(scope: z.output<Scope>, viewer: LiveViewer): Promise<readonly string[] | null>;
  /** IDs of the viewers allowed to read `key`. Called with at most 500 viewers. */
  authorize(key: string, viewers: readonly LiveViewer[]): Promise<ReadonlySet<string>>;
  /** The key set can change without an event; it is refreshed every minute and on access changes. */
  collection?: true;
};

/** One outbox row on the topic: `r` asks subscribers of `k` to reload, `a` announces an access change of `k`. */
export const LiveEnvelopeSchema = z.object({
  v: z.literal(1),
  k: z.string().min(1),
  d: z.unknown().optional(),
  r: z.literal(true).optional(),
  a: z.literal(true).optional(),
});
export type LiveEnvelope = z.infer<typeof LiveEnvelopeSchema>;

/** The transport of one socket; Bun's `ServerWebSocket` satisfies it. */
export type LiveSocket = {
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
  getBufferedAmount(): number;
};

export type LiveConnectionHandle = { message(raw: unknown): void; closed(): void };

/** The parts of the application's topic the engine reads. */
export type LiveTopic = Pick<Topic<LiveEnvelope>, "head" | "replay" | "follow" | "cursorAt" | "cursorSequence">;

type Entry = {
  seq: number;
  cursor: string;
  /** null: malformed row, or a gap in the topic's history. */
  key: string | null;
  data: string | undefined;
  resync: boolean;
  access: boolean;
  gap: boolean;
  bytes: number;
};

type Connection = {
  socket: LiveSocket;
  viewer: LiveViewer;
  revalidate: () => Promise<LiveViewer | null>;
  subs: Map<string, Subscription>;
  pending: number;
  work: Promise<void>;
  closed: boolean;
};

type Subscription = {
  id: string;
  conn: Connection;
  channel: string;
  collection: boolean;
  scope: unknown;
  keys: Set<string>;
  /** Events at or below this sequence are not delivered. */
  from: number;
  /** Live frames held back while the replay is written. */
  backlog: string[] | null;
};

const log = logger("events:live");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Runs `run` for every item with at most `limit` in flight. */
const eachLimited = async <T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> => {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await run(items[next++] as T);
    }),
  );
};

/**
 * Delivery of one application's live topic in this process: one follower with a
 * ring of recent events, an index from key to subscriptions, delivery-time
 * authorization with a short cache, and a periodic sweep of sessions and access.
 */
export const createLiveEngine = (input: { appId: string; topic: () => LiveTopic; channels: Readonly<Record<string, LiveChannel>> }) => {
  const { appId, channels } = input;
  const stopping = new AbortController();
  const connections = new Set<Connection>();
  const index = new Map<string, Set<Subscription>>();
  const cache = new Map<string, { at: number; ok: boolean }>();
  let ring: Entry[] = [];
  let ringBytes = 0;
  /** Every event up to `head` was delivered; `received` is the follower's read position. */
  let head = 0;
  let received = 0;
  let started: Promise<void> | null = null;
  let timers: ReturnType<typeof setInterval>[] = [];
  const inbox: Entry[] = [];
  let draining = false;
  let room: (() => void) | null = null;

  const cursorAt = (seq: number) => input.topic().cursorAt(seq);
  const frame = {
    ready: (id: string, seq: number) => JSON.stringify({ t: "ready", id, cursor: cursorAt(seq) }),
    resync: (id: string, cursor: string) => JSON.stringify({ t: "resync", id, cursor }),
    revoked: (id: string, code: "not_found" | "access_denied") => JSON.stringify({ t: "revoked", id, code }),
    // The data is serialized once per event and spliced into each subscription's frame.
    event: (id: string, entry: Entry) =>
      entry.resync
        ? frame.resync(id, entry.cursor)
        : `{"t":"event","id":${JSON.stringify(id)},"cursor":${JSON.stringify(entry.cursor)},"data":${entry.data}}`,
  };

  // ---------- sockets ----------

  const detach = (conn: Connection) => {
    for (const sub of conn.subs.values()) removeSubscription(sub);
    connections.delete(conn);
  };

  const close = (conn: Connection, code: number, reason: string, text?: string) => {
    if (conn.closed) return;
    conn.closed = true;
    try {
      if (text) conn.socket.send(JSON.stringify({ t: "error", code: reason, message: text }));
      conn.socket.close(code, reason);
    } catch {
      // The peer is already gone.
    }
    detach(conn);
  };

  /** Closes sockets whose check failed; they reconnect and resume from their cursor. Logged once per cause. */
  const fail = (conns: Iterable<Connection>, error: unknown, what: string) => {
    let closed = 0;
    for (const conn of conns) {
      if (conn.closed) continue;
      close(conn, 1011, "unavailable", "Live updates are briefly unavailable.");
      closed++;
    }
    if (closed > 0) log.warn(`Live sockets closed: ${what} failed`, { appId, sockets: closed, error: message(error) });
  };

  const violation = (conn: Connection, code: string) => close(conn, 1008, code, "The live socket received an invalid message.");

  const write = (conn: Connection, text: string) => {
    if (conn.closed) return;
    conn.socket.send(text);
    if (conn.socket.getBufferedAmount() > LIVE_LIMITS.sendBufferBytes) {
      log.warn("Live socket closed because the client reads too slowly", { appId });
      close(conn, 1013, "backpressure", "The client reads live updates too slowly.");
    }
  };

  /** Writes and waits while the send buffer is full, at most 10 seconds. */
  const writeWaiting = async (conn: Connection, text: string): Promise<boolean> => {
    if (conn.closed) return false;
    conn.socket.send(text);
    const deadline = Date.now() + LIVE_LIMITS.replayWaitMs;
    while (conn.socket.getBufferedAmount() > LIVE_LIMITS.sendBufferBytes) {
      if (conn.closed) return false;
      if (Date.now() > deadline) {
        close(conn, 1013, "backpressure", "The client reads live updates too slowly.");
        return false;
      }
      await sleep(25);
    }
    return !conn.closed;
  };

  const send = (sub: Subscription, text: string) => {
    if (sub.backlog) sub.backlog.push(text);
    else write(sub.conn, text);
  };

  // ---------- index ----------

  const indexKey = (sub: Subscription, key: string) => {
    const subs = index.get(key);
    if (subs) subs.add(sub);
    else index.set(key, new Set([sub]));
  };

  const unindexKey = (sub: Subscription, key: string) => {
    const subs = index.get(key);
    subs?.delete(sub);
    if (subs?.size === 0) index.delete(key);
  };

  const removeSubscription = (sub: Subscription) => {
    for (const key of sub.keys) unindexKey(sub, key);
    if (sub.conn.subs.get(sub.id) === sub) sub.conn.subs.delete(sub.id);
  };

  /** A single-key subscription ends; a collection drops the key and reloads. */
  const loseKey = (sub: Subscription, key: string) => {
    if (!sub.collection) {
      send(sub, frame.revoked(sub.id, "access_denied"));
      removeSubscription(sub);
      return;
    }
    sub.keys.delete(key);
    unindexKey(sub, key);
    send(sub, frame.resync(sub.id, cursorAt(head)));
  };

  /** Distinct viewers of `key`'s subscriptions, per channel. */
  const viewersOf = (key: string): Map<string, LiveViewer[]> => {
    const byChannel = new Map<string, Map<string, LiveViewer>>();
    for (const sub of index.get(key) ?? []) {
      const viewers = byChannel.get(sub.channel) ?? new Map<string, LiveViewer>();
      viewers.set(sub.conn.viewer.id, sub.conn.viewer);
      byChannel.set(sub.channel, viewers);
    }
    return new Map([...byChannel].map(([channel, viewers]) => [channel, [...viewers.values()]]));
  };

  // ---------- authorization ----------

  let inFlight = 0;
  const waiting: (() => void)[] = [];
  const limited = async <T>(run: () => Promise<T>): Promise<T> => {
    while (inFlight >= LIVE_LIMITS.callsInFlight) await new Promise<void>((resolve) => waiting.push(resolve));
    inFlight++;
    try {
      return await run();
    } finally {
      inFlight--;
      waiting.shift()?.();
    }
  };

  const cacheKey = (channel: string, key: string, viewerId: string) => `${channel}\u0000${key}\u0000${viewerId}`;

  /** Whether each viewer may read `key`: cached for 2 seconds unless `fresh`, one call per 500 uncached viewers. */
  const decide = async (channel: string, key: string, viewers: readonly LiveViewer[], fresh = false): Promise<Map<string, boolean>> => {
    const decided = new Map<string, boolean>();
    const missing = new Map<string, LiveViewer>();
    const now = Date.now();
    for (const viewer of viewers) {
      const hit = fresh ? undefined : cache.get(cacheKey(channel, key, viewer.id));
      if (hit && now - hit.at < LIVE_LIMITS.cacheMs) decided.set(viewer.id, hit.ok);
      else missing.set(viewer.id, viewer);
    }
    const pending = [...missing.values()];
    for (let start = 0; start < pending.length; start += LIVE_LIMITS.viewersPerCall) {
      const part = pending.slice(start, start + LIVE_LIMITS.viewersPerCall);
      const allowed = await limited(() => (channels[channel] as LiveChannel).authorize(key, part));
      for (const viewer of part) {
        const ok = allowed.has(viewer.id);
        const id = cacheKey(channel, key, viewer.id);
        cache.delete(id);
        cache.set(id, { at: Date.now(), ok });
        if (cache.size > LIVE_LIMITS.cacheEntries) cache.delete(cache.keys().next().value as string);
        decided.set(viewer.id, ok);
      }
    }
    return decided;
  };

  const readableKeys = async (channel: string, keys: readonly string[], viewer: LiveViewer): Promise<string[]> => {
    const unique = [...new Set(keys)];
    const decided = await Promise.all(unique.map((key) => decide(channel, key, [viewer])));
    return unique.filter((_, position) => decided[position]?.get(viewer.id) === true);
  };

  /** Checks every subscriber of `key` without the cache; denied viewers lose the key. */
  const reauthorize = async (key: string) => {
    for (const [channel, viewers] of viewersOf(key)) {
      const subs = [...(index.get(key) ?? [])].filter((sub) => sub.channel === channel);
      try {
        const decided = await decide(channel, key, viewers, true);
        for (const sub of subs) if (sub.keys.has(key) && decided.get(sub.conn.viewer.id) === false) loseKey(sub, key);
      } catch (error) {
        fail(
          subs.map((sub) => sub.conn),
          error,
          "access check",
        );
      }
    }
  };

  /** Runs `keys()` again for collection subscriptions; a changed key set reloads. */
  const refreshCollections = async () => {
    const subs = [...connections].flatMap((conn) => [...conn.subs.values()]).filter((sub) => sub.collection);
    const unchecked: Connection[] = [];
    let failure: unknown;
    await eachLimited(subs, LIVE_LIMITS.sweepInFlight, async (sub) => {
      try {
        const keys = await (channels[sub.channel] as LiveChannel).keys(sub.scope, sub.conn.viewer);
        const next = keys === null ? null : new Set(await readableKeys(sub.channel, keys.slice(0, LIVE_LIMITS.keys), sub.conn.viewer));
        if (sub.conn.subs.get(sub.id) !== sub) return;
        if (next === null) {
          send(sub, frame.revoked(sub.id, "not_found"));
          removeSubscription(sub);
          return;
        }
        if (next.size === sub.keys.size && [...next].every((key) => sub.keys.has(key))) return;
        for (const key of sub.keys) if (!next.has(key)) unindexKey(sub, key);
        for (const key of next) if (!sub.keys.has(key)) indexKey(sub, key);
        sub.keys = next;
        send(sub, frame.resync(sub.id, cursorAt(head)));
      } catch (error) {
        unchecked.push(sub.conn);
        failure = error;
      }
    });
    fail(unchecked, failure, "collection keys");
  };

  // ---------- follower and delivery ----------

  const toEntry = (event: TopicEvent<LiveEnvelope>): Entry => {
    const parsed = LiveEnvelopeSchema.safeParse(event.data);
    const base = { seq: event.sequence, cursor: event.cursor, gap: false };
    if (!parsed.success) {
      log.warn("Skipped a malformed live update", { appId, cursor: event.cursor });
      return { ...base, key: null, data: undefined, resync: false, access: false, bytes: 64 };
    }
    const { k, d, r, a } = parsed.data;
    const data = d === undefined ? undefined : JSON.stringify(d);
    return { ...base, key: k, data, resync: r === true, access: a === true, bytes: (data?.length ?? 0) + k.length + 64 };
  };

  const remember = (entry: Entry) => {
    ring.push(entry);
    ringBytes += entry.bytes;
    while (ring.length > LIVE_LIMITS.ringEvents || ringBytes > LIVE_LIMITS.ringBytes) ringBytes -= ring.shift()?.bytes ?? 0;
  };

  const deliver = async (entry: Entry, decisions: Map<string, Promise<Map<string, boolean>>>) => {
    // Remembered before the candidates are taken: a subscription that registers
    // from here on starts after this event and gets it from the ring instead.
    remember(entry);
    const key = entry.key;
    if (key && (entry.data !== undefined || entry.resync)) {
      const groups = new Map<string, Subscription[]>();
      for (const sub of index.get(key) ?? []) {
        if (entry.seq <= sub.from) continue;
        const group = groups.get(sub.channel);
        if (group) group.push(sub);
        else groups.set(sub.channel, [sub]);
      }
      for (const [channel, candidates] of groups) {
        let decided: Map<string, boolean>;
        try {
          decided = (await decisions.get(`${channel}\u0000${key}`)) ?? new Map();
          // Subscriptions added after the batch started are checked on their own.
          const late = candidates.map((sub) => sub.conn.viewer).filter((viewer) => !decided.has(viewer.id));
          if (late.length > 0) for (const [id, ok] of await decide(channel, key, late)) decided.set(id, ok);
        } catch (error) {
          fail(
            candidates.map((sub) => sub.conn),
            error,
            "access check",
          );
          continue;
        }
        for (const sub of candidates) {
          if (sub.conn.closed || !sub.keys.has(key)) continue;
          if (decided.get(sub.conn.viewer.id)) send(sub, frame.event(sub.id, entry));
          else loseKey(sub, key);
        }
      }
    }
    head = entry.seq;
  };

  /** An access change: forget the key's decisions, check its subscribers and every collection, then deliver. */
  const changeAccess = async (entry: Entry) => {
    const key = entry.key as string;
    for (const id of [...cache.keys()]) if (id.includes(`\u0000${key}\u0000`)) cache.delete(id);
    await reauthorize(key);
    await refreshCollections();
    await deliver(entry, new Map());
  };

  /** The topic lost events before the follower read them: every subscription reloads. */
  const recoverGap = (entry: Entry) => {
    ring = [];
    ringBytes = 0;
    head = entry.seq;
    for (const conn of connections) for (const sub of conn.subs.values()) send(sub, frame.resync(sub.id, cursorAt(head)));
  };

  /** Starts every authorization of a batch at once, then delivers it in order. */
  const deliverBatch = async (batch: Entry[]) => {
    let start = 0;
    while (start < batch.length) {
      let end = start;
      while (end < batch.length && !batch[end]?.access && !batch[end]?.gap) end++;
      const decisions = new Map<string, Promise<Map<string, boolean>>>();
      for (const entry of batch.slice(start, end)) {
        if (!entry.key) continue;
        for (const [channel, viewers] of viewersOf(entry.key)) {
          const id = `${channel}\u0000${entry.key}`;
          if (decisions.has(id)) continue;
          const decision = decide(channel, entry.key, viewers);
          decision.catch(() => undefined);
          decisions.set(id, decision);
        }
      }
      for (const entry of batch.slice(start, end)) await deliver(entry, decisions);
      const special = batch[end];
      if (special?.gap) recoverGap(special);
      else if (special) await changeAccess(special);
      start = end + 1;
    }
  };

  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (inbox.length > 0) {
        const batch = inbox.splice(0, LIVE_LIMITS.batchEvents);
        room?.();
        room = null;
        try {
          await deliverBatch(batch);
        } catch (error) {
          // Never skip silently: every socket resumes from its cursor.
          log.error("Live delivery failed", { appId, error: message(error) });
          head = batch.at(-1)?.seq ?? head;
          fail([...connections], error, "delivery");
        }
      }
    } finally {
      draining = false;
    }
  };

  const follow = async (topic: LiveTopic) => {
    while (!stopping.signal.aborted) {
      try {
        for await (const event of topic.follow({ after: topic.cursorAt(received), signal: stopping.signal })) {
          received = event.sequence;
          inbox.push(toEntry(event));
          void drain();
          if (inbox.length >= LIVE_LIMITS.batchEvents) await new Promise<void>((resolve) => (room = resolve));
        }
      } catch (error) {
        // A stopped Sync does not come back: the process is shutting down.
        if (stopping.signal.aborted || error instanceof SyncLifecycleError) return;
        if (error instanceof RetentionGapError && error.resumeAfter) {
          received = topic.cursorSequence(error.resumeAfter);
          const cursor = topic.cursorAt(received);
          inbox.push({ seq: received, cursor, key: null, data: undefined, resync: false, access: false, gap: true, bytes: 0 });
          void drain();
          continue;
        }
        log.warn("Live follower failed; it resumes", { appId, error: message(error) });
        await sleep(1_000);
      }
    }
  };

  /** Fills the ring with one replay of the recent events, then follows the topic. */
  const start = (): Promise<void> => {
    if (timers.length === 0) {
      timers = [setInterval(() => void sweep(), LIVE_LIMITS.sweepMs), setInterval(progress, LIVE_LIMITS.progressMs)];
      for (const timer of timers) timer.unref?.();
    }
    started ??= (async () => {
      const topic = input.topic();
      const target = topic.cursorSequence(await topic.head());
      let after = Math.max(0, target - LIVE_LIMITS.ringEvents);
      for (;;) {
        try {
          const until = topic.cursorAt(target);
          for await (const event of topic.replay({ after: topic.cursorAt(after), until, signal: stopping.signal }))
            remember(toEntry(event));
          break;
        } catch (error) {
          if (!(error instanceof RetentionGapError) || !error.resumeAfter) throw error;
          ring = [];
          ringBytes = 0;
          after = topic.cursorSequence(error.resumeAfter);
        }
      }
      head = received = target;
      void follow(topic);
    })().catch((error) => {
      started = null;
      throw error;
    });
    return started;
  };

  const whenStarted = () =>
    Promise.race([
      start(),
      sleep(LIVE_LIMITS.fillWaitMs).then(() => {
        throw new Error("The live follower did not start in time");
      }),
    ]);

  // ---------- subscribe ----------

  const sequenceOf = (cursor: string): number | null => {
    try {
      return input.topic().cursorSequence(cursor);
    } catch {
      return null;
    }
  };

  const replayTo = async (sub: Subscription, entries: Entry[]) => {
    for (const entry of entries) if (!(await writeWaiting(sub.conn, frame.event(sub.id, entry)))) return;
    if (sub.conn.subs.get(sub.id) === sub && !(await writeWaiting(sub.conn, frame.ready(sub.id, sub.from)))) return;
    while (sub.backlog && sub.backlog.length > 0) if (!(await writeWaiting(sub.conn, sub.backlog.shift() as string))) return;
    sub.backlog = null;
  };

  const subscribe = async (conn: Connection, request: Extract<LiveClientMessage, { t: "sub" }>) => {
    const channel = Object.hasOwn(channels, request.channel) ? channels[request.channel] : undefined;
    if (!channel) return violation(conn, "unknown_channel");
    if (conn.subs.has(request.id)) return violation(conn, "duplicate_subscription");
    if (conn.subs.size >= LIVE_LIMITS.subscriptions) return violation(conn, "too_many_subscriptions");
    const scope = channel.scope.safeParse(request.scope);
    if (!scope.success) return violation(conn, "invalid_scope");
    await whenStarted();
    const keys = await channel.keys(scope.data, conn.viewer);
    if (keys && keys.length > LIVE_LIMITS.keys)
      throw new Error(`Live channel "${request.channel}" returned more than ${LIVE_LIMITS.keys} keys`);
    const readable = keys === null ? [] : await readableKeys(request.channel, keys, conn.viewer);
    // Not found and not readable look the same.
    if (keys === null || (readable.length === 0 && !channel.collection)) return write(conn, frame.revoked(request.id, "not_found"));
    const after = request.after === undefined ? null : sequenceOf(request.after);
    // A cursor ahead of the follower is fine unless it is also ahead of the topic, which was then recreated.
    const recreated = after !== null && after > head && after > input.topic().cursorSequence(await input.topic().head());
    if (conn.closed) return;

    // Synchronous from here. The position includes an event that is being delivered right now:
    // the replay covers everything up to it, live delivery everything after it.
    const position = Math.max(head, ring.at(-1)?.seq ?? 0);
    const oldest = ring[0]?.seq ?? position + 1;
    const resync = request.after !== undefined && (after === null || after < oldest - 1 || recreated);
    const sub: Subscription = {
      id: request.id,
      conn,
      channel: request.channel,
      collection: channel.collection === true,
      scope: scope.data,
      keys: new Set(readable),
      from: after !== null && !resync && after > position ? after : position,
      backlog: null,
    };
    conn.subs.set(sub.id, sub);
    for (const key of sub.keys) indexKey(sub, key);
    if (resync) return send(sub, frame.resync(sub.id, cursorAt(position)));
    const replay =
      after === null || after >= position
        ? []
        : ring.filter(
            (entry) => entry.seq > after && entry.key !== null && sub.keys.has(entry.key) && (entry.data !== undefined || entry.resync),
          );
    if (replay.length === 0) return send(sub, frame.ready(sub.id, sub.from));
    sub.backlog = [];
    await replayTo(sub, replay);
  };

  const handle = async (conn: Connection, raw: string) => {
    let request: LiveClientMessage;
    try {
      request = LiveClientMessageSchema.parse(JSON.parse(raw));
    } catch {
      return violation(conn, "invalid_message");
    }
    if (request.t === "unsub") {
      const sub = conn.subs.get(request.id);
      if (sub) removeSubscription(sub);
      return;
    }
    await subscribe(conn, request);
  };

  // ---------- sweep and progress ----------

  let sweeping = false;
  let round = 0;
  const sweep = async () => {
    if (sweeping || stopping.signal.aborted) return;
    sweeping = true;
    round++;
    try {
      const unchecked: Connection[] = [];
      let failure: unknown;
      await eachLimited([...connections], LIVE_LIMITS.sweepInFlight, async (conn) => {
        if (conn.closed) return;
        try {
          const viewer = await conn.revalidate();
          if (!viewer || viewer.id !== conn.viewer.id) close(conn, 1008, "session_expired", "The session ended.");
          else conn.viewer = viewer;
        } catch (error) {
          unchecked.push(conn);
          failure = error;
        }
      });
      fail(unchecked, failure, "credential check");
      await eachLimited([...index.keys()], LIVE_LIMITS.sweepInFlight, reauthorize);
      if (round % LIVE_LIMITS.keysEveryRounds === 0) await refreshCollections();
    } catch (error) {
      log.error("Live sweep failed", { appId, error: message(error) });
    } finally {
      sweeping = false;
    }
  };

  /** Lets quiet subscriptions move their cursor along, so they stay inside the ring. */
  const progress = () => {
    const text = JSON.stringify({ t: "progress", cursor: cursorAt(head) });
    for (const conn of [...connections]) {
      if ([...conn.subs.values()].every((sub) => sub.backlog === null && sub.from <= head)) write(conn, text);
    }
  };

  return {
    open: (socket: LiveSocket, viewer: LiveViewer, revalidate: () => Promise<LiveViewer | null>): LiveConnectionHandle => {
      start().catch((error) => log.warn("Live follower could not start", { appId, error: message(error) }));
      const conn: Connection = { socket, viewer, revalidate, subs: new Map(), pending: 0, work: Promise.resolve(), closed: false };
      const open = [...connections].filter((other) => other.viewer.id === viewer.id).length;
      connections.add(conn);
      if (open >= LIVE_LIMITS.socketsPerViewer) close(conn, 1013, "too_many_sockets", "Too many live sockets are open.");
      return {
        message: (raw) => {
          if (conn.closed) return;
          if (typeof raw !== "string" || raw.length > LIVE_LIMITS.frameBytes) return violation(conn, "invalid_message");
          if (conn.pending >= LIVE_LIMITS.pendingMessages) return close(conn, 1013, "too_many_messages", "Too many live messages wait.");
          conn.pending++;
          conn.work = conn.work
            .then(() => (conn.closed ? undefined : handle(conn, raw)))
            .catch((error) => fail([conn], error, "subscription"))
            .finally(() => {
              conn.pending--;
            });
        },
        closed: () => {
          conn.closed = true;
          detach(conn);
        },
      };
    },
    stop: () => {
      stopping.abort();
      for (const timer of timers) clearInterval(timer);
      for (const conn of [...connections]) close(conn, 1012, "restart");
    },
  };
};

export type LiveEngine = ReturnType<typeof createLiveEngine>;
