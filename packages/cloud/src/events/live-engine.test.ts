import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { CursorMismatchError, RetentionGapError, type TopicEvent } from "@k2b/sync";
import { z } from "zod";
import {
  createLiveEngine,
  LIVE_LIMITS,
  type LiveChannel,
  type LiveEngine,
  type LiveEnvelope,
  type LiveTopic,
  type LiveViewer,
} from "./live-engine";

/** An in-memory topic with the cursor rules of a Sync topic. */
class FakeTopic implements LiveTopic {
  events: TopicEvent<LiveEnvelope>[] = [];
  first = 1;
  private wake = new Set<() => void>();
  constructor(readonly name = "app") {}

  cursorAt = (sequence: number) => `s6t.${this.name}.${sequence}`;
  cursorSequence = (cursor: string) => {
    const match = /^s6t\.([a-z]+)\.(\d+)$/.exec(cursor);
    if (!match || match[1] !== this.name) throw new CursorMismatchError("The cursor belongs to another topic");
    return Number(match[2]);
  };
  head = async () => this.cursorAt(this.last());
  last = () => this.events.at(-1)?.sequence ?? 0;

  publish(data: LiveEnvelope) {
    const sequence = this.last() + 1;
    this.events.push({
      data,
      eventId: String(sequence),
      cursor: this.cursorAt(sequence),
      sequence,
      tenantId: "default",
      publishedAt: new Date(),
    });
    for (const wake of this.wake) wake();
    this.wake.clear();
  }

  replay = (options: { after?: string; until?: string } = {}): AsyncIterable<TopicEvent<LiveEnvelope>> => {
    const after = this.cursorSequence(options.after ?? this.cursorAt(0));
    const until = options.until ? this.cursorSequence(options.until) : this.last();
    if (after + 1 < this.first)
      throw new RetentionGapError(this.cursorAt(after + 1), this.cursorAt(this.first), this.cursorAt(this.first - 1));
    const events = this.events.filter((event) => event.sequence > after && event.sequence <= until);
    return (async function* () {
      yield* events;
    })();
  };

  follow = (options: { after?: string; signal?: AbortSignal } = {}): AsyncIterable<TopicEvent<LiveEnvelope>> => {
    let position = this.cursorSequence(options.after ?? this.cursorAt(0));
    const topic = this;
    return (async function* () {
      while (!options.signal?.aborted) {
        for (const event of topic.events.filter((candidate) => candidate.sequence > position)) {
          position = event.sequence;
          yield event;
        }
        // An event published while the consumer held the last one woke nobody: read it before waiting.
        if (topic.last() > position) continue;
        await new Promise<void>((resolve) => {
          topic.wake.add(resolve);
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    })();
  };
}

type Frame = { t: string; id?: string; cursor?: string; data?: unknown; code?: string };

const fakeSocket = () => {
  const socket = {
    frames: [] as Frame[],
    closes: [] as { code?: number; reason?: string }[],
    buffered: 0,
    send: (data: string) => void socket.frames.push(JSON.parse(data) as Frame),
    close: (code?: number, reason?: string) => void socket.closes.push({ code, reason }),
    getBufferedAmount: () => socket.buffered,
  };
  return socket;
};

const viewer = (name: string): LiveViewer => ({
  id: `user:${name}`,
  actor: { kind: "user", user: { id: name } } as never,
  accessSubject: { type: "user", userId: name },
  scopes: [],
});

const until = async (condition: () => boolean, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition not reached");
    await Bun.sleep(5);
  }
};

const limits = { ...LIVE_LIMITS };
let topic: FakeTopic;
let engine: LiveEngine;
/** key → viewer ids that may read it */
let readers: Map<string, Set<string>>;
let authorizeCalls: { key: string; viewers: string[] }[];
let authorizeFails = false;
let accessChanged: (subject?: { userId?: string; sid?: string }) => void = () => {};
const subscribeAccess = (changed: (subject?: { userId?: string; sid?: string }) => void) => {
  accessChanged = changed;
  return () => {
    accessChanged = () => {};
  };
};
let valid: Set<string>;

const authorize = async (key: string, viewers: readonly LiveViewer[]) => {
  authorizeCalls.push({ key, viewers: viewers.map((candidate) => candidate.id) });
  if (authorizeFails) throw new Error("reader unavailable");
  return new Set(viewers.filter((candidate) => readers.get(key)?.has(candidate.id)).map((candidate) => candidate.id));
};

const channels: Record<string, LiveChannel> = {
  item: {
    eventOnly: true,
    scope: z.object({ key: z.string() }).strict(),
    keys: async ({ key }: { key: string }) => (key === "missing" ? null : [key]),
    authorize,
  },
  list: {
    eventOnly: true,
    scope: z.object({}).strict(),
    collection: true,
    keys: async (_scope, who) => [...readers].filter(([, ids]) => ids.has(who.id)).map(([key]) => key),
    authorize,
  },
};

const connect = (name = "ada") => {
  const socket = fakeSocket();
  const who = viewer(name);
  const handle = engine.open(socket, who, async () => (valid.has(who.id) ? who : null));
  const send = (message: unknown) => handle.message(JSON.stringify(message));
  const framesOf = (id: string) => socket.frames.filter((frame) => frame.id === id);
  return { socket, handle, send, framesOf };
};

const event = (key: string, n: number): LiveEnvelope => ({ v: 1, k: key, d: { n } });

beforeEach(() => {
  topic = new FakeTopic();
  readers = new Map([
    ["a", new Set(["user:ada", "user:bob"])],
    ["b", new Set(["user:ada"])],
  ]);
  authorizeCalls = [];
  authorizeFails = false;
  valid = new Set(["user:ada", "user:bob"]);
  engine = createLiveEngine({ appId: "app", topic: () => topic, channels, subscribeAccess });
});

afterEach(() => {
  engine.stop();
  Object.assign(LIVE_LIMITS, limits);
});

describe("live engine", () => {
  test("a subscription starts at the head, then receives events of its keys in order", async () => {
    topic.publish(event("a", 1));
    const { send, framesOf } = connect();
    send({ t: "sub", id: "s", channel: "item", scope: { key: "a" } });
    await until(() => framesOf("s").length === 1);
    expect(framesOf("s")[0]).toEqual({ t: "ready", id: "s", cursor: "s6t.app.1" });
    topic.publish(event("b", 2));
    topic.publish(event("a", 3));
    await until(() => framesOf("s").length === 2);
    expect(framesOf("s")[1]).toEqual({ t: "event", id: "s", cursor: "s6t.app.3", data: { n: 3 } });
  });

  test("a cursor inside the ring replays; a cursor before it, from another topic, or beyond the topic resyncs", async () => {
    for (let n = 1; n <= 4; n++) topic.publish(event(n % 2 ? "a" : "b", n));
    const { send, framesOf } = connect();
    send({ t: "sub", id: "replay", channel: "item", scope: { key: "a" }, after: "s6t.app.1" });
    await until(() => framesOf("replay").length === 2);
    expect(framesOf("replay")).toEqual([
      { t: "event", id: "replay", cursor: "s6t.app.3", data: { n: 3 } },
      { t: "ready", id: "replay", cursor: "s6t.app.4" },
    ]);

    send({ t: "sub", id: "foreign", channel: "item", scope: { key: "a" }, after: "s6t.other.2" });
    send({ t: "sub", id: "future", channel: "item", scope: { key: "a" }, after: "s6t.app.99" });
    await until(() => framesOf("future").length === 1);
    expect(framesOf("foreign")).toEqual([{ t: "resync", id: "foreign", cursor: "s6t.app.4" }]);
    expect(framesOf("future")).toEqual([{ t: "resync", id: "future", cursor: "s6t.app.4" }]);

    LIVE_LIMITS.ringEvents = 2;
    topic.publish(event("a", 5));
    topic.publish(event("a", 6));
    await until(() => framesOf("replay").length === 4);
    send({ t: "sub", id: "old", channel: "item", scope: { key: "a" }, after: "s6t.app.2" });
    await until(() => framesOf("old").length === 1);
    expect(framesOf("old")).toEqual([{ t: "resync", id: "old", cursor: "s6t.app.6" }]);
  });

  test("a cursor ahead of the follower starts there and drops older events", async () => {
    topic.publish(event("a", 1));
    const first = connect();
    first.send({ t: "sub", id: "s", channel: "item", scope: { key: "a" } });
    await until(() => first.framesOf("s").length === 1);
    // Published, but the follower has not delivered it yet when the second socket subscribes.
    const second = connect("bob");
    topic.events.push({ ...(topic.events[0] as TopicEvent<LiveEnvelope>), sequence: 2, cursor: "s6t.app.2", data: event("a", 2) });
    second.send({ t: "sub", id: "s", channel: "item", scope: { key: "a" }, after: "s6t.app.2" });
    await until(() => second.framesOf("s").length === 1);
    expect(second.framesOf("s")).toEqual([{ t: "ready", id: "s", cursor: "s6t.app.2" }]);
    topic.publish(event("a", 3));
    await until(() => second.framesOf("s").length === 2);
    expect(second.framesOf("s")[1]).toMatchObject({ t: "event", cursor: "s6t.app.3" });
  });

  test("a viewer that loses access stops receiving: a single key is revoked, a collection drops the key and resyncs", async () => {
    const { send, framesOf } = connect();
    send({ t: "sub", id: "one", channel: "item", scope: { key: "b" } });
    send({ t: "sub", id: "all", channel: "list", scope: {} });
    await until(() => framesOf("all").length === 1);
    readers.set("b", new Set());
    topic.publish({ v: 1, k: "b", a: true });
    topic.publish(event("b", 1));
    topic.publish(event("a", 2));
    await until(() => framesOf("all").length === 3);
    expect(framesOf("one")).toEqual([
      { t: "ready", id: "one", cursor: "s6t.app.0" },
      { t: "revoked", id: "one", code: "access_denied" },
    ]);
    expect(framesOf("all")).toEqual([
      { t: "ready", id: "all", cursor: "s6t.app.0" },
      { t: "resync", id: "all", cursor: "s6t.app.0" },
      { t: "event", id: "all", cursor: "s6t.app.3", data: { n: 2 } },
    ]);
  });

  test("delivery retains subscription decisions and access events batch viewers per key", async () => {
    const ada = connect();
    const bob = connect("bob");
    ada.send({ t: "sub", id: "s", channel: "item", scope: { key: "a" } });
    bob.send({ t: "sub", id: "s", channel: "item", scope: { key: "a" } });
    await until(() => ada.framesOf("s").length === 1 && bob.framesOf("s").length === 1);
    authorizeCalls = [];
    for (let n = 1; n <= 5; n++) topic.publish(event("a", n));
    await until(() => bob.framesOf("s").length === 6);
    expect(authorizeCalls).toEqual([]);
    topic.publish({ v: 1, k: "a", a: true });
    await until(() => authorizeCalls.length === 1);
    expect(authorizeCalls).toEqual([{ key: "a", viewers: ["user:ada", "user:bob"] }]);
  });

  test("an oversized update reaches subscribers as a resync at its cursor", async () => {
    const { send, framesOf } = connect();
    send({ t: "sub", id: "s", channel: "item", scope: { key: "a" } });
    await until(() => framesOf("s").length === 1);
    topic.publish({ v: 1, k: "a", r: true });
    await until(() => framesOf("s").length === 2);
    expect(framesOf("s")[1]).toEqual({ t: "resync", id: "s", cursor: "s6t.app.1" });
  });

  test("a failing check closes with 1011, so the client resumes from its cursor", async () => {
    const { socket, send, framesOf } = connect();
    send({ t: "sub", id: "s", channel: "item", scope: { key: "a" } });
    await until(() => framesOf("s").length === 1);
    authorizeFails = true;
    topic.publish({ v: 1, k: "a", a: true });
    await until(() => socket.closes.length === 1);
    expect(socket.closes).toEqual([{ code: 1011, reason: "unavailable" }]);
    expect(framesOf("s")).toHaveLength(1);
  });

  test("a client that reads too slowly is closed with 1013", async () => {
    const { socket, send, framesOf } = connect();
    send({ t: "sub", id: "s", channel: "item", scope: { key: "a" } });
    await until(() => framesOf("s").length === 1);
    socket.buffered = LIVE_LIMITS.sendBufferBytes + 1;
    topic.publish(event("a", 1));
    await until(() => socket.closes.length === 1);
    expect(socket.closes).toEqual([{ code: 1013, reason: "backpressure" }]);
  });

  test("protocol violations end the socket with 1008, a queue of waiting messages with 1013", async () => {
    const cases: [unknown, string][] = [
      ["x".repeat(LIVE_LIMITS.frameBytes + 1), "invalid_message"],
      ["{", "invalid_message"],
      [JSON.stringify({ t: "sub", id: "s", channel: "nope", scope: {} }), "unknown_channel"],
      [JSON.stringify({ t: "sub", id: "s", channel: "item", scope: { key: 1 } }), "invalid_scope"],
      [JSON.stringify({ t: "ping" }), "invalid_message"],
    ];
    for (const [raw, reason] of cases) {
      const { socket, handle } = connect();
      handle.message(raw);
      await until(() => socket.closes.length === 1);
      expect(socket.closes[0]).toEqual({ code: 1008, reason });
    }

    const many = connect();
    for (let n = 0; n <= LIVE_LIMITS.pendingMessages; n++) many.send({ t: "unsub", id: `s${n}` });
    await until(() => many.socket.closes.length === 1);
    expect(many.socket.closes[0]).toEqual({ code: 1013, reason: "too_many_messages" });

    const sequential = connect();
    for (let n = 0; n <= LIVE_LIMITS.subscriptions; n++) {
      sequential.send({ t: "sub", id: `s${n}`, channel: "item", scope: { key: "a" } });
      await until(() => sequential.socket.frames.length > n || sequential.socket.closes.length > 0);
    }
    expect(sequential.socket.closes[0]).toEqual({ code: 1008, reason: "too_many_subscriptions" });
  });

  test("a missing or unreadable resource looks the same; an empty collection still subscribes", async () => {
    readers = new Map();
    const { send, framesOf } = connect();
    send({ t: "sub", id: "missing", channel: "item", scope: { key: "missing" } });
    send({ t: "sub", id: "hidden", channel: "item", scope: { key: "a" } });
    send({ t: "sub", id: "all", channel: "list", scope: {} });
    await until(() => framesOf("all").length === 1);
    expect(framesOf("missing")).toEqual([{ t: "revoked", id: "missing", code: "not_found" }]);
    expect(framesOf("hidden")).toEqual([{ t: "revoked", id: "hidden", code: "not_found" }]);
    expect(framesOf("all")).toEqual([{ t: "ready", id: "all", cursor: "s6t.app.0" }]);
  });

  test("an access update checks the key's subscribers before it is delivered, and collections right after", async () => {
    const ada = connect();
    const bob = connect("bob");
    ada.send({ t: "sub", id: "all", channel: "list", scope: {} });
    bob.send({ t: "sub", id: "one", channel: "item", scope: { key: "a" } });
    await until(() => ada.framesOf("all").length === 1 && bob.framesOf("one").length === 1);
    readers.set("a", new Set(["user:ada"]));
    readers.set("c", new Set(["user:ada"]));
    topic.publish({ v: 1, k: "a", a: true, d: { n: 1 } });
    await until(() => ada.framesOf("all").some((frame) => frame.t === "resync"));
    expect(bob.framesOf("one")).toEqual([
      { t: "ready", id: "one", cursor: "s6t.app.0" },
      { t: "revoked", id: "one", code: "access_denied" },
    ]);
    expect(ada.framesOf("all")).toContainEqual({ t: "event", id: "all", cursor: "s6t.app.1", data: { n: 1 } });
    topic.publish(event("c", 2));
    await until(() => ada.framesOf("all").at(-1)?.t === "event" && ada.framesOf("all").length >= 4);
    expect(ada.framesOf("all").at(-1)).toEqual({ t: "event", id: "all", cursor: "s6t.app.2", data: { n: 2 } });
  });

  test("a burst of access updates runs keys() at most twice per collection and authorizes only added keys", async () => {
    let keysCalls = 0;
    let gate: Promise<void> = Promise.resolve();
    let open = () => {};
    engine.stop();
    engine = createLiveEngine({
      appId: "app",
      topic: () => topic,
      channels: {
        ...channels,
        list: {
          ...(channels.list as LiveChannel),
          keys: async (scope, who) => {
            keysCalls++;
            await gate;
            return (channels.list as LiveChannel).keys(scope, who);
          },
        },
      },
    });
    const { send, framesOf } = connect();
    send({ t: "sub", id: "all", channel: "list", scope: {} });
    await until(() => framesOf("all").length === 1);
    keysCalls = 0;
    gate = new Promise<void>((resolve) => (open = resolve));
    authorizeCalls = [];
    readers.set("c", new Set(["user:ada"]));
    for (let n = 1; n <= 10; n++) topic.publish({ v: 1, k: `x${n}`, a: true });
    topic.publish(event("b", 11));
    // Delivery does not wait for the collections.
    await until(() => framesOf("all").some((frame) => frame.data !== undefined));
    open();
    await until(() => framesOf("all").some((frame) => frame.t === "resync"));
    await Bun.sleep(20);
    expect(keysCalls).toBe(2);
    expect(authorizeCalls.filter((call) => call.key === "a" || call.key === "b")).toEqual([]);
    expect(authorizeCalls.filter((call) => call.key === "c")).toEqual([{ key: "c", viewers: ["user:ada"] }]);
  });

  test("a collection that resumes after an access update that gave it a key resyncs; without one it replays", async () => {
    // Bob's subscription shows when the replica has delivered what was published.
    const watcher = connect("bob");
    watcher.send({ t: "sub", id: "a", channel: "item", scope: { key: "a" } });
    const first = connect();
    first.send({ t: "sub", id: "all", channel: "list", scope: {} });
    await until(() => first.framesOf("all").length === 1 && watcher.framesOf("a").length === 1);
    const cursor = first.framesOf("all")[0]?.cursor as string;
    first.handle.closed();
    readers.set("c", new Set(["user:ada"]));
    topic.publish({ v: 1, k: "c", a: true });
    topic.publish(event("c", 2));
    topic.publish(event("a", 3));
    await until(() => watcher.framesOf("a").length === 2);
    const back = connect();
    back.send({ t: "sub", id: "all", channel: "list", scope: {}, after: cursor });
    await until(() => back.framesOf("all").length === 1);
    expect(back.framesOf("all")).toEqual([{ t: "resync", id: "all", cursor: "s6t.app.3" }]);

    // Without an access update of its keys, it replays as usual.
    const quiet = connect();
    quiet.send({ t: "sub", id: "all", channel: "list", scope: {}, after: "s6t.app.2" });
    await until(() => quiet.framesOf("all").length === 2);
    expect(quiet.framesOf("all").map((frame) => frame.t)).toEqual(["event", "ready"]);
  });

  test("a collection that resumes after losing a key with an access update resyncs and never sees that key again", async () => {
    const watcher = connect("bob");
    watcher.send({ t: "sub", id: "a", channel: "item", scope: { key: "a" } });
    const first = connect();
    first.send({ t: "sub", id: "all", channel: "list", scope: {} });
    await until(() => first.framesOf("all").length === 1 && watcher.framesOf("a").length === 1);
    topic.publish(event("a", 1));
    await until(() => first.framesOf("all").length === 2);
    const cursor = first.framesOf("all")[1]?.cursor as string;
    first.handle.closed();
    // While the tab is away, ada loses "b", the application announces it, and "b" changes again.
    readers.set("b", new Set());
    topic.publish({ v: 1, k: "b", a: true });
    topic.publish(event("b", 3));
    topic.publish(event("a", 4));
    await until(() => watcher.framesOf("a").length === 3);
    const back = connect();
    back.send({ t: "sub", id: "all", channel: "list", scope: {}, after: cursor });
    await until(() => ["ready", "resync"].includes(back.framesOf("all").at(-1)?.t ?? ""));
    expect(back.framesOf("all")).toEqual([{ t: "resync", id: "all", cursor: "s6t.app.4" }]);
    topic.publish(event("b", 5));
    topic.publish(event("a", 6));
    await until(() => back.framesOf("all").length === 2);
    expect(back.framesOf("all")[1]).toEqual({ t: "event", id: "all", cursor: "s6t.app.6", data: { n: 6 } });
  });

  test("a collection that resumes while its replica still checks a missed access update resyncs", async () => {
    let gate: Promise<void> | null = null;
    let open = () => {};
    const gated = async (key: string, viewers: readonly LiveViewer[]) => {
      const allowed = await authorize(key, viewers);
      if (gate && key === "b") await gate;
      return allowed;
    };
    engine.stop();
    engine = createLiveEngine({
      appId: "app",
      topic: () => topic,
      channels: {
        item: { ...(channels.item as LiveChannel), authorize: gated },
        list: { ...(channels.list as LiveChannel), authorize: gated },
      },
    });
    readers.set("b", new Set(["user:ada", "user:bob"]));
    const bob = connect("bob");
    bob.send({ t: "sub", id: "b", channel: "item", scope: { key: "b" } });
    const first = connect();
    first.send({ t: "sub", id: "all", channel: "list", scope: {} });
    await until(() => first.framesOf("all").length === 1 && bob.framesOf("b").length === 1);
    const cursor = first.framesOf("all")[0]?.cursor as string;
    first.handle.closed();
    // Ada loses "b". The replica has read the announcement, but still checks bob before it delivers it.
    readers.set("b", new Set(["user:bob"]));
    gate = new Promise<void>((resolve) => (open = resolve));
    authorizeCalls = [];
    topic.publish({ v: 1, k: "b", a: true });
    await until(() => authorizeCalls.some((call) => call.key === "b"));
    const back = connect();
    back.send({ t: "sub", id: "all", channel: "list", scope: {}, after: cursor });
    await until(() => ["ready", "resync"].includes(back.framesOf("all").at(-1)?.t ?? ""));
    gate = null;
    open();
    expect(back.framesOf("all")).toEqual([{ t: "resync", id: "all", cursor: "s6t.app.0" }]);
  });

  test("a subscription that resumes while an access update arrives resyncs instead of replaying with the older answer", async () => {
    let gate: Promise<void> | null = null;
    let open = () => {};
    engine.stop();
    engine = createLiveEngine({
      appId: "app",
      topic: () => topic,
      channels: {
        item: {
          ...(channels.item as LiveChannel),
          authorize: async (key, viewers) => {
            const allowed = await authorize(key, viewers);
            if (gate && key === "b") await gate;
            return allowed;
          },
        },
      },
    });
    topic.publish(event("b", 1));
    const watcher = connect("bob");
    watcher.send({ t: "sub", id: "a", channel: "item", scope: { key: "a" } });
    await until(() => watcher.framesOf("a").length === 1);
    gate = new Promise<void>((resolve) => (open = resolve));
    const ada = connect();
    ada.send({ t: "sub", id: "b", channel: "item", scope: { key: "b" }, after: "s6t.app.1" });
    // Ada's check has read "allowed" but not answered when she loses "b" and "b" changes again.
    await until(() => authorizeCalls.some((call) => call.key === "b"));
    readers.set("b", new Set());
    topic.publish({ v: 1, k: "b", a: true });
    topic.publish(event("b", 3));
    topic.publish(event("a", 4));
    await until(() => watcher.framesOf("a").length === 2);
    gate = null;
    open();
    await until(() => ada.framesOf("b").length === 1);
    expect(ada.framesOf("b")).toEqual([{ t: "revoked", id: "b", code: "not_found" }]);
    topic.publish(event("b", 5));
    await Bun.sleep(20);
    expect(ada.framesOf("b")).toHaveLength(1);
  });

  test("admission repeats a decision invalidated while it was pending", async () => {
    let gate: Promise<void> | null = null;
    let open = () => {};
    engine.stop();
    engine = createLiveEngine({
      appId: "app",
      topic: () => topic,
      channels: {
        item: {
          ...(channels.item as LiveChannel),
          authorize: async (key, viewers) => {
            const allowed = await authorize(key, viewers);
            if (gate) await gate;
            return allowed;
          },
        },
      },
    });
    gate = new Promise<void>((resolve) => (open = resolve));
    const { send, framesOf } = connect("bob");
    send({ t: "sub", id: "s", channel: "item", scope: { key: "a" } });
    await until(() => authorizeCalls.length === 1);
    readers.set("a", new Set(["user:ada"]));
    topic.publish({ v: 1, k: "a", a: true });
    await Bun.sleep(20);
    gate = null;
    open();
    await until(() => framesOf("s").length === 1);
    expect(framesOf("s")).toEqual([{ t: "revoked", id: "s", code: "not_found" }]);
    expect(authorizeCalls).toHaveLength(2);
    topic.publish(event("a", 2));
    await Bun.sleep(20);
    expect(framesOf("s")).toHaveLength(1);
  });

  test("identity events end sessions, revoke quiet subscriptions, and refresh collections", async () => {
    engine.stop();
    engine = createLiveEngine({ appId: "app", topic: () => topic, channels, subscribeAccess });
    const ada = connect();
    const bob = connect("bob");
    ada.send({ t: "sub", id: "one", channel: "item", scope: { key: "b" } });
    ada.send({ t: "sub", id: "all", channel: "list", scope: {} });
    bob.send({ t: "sub", id: "one", channel: "item", scope: { key: "a" } });
    await until(() => ada.framesOf("all").length === 1 && bob.framesOf("one").length === 1);

    readers.set("b", new Set());
    valid.delete("user:bob");
    accessChanged();
    await until(() => ada.framesOf("one").length === 2 && bob.socket.closes.length === 1);
    expect(ada.framesOf("one")[1]).toEqual({ t: "revoked", id: "one", code: "access_denied" });
    expect(ada.framesOf("all")[1]).toMatchObject({ t: "resync", id: "all" });
    expect(bob.socket.closes).toEqual([{ code: 1008, reason: "session_expired" }]);

    readers.set("d", new Set(["user:ada"]));
    accessChanged();
    await until(() => ada.framesOf("all").length === 3);
    topic.publish(event("d", 1));
    await until(() => ada.framesOf("all").length === 4);
    expect(ada.framesOf("all")[3]).toMatchObject({ t: "event", data: { n: 1 } });
  });

  test("identity invalidation suspends delivery until a pending credential check has settled", async () => {
    const socket = fakeSocket();
    const who = viewer("ada");
    let release: (value: LiveViewer | null) => void = () => {};
    let checking = false;
    let initial = true;
    const connection = engine.open(socket, who, () => {
      if (initial) {
        initial = false;
        return Promise.resolve(who);
      }
      checking = true;
      return new Promise<LiveViewer | null>((resolve) => {
        release = resolve;
      });
    });
    connection.message(JSON.stringify({ t: "sub", id: "s", channel: "item", scope: { key: "a" } }));
    await until(() => socket.frames.length === 1);
    const bob = connect("bob");
    bob.send({ t: "sub", id: "b", channel: "item", scope: { key: "a" } });
    await until(() => bob.framesOf("b").length === 1);
    accessChanged({ userId: "ada" });
    await until(() => checking);
    topic.publish(event("a", 1));
    await until(() => bob.framesOf("b").length === 2);
    await Bun.sleep(0);
    expect(socket.frames.map((frame) => frame.t)).toEqual(["ready"]);
    release(null);
    await until(() => socket.closes.length === 1);
    expect(socket.closes).toEqual([{ code: 1008, reason: "session_expired" }]);
    expect(socket.frames.some((frame) => frame.t === "event")).toBe(false);
  });

  test("a reconnect sends every subscription at once: 16 of them all become ready", async () => {
    engine.stop();
    engine = createLiveEngine({
      appId: "app",
      topic: () => topic,
      channels: {
        item: {
          ...(channels.item as LiveChannel),
          keys: async (scope, who) => {
            await Bun.sleep(5);
            return (channels.item as LiveChannel).keys(scope, who);
          },
        },
      },
    });
    const { socket, send } = connect();
    for (let n = 0; n < LIVE_LIMITS.subscriptions; n++) send({ t: "sub", id: `s${n}`, channel: "item", scope: { key: "a" } });
    await until(() => socket.frames.length === LIVE_LIMITS.subscriptions);
    expect(socket.closes).toEqual([]);
    expect(socket.frames.every((frame) => frame.t === "ready")).toBe(true);
  });

  test("a ring fill that fails halfway leaves nothing behind for the next attempt", async () => {
    for (let n = 1; n <= 10; n++) topic.publish(event("a", n));
    const replay = topic.replay;
    let failOnce = true;
    topic.replay = (options) => {
      const events = replay(options);
      if (!failOnce) return events;
      failOnce = false;
      return (async function* () {
        let count = 0;
        for await (const item of events) {
          if (++count > 6) throw new Error("NATS hiccup");
          yield item;
        }
      })();
    };
    const first = connect();
    first.send({ t: "sub", id: "s", channel: "item", scope: { key: "a" } });
    await until(() => first.socket.closes.length === 1);
    expect(first.socket.closes[0]).toEqual({ code: 1011, reason: "unavailable" });

    const second = connect();
    second.send({ t: "sub", id: "s", channel: "item", scope: { key: "a" }, after: "s6t.app.3" });
    await until(() => second.framesOf("s").at(-1)?.t === "ready");
    expect(second.framesOf("s").map((frame) => (frame.data as { n: number } | undefined)?.n ?? frame.t)).toEqual([
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      "ready",
    ]);
  });

  test("a replay stops when its subscription is revoked, so revoked is the next frame", async () => {
    for (let n = 1; n <= 5; n++) topic.publish(event("a", n));
    const { socket, send, framesOf } = connect("bob");
    send({ t: "sub", id: "s", channel: "item", scope: { key: "a" }, after: "s6t.app.0" });
    socket.buffered = LIVE_LIMITS.sendBufferBytes + 1;
    await until(() => framesOf("s").length === 1);
    readers.set("a", new Set(["user:ada"]));
    topic.publish({ v: 1, k: "a", a: true });
    topic.publish(event("a", 6));
    await Bun.sleep(30);
    socket.buffered = 0;
    await until(() => framesOf("s").at(-1)?.t === "revoked");
    expect(framesOf("s").map((frame) => (frame.data as { n: number } | undefined)?.n ?? frame.t)).toEqual([1, "revoked"]);
  });

  test("live frames held back during a replay are bounded like the send buffer", async () => {
    for (let n = 1; n <= 3; n++) topic.publish(event("a", n));
    const { socket, send, framesOf } = connect();
    send({ t: "sub", id: "s", channel: "item", scope: { key: "a" }, after: "s6t.app.0" });
    socket.buffered = LIVE_LIMITS.sendBufferBytes + 1;
    await until(() => framesOf("s").length === 1);
    const pad = "x".repeat(LIVE_LIMITS.sendBufferBytes / 4);
    for (let n = 4; n <= 8; n++) topic.publish({ v: 1, k: "a", d: { n, pad } });
    await until(() => socket.closes.length === 1);
    expect(socket.closes).toEqual([{ code: 1013, reason: "backpressure" }]);
  });

  test("a hung identity check fails within the deadline and later invalidations still run", async () => {
    LIVE_LIMITS.checkMs = 50;
    engine.stop();
    engine = createLiveEngine({ appId: "app", topic: () => topic, channels, subscribeAccess });
    const hanging = fakeSocket();
    const ada = viewer("ada");
    engine
      .open(hanging, ada, () => new Promise<never>(() => {}))
      .message(JSON.stringify({ t: "sub", id: "s", channel: "item", scope: { key: "a" } }));
    const bob = connect("bob");
    bob.send({ t: "sub", id: "s", channel: "item", scope: { key: "a" } });
    accessChanged();
    await until(() => hanging.closes.length === 1);
    expect(hanging.closes).toEqual([{ code: 1011, reason: "unavailable" }]);
    valid.delete("user:bob");
    accessChanged();
    await until(() => bob.socket.closes.length === 1);
    expect(bob.socket.closes).toEqual([{ code: 1008, reason: "session_expired" }]);
  });

  test("a scope with more than 1,000 keys follows the first 1,000", async () => {
    // With "a" and "b", the first 1,000 keys end at k997.
    const many = Array.from({ length: LIVE_LIMITS.keys + 5 }, (_, n) => `k${n}`);
    for (const key of many) readers.set(key, new Set(["user:ada"]));
    const { socket, send, framesOf } = connect();
    send({ t: "sub", id: "all", channel: "list", scope: {} });
    await until(() => framesOf("all").length === 1);
    expect(framesOf("all")[0]?.t).toBe("ready");
    expect(socket.closes).toEqual([]);
    topic.publish(event("k997", 1));
    topic.publish(event("k1004", 2));
    topic.publish(event("k0", 3));
    await until(() => framesOf("all").length === 3);
    expect(framesOf("all").map((frame) => (frame.data as { n: number } | undefined)?.n ?? frame.t)).toEqual(["ready", 1, 3]);
  });

  test("progress reports the delivered position; at most 16 sockets per viewer; stopping closes with 1012", async () => {
    LIVE_LIMITS.progressMs = 30;
    engine.stop();
    engine = createLiveEngine({ appId: "app", topic: () => topic, channels, subscribeAccess });
    topic.publish(event("b", 1));
    const { socket, send } = connect("bob");
    send({ t: "sub", id: "s", channel: "item", scope: { key: "a" } });
    topic.publish(event("b", 2));
    await until(() => socket.frames.some((frame) => frame.t === "progress" && frame.cursor === "s6t.app.2"));

    const sockets = Array.from({ length: LIVE_LIMITS.socketsPerViewer + 1 }, () => connect());
    expect(sockets.at(-1)?.socket.closes).toEqual([{ code: 1013, reason: "too_many_sockets" }]);
    engine.stop();
    expect(sockets[0]?.socket.closes).toEqual([{ code: 1012, reason: "restart" }]);
  });

  test("timers never throw once Sync is gone, and a stopped engine starts nothing again", async () => {
    // Sync stops while the engine still runs, as when a teardown drains Sync first.
    let syncGone = false;
    const intervals = spyOn(globalThis, "setInterval");
    try {
      engine.stop();
      engine = createLiveEngine({
        appId: "app",
        topic: () => {
          if (syncGone) throw new Error("Sync is not available before app.start() has connected NATS");
          return topic;
        },
        channels,
      });
      const { socket, send } = connect();
      send({ t: "sub", id: "s", channel: "item", scope: { key: "a" } });
      await until(() => socket.frames.length === 1);
      const ticks = intervals.mock.calls.map(([tick]) => tick as () => void);
      expect(ticks).toHaveLength(1);

      syncGone = true;
      for (const tick of ticks) expect(() => tick()).not.toThrow();
      engine.stop();
      for (const tick of ticks) tick();
      expect(socket.frames).toHaveLength(1);

      const late = connect();
      expect(late.socket.closes).toEqual([{ code: 1012, reason: "restart" }]);

      // Stopped before its first socket, as a mount that serves its first socket while the application stops.
      engine = createLiveEngine({ appId: "app", topic: () => topic, channels, subscribeAccess });
      engine.stop();
      expect(connect().socket.closes).toEqual([{ code: 1012, reason: "restart" }]);
      expect(intervals).toHaveBeenCalledTimes(1);
    } finally {
      intervals.mockRestore();
    }
  });
});

test("channels are periodic by default: two-second delivery cache and ten/sixty-second timers remain", async () => {
  engine.stop();
  const intervals = spyOn(globalThis, "setInterval");
  const fixed = Date.parse("2026-11-13T12:00:00Z");
  setSystemTime(fixed);
  try {
    engine = createLiveEngine({
      appId: "app",
      topic: () => topic,
      channels: {
        item: { ...channels.item!, eventOnly: undefined },
        list: { ...channels.list!, eventOnly: undefined },
      },
    });
    const ada = connect();
    ada.send({ t: "sub", id: "s", channel: "item", scope: { key: "a" } });
    await until(() => ada.framesOf("s").length === 1);
    expect(intervals.mock.calls.map(([, ms]) => ms)).toEqual([10_000, 30_000]);
    expect(LIVE_LIMITS.keysEveryRounds * LIVE_LIMITS.sweepMs).toBe(60_000);
    authorizeCalls.length = 0;
    topic.publish(event("a", 1));
    await until(() => ada.framesOf("s").length === 2);
    expect(authorizeCalls).toHaveLength(0);
    readers.delete("a");
    setSystemTime(fixed + 2_001);
    topic.publish(event("a", 2));
    await until(() => ada.framesOf("s").length === 3);
    expect(authorizeCalls).toHaveLength(1);
    expect(ada.framesOf("s")[2]).toMatchObject({ t: "revoked" });
  } finally {
    setSystemTime();
    intervals.mockRestore();
  }
});

test("one canonical access key invalidates every related assigned-reader key", async () => {
  engine.stop();
  readers.set("mailbox:ada", new Set(["user:ada"]));
  readers.set("mailbox:assigned", new Set(["user:ada"]));
  engine = createLiveEngine({
    appId: "app",
    topic: () => topic,
    channels: {
      mailbox: {
        eventOnly: true,
        accessKey: (key) => key.split(":")[0]!,
        scope: z.object({}),
        keys: async () => ["mailbox:ada", "mailbox:assigned"],
        authorize,
      },
    },
  });
  const ada = connect();
  ada.send({ t: "sub", id: "s", channel: "mailbox", scope: {} });
  await until(() => ada.framesOf("s").length === 1);
  readers.delete("mailbox:ada");
  readers.delete("mailbox:assigned");
  topic.publish({ v: 1, k: "mailbox", a: true });
  topic.publish(event("mailbox:ada", 1));
  topic.publish(event("mailbox:assigned", 2));
  await until(() => ada.framesOf("s").length === 2);
  expect(ada.framesOf("s").map((frame) => frame.t)).toEqual(["ready", "revoked"]);
});

test("an event-only connection rechecks credentials before its first subscription", async () => {
  const socket = fakeSocket();
  const connection = engine.open(socket, viewer("ada"), async () => null);
  connection.message(JSON.stringify({ t: "sub", id: "s", channel: "item", scope: { key: "a" } }));
  await until(() => socket.closes.length === 1);
  expect(socket.frames.map((frame) => frame.t)).toEqual(["error"]);
  expect(socket.closes).toEqual([{ code: 1008, reason: "session_expired" }]);
});

test("identity invalidation allows only one coalesced catch-up", async () => {
  let checks = 0;
  const socket = fakeSocket();
  engine.open(socket, viewer("ada"), async () => {
    checks++;
    accessChanged({ userId: "ada" });
    return viewer("ada");
  });
  await until(() => socket.closes.length === 1);
  expect(checks).toBe(2);
  expect(socket.closes).toEqual([{ code: 1013, reason: "access_changing" }]);
});

test("subscription admission cannot livelock when its authorizer keeps changing access", async () => {
  engine.stop();
  let checks = 0;
  engine = createLiveEngine({
    appId: "app",
    topic: () => topic,
    channels: {
      item: {
        eventOnly: true,
        scope: z.object({}),
        keys: async () => ["a"],
        authorize: async (_key, viewers) => {
          checks++;
          topic.publish({ v: 1, k: "a", a: true });
          await Bun.sleep(0);
          return new Set(viewers.map((viewer) => viewer.id));
        },
      },
    },
  });
  const ada = connect();
  ada.send({ t: "sub", id: "s", channel: "item", scope: {} });
  await until(() => ada.socket.closes.length === 1);
  expect(checks).toBe(2);
  expect(ada.socket.closes).toEqual([{ code: 1013, reason: "access_changing" }]);
});

test("collection refresh defers sustained domain bursts without closing sockets", async () => {
  engine.stop();
  LIVE_LIMITS.sweepMs = 50;
  let changing = false;
  let refreshes = 0,
    listings = 0;
  engine = createLiveEngine({
    appId: "app",
    topic: () => topic,
    channels: {
      list: {
        eventOnly: true,
        collection: true,
        scope: z.object({}),
        keys: async () => {
          listings++;
          if (changing) {
            refreshes++;
            topic.publish({ v: 1, k: "a", a: true });
            await Bun.sleep(0);
          }
          return ["a"];
        },
        authorize,
      },
    },
  });
  const ada = connect();
  ada.send({ t: "sub", id: "s", channel: "list", scope: {} });
  await until(() => ada.framesOf("s").length === 1);
  changing = true;
  topic.publish({ v: 1, k: "a", a: true });
  await until(() => refreshes >= 2 || ada.socket.closes.length > 0);
  await Bun.sleep(20);
  expect(ada.socket.closes).toEqual([]);
  expect(refreshes).toBeLessThanOrEqual(4);
  changing = false;
  await until(() => listings > refreshes + 1);
  topic.publish(event("a", 1));
  await until(() => ada.framesOf("s").some((frame) => frame.t === "event"));
});

test("periodic collection refresh discards decisions from before an access event", async () => {
  engine.stop();
  let changing = false;
  engine = createLiveEngine({
    appId: "app",
    topic: () => topic,
    channels: {
      list: {
        collection: true,
        scope: z.object({}),
        keys: async () => ["a", "b"],
        authorize: async (key, viewers) => {
          const allowed = await authorize(key, viewers);
          if (changing && key === "a") {
            changing = false;
            topic.publish({ v: 1, k: "other", a: true });
            await Bun.sleep(0);
          }
          return allowed;
        },
      },
    },
  });
  const ada = connect();
  ada.send({ t: "sub", id: "s", channel: "list", scope: {} });
  await until(() => ada.framesOf("s").length === 1);
  readers.delete("a");
  changing = true;
  topic.publish({ v: 1, k: "a", a: true });
  topic.publish(event("a", 1));
  topic.publish(event("b", 2));
  await until(() => ada.framesOf("s").some((frame) => frame.t === "event"));
  expect(ada.framesOf("s").filter((frame) => frame.t === "event")).toEqual([expect.objectContaining({ data: { n: 2 } })]);
});

test("foreign identity events during periodic refresh and admission do not retry or close connections", async () => {
  engine.stop();
  const intervals = spyOn(globalThis, "setInterval");
  let refreshes = 0;
  let changing = false;
  try {
    engine = createLiveEngine({
      appId: "app",
      topic: () => topic,
      subscribeAccess,
      channels: {
        list: {
          ...channels.list!,
          eventOnly: undefined,
          keys: async (_scope, who) => {
            refreshes++;
            if (changing) {
              // Bob has a connection, but these events must not invalidate Ada's read.
              accessChanged({ userId: "bob" });
              accessChanged({ userId: "unconnected" });
              await Bun.sleep(0);
            }
            return who.id === "user:ada" ? ["a"] : [];
          },
        },
      },
    });
    const bob = connect("bob");
    const ada = connect();
    changing = true;
    ada.send({ t: "sub", id: "s", channel: "list", scope: {} });
    await until(() => ada.framesOf("s").length === 1);
    expect(refreshes).toBe(1);
    const sweep = intervals.mock.calls.find(([, ms]) => ms === LIVE_LIMITS.sweepMs)![0] as () => void;
    for (let round = 0; round < LIVE_LIMITS.keysEveryRounds; round++) {
      sweep();
      await Bun.sleep(5);
    }
    await until(() => refreshes === 2);
    topic.publish(event("a", 1));
    await until(() => ada.framesOf("s").length === 2);
    expect(refreshes).toBe(2);
    expect(ada.socket.closes).toEqual([]);
    expect(bob.socket.closes).toEqual([]);
  } finally {
    intervals.mockRestore();
  }
});

test("an unstable collection reconnects only its own connection", async () => {
  engine.stop();
  let changing = false;
  let checks = 0;
  engine = createLiveEngine({
    appId: "app",
    topic: () => topic,
    subscribeAccess,
    channels: {
      list: {
        ...channels.list!,
        keys: async (_scope, who) => {
          if (changing && who.id === "user:ada") {
            checks++;
            accessChanged({ userId: "ada" });
            await Bun.sleep(0);
          }
          return ["a"];
        },
      },
    },
  });
  const ada = connect(),
    bob = connect("bob");
  for (const conn of [ada, bob]) conn.send({ t: "sub", id: "s", channel: "list", scope: {} });
  await until(() => ada.framesOf("s").length === 1 && bob.framesOf("s").length === 1);
  changing = true;
  accessChanged({ userId: "ada" });
  await until(() => ada.socket.closes.length === 1);
  expect(checks).toBe(2);
  expect(ada.socket.closes).toEqual([{ code: 1013, reason: "access_changing" }]);
  topic.publish(event("a", 1));
  await until(() => bob.framesOf("s").length === 2);
  expect(bob.socket.closes).toEqual([]);
});

test("a negative periodic credential probe closes even when an identity event overtakes it", async () => {
  engine.stop();
  const intervals = spyOn(globalThis, "setInterval");
  let calls = 0;
  let release: (value: LiveViewer | null) => void = () => {};
  try {
    engine = createLiveEngine({
      appId: "app",
      topic: () => topic,
      subscribeAccess,
      channels: { item: { ...channels.item!, eventOnly: undefined } },
    });
    const socket = fakeSocket();
    const conn = engine.open(socket, viewer("ada"), async () => {
      if (++calls === 2)
        return new Promise<LiveViewer | null>((resolve) => {
          release = resolve;
        });
      return viewer("ada");
    });
    conn.message(JSON.stringify({ t: "sub", id: "s", channel: "item", scope: { key: "a" } }));
    await until(() => socket.frames.length === 1);
    const sweep = intervals.mock.calls.find(([, ms]) => ms === LIVE_LIMITS.sweepMs)![0] as () => void;
    sweep();
    await until(() => calls === 2);
    accessChanged({ userId: "ada" });
    await until(() => calls === 3);
    release(null);
    await until(() => socket.closes.length === 1);
    expect(socket.closes).toEqual([{ code: 1008, reason: "session_expired" }]);
  } finally {
    release(null);
    intervals.mockRestore();
  }
});

test("periodic delivery prefetches eight decisions in parallel and sends the batch in topic order", async () => {
  engine.stop();
  const fixed = Date.parse("2026-11-13T12:00:00Z");
  setSystemTime(fixed);
  let prefetch = false,
    active = 0,
    peak = 0;
  let releaseFirst: () => void = () => {},
    releaseBatch: () => void = () => {};
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const batch = new Promise<void>((resolve) => {
    releaseBatch = resolve;
  });
  const keys = Array.from({ length: 17 }, (_, i) => `k${i}`);
  try {
    engine = createLiveEngine({
      appId: "app",
      topic: () => topic,
      channels: {
        list: {
          collection: true,
          scope: z.object({}),
          keys: async () => keys,
          authorize: async (key, viewers) => {
            if (prefetch) {
              active++;
              peak = Math.max(peak, active);
              await (key === "k0" ? first : batch);
              active--;
            }
            return new Set(viewers.map((who) => who.id));
          },
        },
      },
    });
    const ada = connect();
    ada.send({ t: "sub", id: "s", channel: "list", scope: {} });
    await until(() => ada.framesOf("s").length === 1);
    setSystemTime(fixed + 2_001);
    prefetch = true;
    topic.publish(event("k0", 0));
    await until(() => active === 1);
    for (let i = 1; i < keys.length; i++) topic.publish(event(keys[i]!, i));
    // Wait for the follower to enqueue the burst behind the blocked first entry.
    await Bun.sleep(5);
    releaseFirst();
    await until(() => peak === LIVE_LIMITS.callsInFlight);
    releaseBatch();
    await until(() => ada.framesOf("s").length === 18);
    expect(peak).toBe(8);
    expect(
      ada
        .framesOf("s")
        .slice(1)
        .map((frame) => (frame.data as { n: number }).n),
    ).toEqual(keys.map((_, i) => i));
    expect(ada.socket.closes).toEqual([]);
  } finally {
    releaseFirst();
    releaseBatch();
    setSystemTime();
  }
});

test("late viewers joining during periodic prefetch receive a fresh decision", async () => {
  engine.stop();
  const blocked = Promise.withResolvers<void>();
  let prefetch = false;
  let started = false;
  let lateChecks = 0;
  engine = createLiveEngine({
    appId: "app",
    topic: () => topic,
    channels: {
      item: {
        ...channels.item!,
        eventOnly: undefined,
        authorize: async (_key, viewers) => {
          if (prefetch && viewers.some((who) => who.id === "user:ada")) {
            started = true;
            await blocked.promise;
          }
          if (prefetch && viewers.some((who) => who.id === "user:bob")) lateChecks++;
          return new Set(viewers.map((who) => who.id));
        },
      },
    },
  });
  const fixed = Date.parse("2026-11-13T12:00:00Z");
  setSystemTime(fixed);
  const ada = connect();
  ada.send({ t: "sub", id: "s", channel: "item", scope: { key: "a" } });
  await until(() => ada.framesOf("s").length === 1);
  const bob = connect("bob");
  try {
    setSystemTime(fixed + LIVE_LIMITS.cacheMs + 1);
    prefetch = true;
    topic.publish(event("a", 1));
    await until(() => started);
    bob.send({ t: "sub", id: "s", channel: "item", scope: { key: "a" } });
    await until(() => bob.framesOf("s").length === 1);
    blocked.resolve();
    await until(() => bob.framesOf("s").length === 2);
    expect(bob.framesOf("s")[1]).toMatchObject({ t: "event", data: { n: 1 } });
    expect(lateChecks).toBeGreaterThan(0);
    expect(bob.socket.closes).toEqual([]);
  } finally {
    blocked.resolve();
    setSystemTime();
  }
});

test("unrelated domain events do not restart admission, including canonical access keys", async () => {
  engine.stop();
  let checks = 0;
  engine = createLiveEngine({
    appId: "app",
    topic: () => topic,
    channels: {
      item: {
        ...channels.item!,
        accessKey: (key) => key.split(":")[0]!,
        keys: async () => ["mailbox:assigned"],
        authorize: async (_key, viewers) => {
          checks++;
          topic.publish({ v: 1, k: "foreign-draft", a: true });
          topic.publish({ v: 1, k: "foreign-message", a: true });
          await Bun.sleep(0);
          return new Set(viewers.map((who) => who.id));
        },
      },
    },
  });
  const ada = connect();
  ada.send({ t: "sub", id: "s", channel: "item", scope: { key: "mailbox:assigned" } });
  await until(() => ada.framesOf("s").length > 0 || ada.socket.closes.length > 0);
  expect(ada.socket.closes).toEqual([]);
  expect(ada.framesOf("s")[0]?.t).toBe("ready");
  expect(checks).toBe(1);
});

test("an identity hint invalidates a prefetched periodic decision before the next frame", async () => {
  engine.stop();
  const blocked = Promise.withResolvers<void>();
  let prefetch = false,
    started = false,
    readable = true,
    invalidations = 0;
  engine = createLiveEngine({
    appId: "app",
    topic: () => topic,
    subscribeAccess,
    channels: {
      item: {
        ...channels.item!,
        eventOnly: undefined,
        authorize: async (_key, viewers, context) => {
          if (context?.identityChanged) {
            invalidations++;
            return new Set(viewers.map((who) => who.id));
          }
          const allowed = readable;
          if (prefetch && !started) {
            started = true;
            await blocked.promise;
          }
          return new Set(allowed ? viewers.map((who) => who.id) : []);
        },
      },
    },
  });
  const fixed = Date.parse("2026-11-13T12:00:00Z");
  setSystemTime(fixed);
  try {
    const ada = connect();
    ada.send({ t: "sub", id: "s", channel: "item", scope: { key: "a" } });
    await until(() => ada.framesOf("s").length === 1);
    setSystemTime(fixed + LIVE_LIMITS.cacheMs + 1);
    prefetch = true;
    topic.publish(event("a", 1));
    await until(() => started);
    readable = false;
    accessChanged({ userId: "ada" });
    await until(() => invalidations === 1);
    blocked.resolve();
    await until(() => ada.framesOf("s").length === 2);
    expect(ada.framesOf("s")[1]).toMatchObject({ t: "revoked", code: "access_denied" });
    expect(ada.framesOf("s").some((frame) => frame.t === "event")).toBe(false);
    expect(ada.socket.closes).toEqual([]);
  } finally {
    blocked.resolve();
    setSystemTime();
  }
});

test("admission retries a canonical root change during authorization", async () => {
  engine.stop();
  let checks = 0;
  engine = createLiveEngine({
    appId: "app",
    topic: () => topic,
    channels: {
      item: {
        ...channels.item!,
        accessKey: (key) => key.split(":")[0]!,
        keys: async () => ["mailbox:assigned"],
        authorize: async (_key, viewers) => {
          if (++checks === 1) {
            topic.publish({ v: 1, k: "mailbox", a: true });
            await Bun.sleep(0);
            return new Set(viewers.map((who) => who.id));
          }
          return new Set();
        },
      },
    },
  });
  const ada = connect();
  ada.send({ t: "sub", id: "s", channel: "item", scope: { key: "mailbox:assigned" } });
  await until(() => ada.framesOf("s").length > 0);
  expect(checks).toBe(2);
  expect(ada.framesOf("s")).toEqual([{ t: "revoked", id: "s", code: "not_found" }]);
  expect(ada.socket.closes).toEqual([]);
});
