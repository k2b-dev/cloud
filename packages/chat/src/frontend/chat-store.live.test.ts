import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { liveConnection } from "@k2b/cloud/browser/live";
import { UserSchema } from "@k2b/cloud/contracts";
import type { LiveViewer } from "@k2b/cloud/events";
import { createLiveEngine, createMemoryLiveTopic, LIVE_LIMITS, type LiveEngine, type LiveEnvelope } from "@k2b/cloud/events/testing";
import { z } from "zod";
import { ChatModel, type ModelMessage, type ModelOperation, randomOperation } from "../service/chat-model.test-fixture";
import {
  ChatLiveEventSchema,
  ConversationPageSchema,
  ConversationSchema,
  MessagePageSchema,
  MessageSchema,
  SendMessageSchema,
} from "../service/contracts";
import { chatLiveUpdates } from "../service/live-updates";
import { rng } from "../service/rng.test-fixture";
import { deriveTitle } from "../service/titles";
import { messagePreview } from "../system-messages";
import { type ChatStoreApi, createChatStore } from "./chat-store";

const X = "xxxxxx",
  Y = "yyyyyy",
  Z = "zzzzzz";
const personId = (n: number) => `11111111-1111-4111-8111-${String(n + 1).padStart(12, "0")}`;
const viewer = (id: string): LiveViewer => ({
  id: `user:${id}`,
  scopes: [],
  accessSubject: { type: "user", userId: id },
  actor: {
    kind: "user",
    user: UserSchema.parse({
      id,
      uid: id,
      provider: "local",
      profile: "user",
      roles: ["user"],
      givenname: id,
      sn: "",
      displayName: id,
      mail: null,
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
    }),
  },
});
const FrameSchema = z.object({ t: z.string(), id: z.string().optional(), data: z.unknown().optional(), code: z.string().optional() });

const unusedMemberRequest = async () => {
  throw new Error("Unused member request");
};
const memberApi = {
  create: unusedMemberRequest,
  updateDetails: unusedMemberRequest,
  members: unusedMemberRequest,
  previewMembers: unusedMemberRequest,
  addMembers: unusedMemberRequest,
  updateMember: unusedMemberRequest,
  removeMember: unusedMemberRequest,
  leave: unusedMemberRequest,
  people: unusedMemberRequest,
};

class World {
  topic = createMemoryLiveTopic();
  people: string[];
  names: Map<string, string>;
  models = new Map<string, ChatModel>();
  dates = new Map<ModelMessage, string>();
  activity = new Map<string, string>();
  pending = new Map<string, LiveEnvelope[]>();
  revokedAt = new Map<string, number>();
  tick = 0;
  engine: LiveEngine;
  leaks = 0;
  resyncs = 0;
  dropped = 0;
  changesCalls = 0;
  latestCalls = 0;
  stores: ReturnType<typeof createChatStore>[] = [];
  starts = new Map<ReturnType<typeof createChatStore>, number>();
  constructor(count = 4) {
    this.people = Array.from({ length: count }, (_, i) => personId(i));
    this.names = new Map(this.people.map((id, i) => [id, `Person ${i}`]));
    for (const id of [X, Y, Z]) {
      const model = new ChatModel(this.names);
      this.models.set(id, model);
      const members =
        count > 4 ? this.people.slice(1) : id === Z ? [] : id === X ? this.people.slice(1) : [this.people[1]!, this.people[3]!];
      this.record(id, model.create(this.people[0]!, members), [this.people[0]!, ...members]);
    }
    this.pending.clear();
    const readers = async (key: string, viewers: readonly LiveViewer[]) =>
      new Set(
        viewers.filter((v) => v.accessSubject.type === "user" && this.readable(v.accessSubject.userId, key.slice(2))).map((v) => v.id),
      );
    this.engine = createLiveEngine({
      appId: "chat",
      topic: () => this.topic,
      channels: {
        conversation: {
          scope: z.object({ conversation: z.string() }).strict(),
          keys: async ({ conversation }: { conversation: string }) => [`c:${conversation}`],
          authorize: readers,
        },
        list: {
          scope: z.object({}).strict(),
          collection: true,
          keys: async (_scope: unknown, v: LiveViewer) =>
            v.accessSubject.type === "user" ? this.list(v.accessSubject.userId).items.map((row) => `l:${row.id}`) : [],
          authorize: readers,
        },
        me: {
          scope: z.object({}).strict(),
          keys: async (_scope: unknown, v: LiveViewer) => (v.accessSubject.type === "user" ? [`p:${v.accessSubject.userId}`] : null),
          authorize: async (key: string, viewers: readonly LiveViewer[]) =>
            new Set(viewers.filter((v) => v.accessSubject.type === "user" && key === `p:${v.accessSubject.userId}`).map((v) => v.id)),
        },
      },
    });
  }
  readable(person: string, id: string) {
    return this.models.get(id)?.members.has(person) ?? false;
  }
  message(id: string, m: ModelMessage) {
    return MessageSchema.parse({
      id: id + String(m.seq).padStart(4, "0"),
      conversationId: id,
      seq: m.seq,
      rev: m.rev,
      kind: m.kind,
      author: { type: "user", id: m.author, name: this.names.get(m.author) },
      body: m.body,
      system: m.system,
      createdAt: this.dates.get(m),
    });
  }
  record(id: string, m: ModelMessage, affected: string[]) {
    const date = new Date(Date.UTC(2026, 9, 12) + ++this.tick).toISOString();
    this.dates.set(m, date);
    if (m.kind === "text" || !this.activity.has(id)) this.activity.set(id, date);
    for (const row of chatLiveUpdates(id, this.message(id, m), m.body === null ? null : messagePreview(m.body), affected)) {
      const queue = this.pending.get(row.key) ?? [];
      if (row.access) queue.push({ v: 1, k: row.key, a: true });
      const envelope: LiveEnvelope = { v: 1, k: row.key, d: row.data };
      queue.push(new TextEncoder().encode(JSON.stringify(envelope)).byteLength > 32 * 1024 ? { v: 1, k: row.key, r: true } : envelope);
      this.pending.set(row.key, queue);
    }
  }
  apply(id: string, op: ModelOperation) {
    const model = this.models.get(id)!;
    const before = new Map(model.members);
    const count = model.msgs.length;
    const message = model.apply(op);
    for (const update of model.outbox)
      if (update.key === "p") {
        const key = `p:${update.principal}`;
        const queue = this.pending.get(key) ?? [];
        queue.push({
          v: 1,
          k: key,
          d: { type: "read", conversationId: id, ...update.read, unread: update.unread, asOfRev: update.asOfRev },
        });
        this.pending.set(key, queue);
      }
    if (!message || count === model.msgs.length) return;
    const affected =
      op.type === "add"
        ? op.members.filter((p) => !before.has(p) && model.members.has(p))
        : op.type === "remove"
          ? [op.member]
          : op.type === "permission"
            ? [op.member]
            : op.type === "leave"
              ? [op.actor, ...[...model.members].filter(([p, permission]) => before.get(p) !== permission).map(([p]) => p)]
              : [];
    this.record(id, message, affected);
    for (const person of this.people) if (this.readable(person, id)) this.revokedAt.delete(`${person}|${id}`);
    return message;
  }
  dispatch(random = rng(1), all = true) {
    const keys = [...this.pending.keys()];
    // Fisher-Yates changes cross-key order without changing any key's FIFO.
    for (let i = keys.length - 1; i > 0; i--) {
      const j = random.int(i + 1);
      [keys[i], keys[j]] = [keys[j]!, keys[i]!];
    }
    for (const key of all ? keys : keys.slice(0, 1)) {
      const queue = this.pending.get(key) ?? [];
      for (const [index, envelope] of queue.entries()) {
        if (envelope.a && key.startsWith("c:")) {
          const event = ChatLiveEventSchema.parse(queue[index + 1]?.d);
          if (event.type !== "message") throw new Error("Access row must precede its message");
          for (const p of this.people) if (!this.readable(p, key.slice(2))) this.revokedAt.set(`${p}|${key.slice(2)}`, event.message.rev);
        }
        this.topic.publish(envelope);
      }
      this.pending.delete(key);
    }
  }
  conversation(person: string, id: string) {
    if (!this.readable(person, id)) return null;
    const m = this.models.get(id)!;
    return ConversationSchema.parse({
      id,
      name: m.name,
      icon: m.icon,
      purpose: m.purpose,
      title: deriveTitle(
        m.name,
        [...m.members.keys()].filter((p) => p !== person).map((p) => ({ displayName: this.names.get(p)!, givenName: this.names.get(p)! })),
        "en",
      ),
      memberCount: m.members.size,
      unread: m.unread(person),
      read: m.parts.has(person)
        ? (() => {
            const { origin: _, ...read } = m.parts.get(person)!;
            return read;
          })()
        : null,
      withGuests: false,
      peerDeactivated: false,
      lastMessage: (() => {
        const latest = m.msgs.findLast((message) => message.kind === "text");
        if (!latest) return null;
        const message = this.message(id, latest);
        return { id: message.id, author: message.author, preview: messagePreview(message.body ?? ""), createdAt: message.createdAt };
      })(),
      permission: m.members.get(person),
      rev: m.rev,
      createdAt: this.dates.get(m.msgs[0]!),
      lastActivityAt: this.activity.get(id),
    });
  }
  list(person: string) {
    return ConversationPageSchema.parse({
      items: [...this.models.keys()]
        .flatMap((id) => {
          const row = this.conversation(person, id);
          return row ? [row] : [];
        })
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || b.id.localeCompare(a.id))
        .slice(0, 50),
      nextCursor: null,
    });
  }
  page(person: string, id: string) {
    if (!this.readable(person, id)) return null;
    const model = this.models.get(id)!;
    return MessagePageSchema.parse({
      items: model.msgs.slice(-50).map((m) => ({ ...this.message(id, m), systemText: null })),
      rev: model.rev,
      seqHead: model.seqHead,
    });
  }
  api(person: string): ChatStoreApi {
    return {
      ...memberApi,
      read: async () => {
        throw new Error("Unused write");
      },
      markUnread: async () => {
        throw new Error("Unused write");
      },
      readAll: async () => {
        throw new Error("Unused write");
      },
      snapshot: async (id) => {
        const conversation = this.conversation(person, id),
          page = this.page(person, id);
        return conversation && page ? { cursor: "snapshot", conversation, page, focus: null } : null;
      },
      conversations: async () => this.list(person),
      conversation: async (id) => this.conversation(person, id),
      messages: async (id) => {
        this.latestCalls++;
        return this.page(person, id);
      },
      changes: async (id, after) => {
        this.changesCalls++;
        if (!this.readable(person, id)) return null;
        const model = this.models.get(id)!;
        if (after > model.rev) return "RESYNC_REQUIRED";
        const messages = model.msgs.filter((m) => m.rev > after).slice(0, 200);
        const more = messages.length === 200;
        return {
          rev: more ? messages.at(-1)!.rev : model.rev,
          more,
          conversation: model.changedRev > after ? this.conversation(person, id) : null,
          messages: messages.map((m) => ({ ...this.message(id, m), systemText: null })),
        };
      },
    };
  }
  async tab(person: string, between = () => {}) {
    const cursor = await this.topic.head();
    between();
    const conversation = this.conversation(person, X),
      page = this.page(person, X);
    const store = createChatStore(
      { viewerId: person, cursor, sidebar: this.list(person), ...(conversation && page ? { open: { conversation, page } } : {}) },
      { api: this.api(person), connection: liveConnection(`/api/chat/live?world=${worldNumber}&person=${person}`, { activity: "always" }) },
    );
    this.stores.push(store);
    this.starts.set(store, page?.items[0]?.seq ?? 1);
    return store;
  }
  async reopen(store: ReturnType<typeof createChatStore>, person: string, between = () => {}) {
    const cursor = await this.topic.head();
    between();
    const conversation = this.conversation(person, X),
      page = this.page(person, X);
    if (conversation && page) {
      this.starts.set(store, page.items[0]?.seq ?? 1);
      store.open({ cursor, conversation, page });
    }
  }
  stop() {
    for (const store of this.stores) store.dispose();
    this.engine.stop();
  }
}
let world: World;
let worldNumber = 0;
class BridgeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static all: BridgeSocket[] = [];
  readyState = BridgeSocket.CONNECTING;
  dead = false;
  dropNext = false;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  handle: ReturnType<LiveEngine["open"]> | null = null;
  person: string;
  constructor(url: string) {
    const person = new URL(url).searchParams.get("person");
    if (!person) throw new Error("Missing bridge person");
    this.person = person;
    BridgeSocket.all.push(this);
    const owner = world;
    setTimeout(() => {
      if (this.dead) return;
      this.handle = owner.engine.open(
        {
          send: (data) => {
            const frame = FrameSchema.parse(JSON.parse(data));
            if (frame.t === "resync") owner.resyncs++;
            setTimeout(() => {
              if (this.dropNext && frame.t === "event") {
                this.dropNext = false;
                this.end(1006);
              }
              if (this.dead) {
                owner.dropped++;
                return;
              }
              const parsed = ChatLiveEventSchema.safeParse(frame.data);
              if (parsed.success && parsed.data.type === "message") {
                const m = parsed.data.message,
                  revoked = owner.revokedAt.get(`${person}|${m.conversationId}`);
                if (revoked !== undefined && m.rev > revoked) owner.leaks++;
              }
              this.onmessage?.({ data });
            }, 0);
          },
          close: (code = 1006, reason = "") => this.end(code, reason),
          getBufferedAmount: () => 0,
        },
        viewer(person),
        async () => viewer(person),
      );
      this.readyState = BridgeSocket.OPEN;
      this.onopen?.(new Event("open"));
    }, 0);
  }
  send(data: string) {
    if (!this.dead) this.handle?.message(data);
  }
  end(code: number, reason = "") {
    if (this.dead) return;
    this.dead = true;
    this.readyState = BridgeSocket.CLOSED;
    this.handle?.closed();
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }
  close(code = 1000, reason = "") {
    this.end(code, reason);
  }
}
const descriptors = new Map(["window", "document", "WebSocket"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const limits = { ...LIVE_LIMITS };
beforeAll(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: Object.assign(new EventTarget(), { location: { origin: "http://localhost:3000" } }),
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: Object.assign(new EventTarget(), { visibilityState: "visible" }),
  });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: BridgeSocket });
  Object.assign(LIVE_LIMITS, { ringEvents: 40, cacheMs: 40, sweepMs: 30, keysEveryRounds: 3, progressMs: 60 });
});
afterEach(() => {
  world?.stop();
  for (const socket of BridgeSocket.all) socket.close();
  BridgeSocket.all = [];
});
afterAll(() => {
  Object.assign(LIVE_LIMITS, limits);
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});
const start = (count = 4) => {
  worldNumber++;
  world = new World(count);
  return world;
};
const settle = async (ms = 20) => {
  await Bun.sleep(ms);
  window.dispatchEvent(new Event("online"));
  await Bun.sleep(ms);
};
const until = async (condition: () => boolean, timeout = 2_000) => {
  const deadline = performance.now() + timeout;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("Chat tab did not converge in time");
    await settle(5);
  }
};
const send = (id: string, body = "hello") => world.apply(id, { type: "send", actor: world.people[0]!, clientId: `k${world.tick}`, body });
const check = (store: ReturnType<typeof createChatStore>, person: string) => {
  expect(store.liveStatus).toBe("live");
  expect(store.sidebar).toEqual(world.list(person).items);
  const open = store.openConversation;
  expect(open).not.toBeNull();
  if (!open) throw new Error("Missing open chat");
  expect(open.status).toBe(world.readable(person, X) ? "live" : "no-access");
  if (open.status === "live") {
    const first = world.starts.get(store)!;
    const row = world.conversation(person, X)!;
    expect(open.conversation).toMatchObject({
      name: row.name,
      icon: row.icon,
      purpose: row.purpose,
      title: row.title,
      memberCount: row.memberCount,
      withGuests: false,
      peerDeactivated: false,
      permission: row.permission,
    });
    expect(open.messages).toEqual(
      world.models
        .get(X)!
        .msgs.filter((m) => m.seq >= first)
        .map((m) => world.message(X, m)),
    );
    expect(open.watermark).toBe(world.models.get(X)!.rev);
  } else expect(open.messages).toEqual([]);
  expect(world.leaks).toBe(0);
};

test("a lost last event replays, including a write between cursor and SSR snapshot", async () => {
  start();
  const p = world.people[0]!;
  const store = await world.tab(p, () => {
    send(X);
    world.dispatch();
  });
  await settle();
  check(store, p);
  const socket = BridgeSocket.all.find((s) => !s.dead)!;
  socket.dropNext = true;
  send(X, "lost last frame");
  world.dispatch();
  await until(() => store.openConversation?.watermark === world.models.get(X)!.rev);
  expect(world.dropped).toBeGreaterThan(0);
  check(store, p);
});

test("ring overflow resyncs as a delta; oversized data reloads through changes", async () => {
  start();
  const p = world.people[1]!,
    store = await world.tab(p);
  await settle();
  for (const socket of BridgeSocket.all) socket.end(1006);
  send(X, "missed");
  for (let i = 0; i < 30; i++) send(Z);
  world.dispatch();
  await Bun.sleep(20);
  await until(() => store.openConversation?.watermark === world.models.get(X)!.rev);
  expect(world.changesCalls).toBeGreaterThan(0);
  const before = world.changesCalls;
  const body = "😀".repeat(8_500);
  expect(SendMessageSchema.safeParse({ clientId: "big", body }).success).toBe(true);
  send(X, body);
  world.dispatch();
  await until(() => store.openConversation?.watermark === world.models.get(X)!.rev);
  expect(world.changesCalls).toBeGreaterThan(before);
  check(store, p);
});

test("100 clients reconnect together and replay without extra resync", async () => {
  start(100);
  const tabs = await Promise.all(world.people.map((p) => world.tab(p)));
  await settle(40);
  expect(BridgeSocket.all.filter((s) => !s.dead)).toHaveLength(100);
  const resyncs = world.resyncs;
  for (const socket of BridgeSocket.all) socket.end(1006);
  send(X);
  world.dispatch();
  await until(() => tabs.every((tab) => tab.openConversation?.watermark === world.models.get(X)!.rev));
  expect(world.resyncs).toBe(resyncs);
  for (const [i, tab] of tabs.entries()) check(tab, world.people[i]!);
});

test("older message and summary cannot overwrite newer revisions", async () => {
  start();
  const p = world.people[0]!,
    store = await world.tab(p);
  await settle();
  const old = send(X, "old")!;
  world.dispatch();
  await settle();
  const newer = send(X, "new")!;
  world.dispatch();
  await until(() => store.openConversation?.watermark === newer.rev);
  const message = world.message(X, newer);
  // The same ID with an older revision exercises the message guard too.
  world.topic.publish({ v: 1, k: `c:${X}`, d: { type: "message", message: { ...message, rev: old.rev, body: "stale" } } });
  const summary = chatLiveUpdates(X, world.message(X, old), "old", [])[1]!;
  world.topic.publish({ v: 1, k: summary.key, d: summary.data });
  await settle(40);
  expect(store.openConversation?.messages.find((m) => m.id === message.id)).toEqual(message);
  expect(store.sidebar.find((row) => row.id === X)).toMatchObject({ rev: newer.rev, lastActivityAt: message.createdAt });
  check(store, p);
});

const seeds = Number(process.env.CHAT_LIVE_SEEDS ?? 12),
  ops = Number(process.env.CHAT_LIVE_OPS ?? 100),
  from = Number(process.env.CHAT_LIVE_SEED_FROM ?? 1);
for (const value of [seeds, ops, from])
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Chat live seeds and ops must be positive safe integers");
test(`model-backed recovery over ${seeds} seeds × ${ops} operations`, async () => {
  for (let seed = from; seed < from + seeds; seed++) {
    start();
    const random = rng(seed);
    const tabs = await Promise.all(world.people.map((p) => world.tab(p)));
    const log: string[] = [];
    try {
      for (let step = 0; step < ops; step++) {
        switch (random.int(10)) {
          case 0:
            for (let i = 0; i < 25; i++) send(Z);
            break;
          case 1:
            for (const socket of BridgeSocket.all.filter((s) => s.person === random.pick(world.people))) socket.end(1006);
            break;
          case 2: {
            const i = random.int(tabs.length);
            await world.reopen(tabs[i]!, world.people[i]!, () => {
              send(X);
              world.dispatch(random);
            });
            break;
          }
          case 3:
            world.dispatch(random, false);
            break;
          case 4:
            await settle(2);
            break;
          default: {
            const id = random.pick([X, Y, X])!,
              op = randomOperation(world.models.get(id)!, random, world.people, step);
            log.push(`${id} ${JSON.stringify(op)}`);
            world.apply(id, op);
          }
        }
        if (random.int(4) === 0) world.dispatch(random);
        if (random.int(3) === 0) await Bun.sleep(0);
      }
      world.dispatch(random);
      for (let i = 0; i < 6; i++) await settle(25);
      for (const [i, tab] of tabs.entries())
        if (tab.openConversation?.status !== "live" && world.readable(world.people[i]!, X)) await world.reopen(tab, world.people[i]!);
      for (let i = 0; i < 6; i++) await settle(25);
      for (const [i, tab] of tabs.entries()) check(tab, world.people[i]!);
    } catch (error) {
      throw new Error(`seed ${seed}; last operations: ${log.slice(-8).join(" | ")}`, { cause: error });
    } finally {
      world.stop();
      BridgeSocket.all = [];
    }
  }
}, 60_000);

test("published remove and leave revoke with zero later message leaks; permission changes refresh metadata", async () => {
  start();
  const owner = world.people[0]!,
    ana = world.people[1]!,
    ben = world.people[2]!;
  const a = await world.tab(ana),
    b = await world.tab(ben);
  await settle();
  world.apply(X, { type: "permission", actor: owner, member: ana, permission: "read" });
  world.dispatch();
  await until(() => a.openConversation?.conversation?.permission === "read");
  world.apply(X, { type: "remove", actor: owner, member: ana });
  send(X, "after remove");
  world.dispatch();
  await until(() => a.openConversation?.status === "no-access");
  world.apply(X, { type: "leave", actor: ben });
  send(X, "after leave");
  world.dispatch();
  await until(() => b.openConversation?.status === "no-access");
  await settle(60);
  check(a, ana);
  check(b, ben);
});
