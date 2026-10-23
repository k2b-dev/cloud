import { expect, test } from "bun:test";
import type { LiveConnection, LiveSubscriptionHandlers } from "@k2b/cloud/browser/live";
import { ConversationSchema, MessageSchema, readStart } from "../service/contracts";
import { chatLiveUpdates } from "../service/live-updates";
import { ChatRequestError, type ChatStoreApi, createChatStore, createChatStoreApi } from "./chat-store";

const noThreads = { general: { unread: 0, lastMessage: null }, items: [] };

const conversation = ConversationSchema.parse({
  threads: 0,
  id: "abcdef",
  name: "Chat",
  title: "Chat",
  icon: null,
  purpose: null,
  memberCount: 2,
  unread: 0,
  read: { lastReadSeq: null, unreadFromSeq: null, joinedSeq: 0 },
  withGuests: false,
  peerDeactivated: false,
  lastMessage: null,
  permission: "write",
  rev: 1,
  createdAt: "2026-10-12T00:00:00.000Z",
  lastActivityAt: "2026-10-12T00:00:00.000Z",
});
const message = (rev: number) =>
  MessageSchema.parse({
    refs: [],
    thread: null,
    replyTo: null,
    id: String(rev).padStart(10, "0"),
    conversationId: conversation.id,
    seq: rev,
    rev,
    kind: "text",
    author: { type: "user", id: "11111111-1111-4111-8111-111111111111", name: "Ana" },
    body: `Message ${rev}`,
    system: null,
    createdAt: new Date(Date.UTC(2026, 9, 12) + rev).toISOString(),
  });
const page = (rev: number) => ({ items: [{ ...message(rev), systemText: null }], rev, seqHead: rev, from: rev, to: rev });
type Controls = {
  apply(data: unknown): Promise<void>;
  applyBatch(data: unknown[]): Promise<void>;
  resync(): Promise<void>;
  revoked(): void;
  unavailable(): void;
  closed: boolean;
  cursor: string | null;
};
class ManualConnection implements LiveConnection {
  channels = new Map<string, Controls>();
  subscribe<T>(channel: string, _scope: unknown, handlers: LiveSubscriptionHandlers<T>) {
    const controls: Controls = {
      apply: async (data) => handlers.apply([{ data: handlers.parse(data), cursor: "cursor" }]),
      applyBatch: async (data) => handlers.apply(data.map((event) => ({ data: handlers.parse(event), cursor: "cursor" }))),
      resync: handlers.resync,
      revoked: () => handlers.revoked?.("access_denied"),
      unavailable: handlers.unavailable,
      closed: false,
      cursor: handlers.cursor,
    };
    this.channels.set(channel, controls);
    return {
      close: () => {
        controls.closed = true;
      },
    };
  }
  get(channel: string) {
    const controls = this.channels.get(channel);
    if (!controls) throw new Error("Missing subscription");
    return controls;
  }
}
const self = { accessId: "11111111-1111-4111-8111-111111111111", permission: "write" as const, active: true };
const memberApi = {
  threads: async () => noThreads,
  shared: async () => ({ items: [], nextCursor: null }),
  createThread: async () => {
    throw new Error("Unused thread request");
  },
  updateThread: async () => {
    throw new Error("Unused thread request");
  },
  create: async () => ({ outcome: "created" as const, conversation }),
  updateDetails: async () => conversation,
  members: async () => ({ items: [], nextCursor: null, managers: 1, self }),
  previewMembers: async () => ({ joining: 1, throughGroups: 0, memberCount: 3 }),
  addMembers: async () => ({ added: 1 }),
  updateMember: async () => ({ success: true as const }),
  removeMember: async () => ({ success: true as const, keptThroughGroup: false }),
  leave: async () => ({ success: true as const, keptThroughGroup: false }),
  people: async () => ({ items: [], nextCursor: null }),
};
const fixture = (overrides: Partial<ChatStoreApi> = {}) => {
  const connection = new ManualConnection();
  const api: ChatStoreApi = {
    ...memberApi,
    read: async () => ({
      threads: [],
      conversationId: conversation.id,
      lastReadSeq: 1,
      unreadFromSeq: null,
      joinedSeq: 0,
      unread: 0,
      asOfRev: 1,
    }),
    markUnread: async () => ({
      threads: [],
      conversationId: conversation.id,
      lastReadSeq: 1,
      unreadFromSeq: 1,
      joinedSeq: 0,
      unread: 0,
      asOfRev: 1,
    }),
    readAll: async () => ({ outcome: "done", marked: 0, more: false }),
    snapshot: async () => ({ threads: noThreads, cursor: "snapshot", conversation, page: page(1), focus: null }),
    conversations: async () => ({ items: [conversation], nextCursor: null }),
    conversation: async () => conversation,
    messages: async () => page(1),
    changes: async () => ({ rev: 1, more: false, conversation: null, messages: [] }),
    ...overrides,
  };
  const store = createChatStore(
    {
      viewerId: "22222222-2222-4222-8222-222222222222",
      cursor: "cursor",
      sidebar: { items: [conversation], nextCursor: null },
      open: { threads: noThreads, view: "all", conversation, page: page(1) },
    },
    { api, connection },
  );
  return { api, connection, store };
};

for (const historical of [false, true]) {
  test(`membership revisions count every author once per live batch${historical ? " outside the displayed history" : ""}`, async () => {
    const { store, connection } = fixture();
    if (historical)
      store.open({ threads: noThreads, view: "all", cursor: "history", conversation, page: { ...page(1), seqHead: 50, rev: 50 } });
    expect(store.openConversation?.membershipRev).toBe(0);
    expect(store.openConversation?.hasNewer).toBe(historical);
    let rev = historical ? 51 : 2;
    let expected = 0;
    const person = { id: message(1).author.id, name: "Ana" };
    const params = {
      members_added: { members: [person] },
      groups_added: { groups: [person] },
      group_removed: { group: person },
      manager_assigned: { member: person },
      member_removed: { member: person },
      member_left: {},
      permission_changed: { member: person, permission: "read" },
      conversation_created: {},
    };
    const system = (code: keyof typeof params, authorId: string) =>
      MessageSchema.parse({
        ...message(rev++),
        kind: "system",
        body: null,
        author: { type: "user", id: authorId, name: "Member" },
        system: { code, params: params[code] },
      });
    for (const authorId of ["22222222-2222-4222-8222-222222222222", "11111111-1111-4111-8111-111111111111"]) {
      for (const code of [
        "members_added",
        "groups_added",
        "group_removed",
        "manager_assigned",
        "member_removed",
        "member_left",
        "permission_changed",
      ] as const) {
        await connection.get("conversation").applyBatch([
          { type: "message", message: system(code, authorId) },
          { type: "message", message: system(code, authorId) },
        ]);
        expect(store.openConversation?.membershipRev).toBe(++expected);
      }
    }
    await connection.get("conversation").applyBatch([
      { type: "message", message: message(rev++) },
      { type: "message", message: system("conversation_created", message(1).author.id) },
      { type: "message", message: { ...system("member_left", message(1).author.id), conversationId: "zzzzzz" } },
    ]);
    expect(store.openConversation?.membershipRev).toBe(expected);
    if (historical) {
      expect(store.openConversation?.messages).toEqual([message(1)]);
      expect(store.openConversation?.hasNewer).toBe(true);
    }
    store.open({ threads: noThreads, view: "all", cursor: "reopen", conversation, page: page(1) });
    expect(store.openConversation?.membershipRev).toBe(0);
    store.dispose();
  });
}

test("a failed conversation resync does not invalidate members", async () => {
  const { store, connection } = fixture({
    changes: async () => {
      throw new Error("Offline");
    },
  });
  await expect(connection.get("conversation").resync()).rejects.toThrow("Offline");
  expect(store.openConversation?.membershipRev).toBe(0);
  store.dispose();
});

test("resync after live text messages asks only for the gap", async () => {
  const afters: number[] = [];
  const { store, connection } = fixture({
    changes: async (_id, after) => {
      afters.push(after);
      return { rev: 50, more: false, conversation: null, messages: [] };
    },
  });
  for (let rev = 2; rev <= 50; rev++) await connection.get("conversation").apply({ type: "message", message: message(rev) });
  await connection.get("conversation").resync();
  expect(afters).toEqual([50]);
  expect(store.openConversation?.membershipRev).toBe(1);
  store.dispose();
});

test("a restore below the watermark after live text messages replaces the history", async () => {
  const { store, connection } = fixture({
    changes: async (_id, after) => (after > 5 ? "RESYNC_REQUIRED" : { rev: 5, more: false, conversation: null, messages: [] }),
    messages: async () => page(5),
    conversation: async () => ({ ...conversation, rev: 5 }),
  });
  for (let rev = 2; rev <= 100; rev++) await connection.get("conversation").apply({ type: "message", message: message(rev) });
  await connection.get("conversation").resync();
  expect(store.openConversation?.watermark).toBe(5);
  expect(store.openConversation?.messages).toEqual([message(5)]);
  const restored = { ...message(6), id: "restored06" };
  await connection.get("conversation").apply({ type: "message", message: restored });
  expect(store.openConversation?.messages).toContainEqual(restored);
  store.dispose();
});

test("a batch with several system messages refreshes the details once", async () => {
  let calls = 0;
  const { store, connection } = fixture({
    conversation: async () => {
      calls++;
      return { ...conversation, rev: 4 };
    },
  });
  const systems = [2, 3, 4].map((rev) =>
    MessageSchema.parse({ ...message(rev), kind: "system", body: null, system: { code: "conversation_created", params: {} } }),
  );
  await connection.get("conversation").applyBatch(systems.map((message) => ({ type: "message", message })));
  expect(calls).toBe(1);
  expect(store.openConversation?.messages).toEqual([message(1), ...systems]);
  store.dispose();
});

test("resync follows delta pages and refreshes metadata without replacing loaded history", async () => {
  const afters: number[] = [];
  const { store, connection } = fixture({
    changes: async (_id, after) => {
      afters.push(after);
      return {
        rev: after + 1,
        more: after === 1,
        conversation: { ...conversation, rev: 3, title: "Renamed", memberCount: 3, permission: "read" },
        messages: [{ ...message(after + 1), systemText: null }],
      };
    },
  });
  await connection.get("conversation").resync();
  expect(afters).toEqual([1, 2]);
  expect(store.openConversation?.membershipRev).toBe(1);
  expect(store.openConversation?.messages.map((m) => m.rev)).toEqual([1, 2, 3]);
  expect(store.openConversation?.watermark).toBe(3);
  expect(store.openConversation?.conversation).toMatchObject({ title: "Renamed", memberCount: 3, permission: "read" });
  store.dispose();
});

for (const mode of ["oversized", "restored"] as const)
  test(`${mode} catch-up replaces with the latest page`, async () => {
    let latest = 0,
      deltas = 0;
    const { store, connection } = fixture({
      changes: async (_id, after) => {
        deltas++;
        if (mode === "restored") return "RESYNC_REQUIRED";
        return {
          rev: after + 200,
          more: true,
          conversation: null,
          messages: Array.from({ length: 200 }, (_, i) => ({ ...message(after + i + 1), systemText: null })),
        };
      },
      messages: async () => {
        latest++;
        return page(1_500);
      },
      conversation: async () => ({ ...conversation, rev: 1_500, title: "Current" }),
    });
    await connection.get("conversation").resync();
    expect(latest).toBe(1);
    expect(store.openConversation?.membershipRev).toBe(1);
    expect(deltas).toBe(mode === "oversized" ? 6 : 1);
    expect(store.openConversation?.messages).toEqual([message(1_500)]);
    expect(store.openConversation?.watermark).toBe(1_500);
    expect(store.openConversation?.conversation?.title).toBe("Current");
    store.dispose();
  });

for (const path of ["conversation", "changes", "messages", "revoked"] as const)
  test(`${path} loss clears messages and closes the chat subscription`, async () => {
    const { store, connection } = fixture({
      conversation: async () => null,
      changes: async () => (path === "messages" ? "RESYNC_REQUIRED" : null),
      messages: async () => null,
    });
    if (path === "conversation") {
      const m = { ...message(2), kind: "system", body: null, system: { code: "details_changed", params: { name: "New" } } };
      await connection.get("conversation").apply({ type: "message", message: m });
    } else if (path === "revoked") connection.get("conversation").revoked();
    else await connection.get("conversation").resync();
    expect(store.openConversation?.status).toBe("no-access");
    expect(store.openConversation?.messages).toEqual([]);
    expect(connection.get("conversation").closed).toBe(true);
    store.dispose();
  });

test("an in-flight metadata fetch cannot repopulate a revoked or switched chat", async () => {
  let resolve = (_row: typeof conversation | null) => {};
  const pending = new Promise<typeof conversation | null>((done) => {
    resolve = done;
  });
  const { store, connection } = fixture({ conversation: async () => pending });
  const m = { ...message(2), kind: "system", body: null, system: { code: "details_changed", params: { name: "Old response" } } };
  const applying = connection.get("conversation").apply({ type: "message", message: m });
  connection.get("conversation").revoked();
  resolve({ ...conversation, rev: 2 });
  await applying;
  expect(store.openConversation?.status).toBe("no-access");
  expect(store.openConversation?.messages).toEqual([]);
  store.open({
    threads: noThreads,
    view: "all",
    cursor: "next",
    conversation: { ...conversation, id: "ghijkl", title: "Other" },
    page: { items: [], rev: 0, seqHead: 0, from: 1, to: 0 },
  });
  expect(store.openConversation?.id).toBe("ghijkl");
  expect(store.openConversation?.messages).toEqual([]);
  store.closeConversation();
  expect(store.openConversation).toBeNull();
  store.dispose();
});

test("sidebar text summaries sort rows, guard revisions, and fetch missing and system rows", async () => {
  const fetched: string[] = [];
  const { store, connection } = fixture({
    conversation: async (id) => {
      fetched.push(id);
      return id === "ghijkl"
        ? { ...conversation, id, rev: 5, lastActivityAt: message(5).createdAt }
        : { ...conversation, rev: 6, title: "Changed", memberCount: 4 };
    },
  });
  const summary = (rev: number) => {
    const data = chatLiveUpdates(conversation.id, message(rev), `Preview ${rev}`, [])[1]!.data;
    if (data.type !== "summary") throw new Error("Expected summary");
    return data;
  };
  await connection.get("list").apply(summary(3));
  await connection.get("list").apply(summary(2));
  expect(store.sidebar[0]).toMatchObject({ rev: 3, lastActivityAt: message(3).createdAt });
  expect(fetched).toEqual([]);
  await connection.get("list").apply({
    ...summary(5),
    conversationId: "ghijkl",
  });
  expect(store.sidebar.map((row) => row.id)).toEqual(["ghijkl", "abcdef"]);
  await connection.get("list").apply({
    ...summary(6),
    kind: "system",
  });
  expect(store.sidebar.find((row) => row.id === "abcdef")).toMatchObject({ title: "Changed", memberCount: 4, rev: 6 });
  expect(fetched).toEqual(["ghijkl", "abcdef"]);
  await connection.get("me").apply({ type: "membership", conversationId: "abcdef" });
  expect(store.sidebar.map((row) => row.id)).toEqual(["abcdef"]);
  store.dispose();
});

test("unavailable exposes stopped live updates and notifies listeners", () => {
  const { store, connection } = fixture();
  let notifications = 0;
  const unsubscribe = store.subscribe(() => notifications++);
  connection.get("conversation").unavailable();
  expect(store.openConversation?.status).toBe("stopped");
  expect(store.liveStatus).toBe("stopped");
  expect(notifications).toBe(1);
  unsubscribe();
  store.dispose();
});

test("default API validates successful responses and distinguishes 404 and restore 409", async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("afterRev=9")) return Response.json({ code: "RESYNC_REQUIRED", message: "restore" }, { status: 409 });
      if (url.includes("absent")) return Response.json({}, { status: 404 });
      if (url.includes("changes")) return Response.json({ rev: 1, more: false, conversation, messages: page(1).items });
      if (url.includes("messages")) return Response.json(page(1));
      if (url.endsWith("abcdef")) return Response.json(conversation);
      return Response.json({ items: [conversation], nextCursor: null });
    },
    { preconnect: original.preconnect },
  );
  try {
    const api = createChatStoreApi();
    expect(await api.conversations()).toEqual({ items: [conversation], nextCursor: null });
    expect(await api.conversation("abcdef")).toEqual(conversation);
    expect(await api.messages("abcdef")).toEqual(page(1));
    expect(await api.changes("abcdef", 1)).toMatchObject({ rev: 1, more: false });
    expect(await api.changes("abcdef", 9)).toBe("RESYNC_REQUIRED");
    expect(await api.conversation("absent")).toBeNull();
    expect(await api.messages("absent")).toBeNull();
    expect(await api.changes("absent", 0)).toBeNull();
    expect(urls.every((url) => url.startsWith("/api/chat/conversations"))).toBe(true);
  } finally {
    globalThis.fetch = original;
  }
});

test("a system event already in the SSR page still refreshes older SSR metadata", async () => {
  const connection = new ManualConnection();
  const system = MessageSchema.parse({
    ...message(2),
    kind: "system",
    body: null,
    system: { code: "details_changed", params: { name: "Renamed" } },
  });
  const api: ChatStoreApi = {
    ...memberApi,
    read: async () => ({
      threads: [],
      conversationId: conversation.id,
      lastReadSeq: 1,
      unreadFromSeq: null,
      joinedSeq: 0,
      unread: 0,
      asOfRev: 1,
    }),
    markUnread: async () => ({
      threads: [],
      conversationId: conversation.id,
      lastReadSeq: 1,
      unreadFromSeq: 1,
      joinedSeq: 0,
      unread: 0,
      asOfRev: 1,
    }),
    readAll: async () => ({ outcome: "done", marked: 0, more: false }),
    snapshot: async () => ({ threads: noThreads, cursor: "snapshot", conversation, page: page(1), focus: null }),
    conversations: async () => ({ items: [conversation], nextCursor: null }),
    conversation: async () => ({ ...conversation, rev: 2, name: "Renamed", title: "Renamed" }),
    messages: async () => ({ ...page(2), items: [{ ...system, systemText: null }] }),
    changes: async () => ({ rev: 2, more: false, conversation: null, messages: [] }),
  };
  const store = createChatStore(
    {
      viewerId: "22222222-2222-4222-8222-222222222222",
      cursor: "before",
      sidebar: { items: [conversation], nextCursor: null },
      open: { threads: noThreads, view: "all", conversation, page: { ...page(2), items: [{ ...system, systemText: null }] } },
    },
    { api, connection },
  );
  await connection.get("conversation").apply({ type: "message", message: system });
  expect(store.openConversation?.conversation?.title).toBe("Renamed");
  expect(store.openConversation?.messages).toEqual([system]);
  store.dispose();
});

const storeAt = (rev: number, api: Partial<ChatStoreApi>, sidebar = { items: [conversation], nextCursor: null as string | null }) => {
  const connection = new ManualConnection();
  const store = createChatStore(
    {
      viewerId: "22222222-2222-4222-8222-222222222222",
      cursor: "before",
      sidebar,
      open: { threads: noThreads, view: "all", conversation: { ...conversation, rev }, page: page(rev) },
    },
    {
      api: {
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
        snapshot: async () => ({ threads: noThreads, cursor: "snapshot", conversation, page: page(1), focus: null }),
        conversations: async () => sidebar,
        conversation: async () => conversation,
        messages: async () => page(rev),
        changes: async () => ({ rev, more: false, conversation: null, messages: [] }),
        ...api,
      },
      connection,
    },
  );
  return { store, connection };
};

test("resync starts at the metadata revision when SSR read the details before the messages", async () => {
  const afters: number[] = [];
  const { store, connection } = storeAt(1, {
    changes: async (_id, after) => {
      afters.push(after);
      return { rev: 2, more: false, conversation: { ...conversation, rev: 2, title: "Renamed" }, messages: [] };
    },
  });
  store.open({ threads: noThreads, view: "all", cursor: "before", conversation: { ...conversation, rev: 1 }, page: page(2) });
  await connection.get("conversation").resync();
  expect(afters).toEqual([1]);
  expect(store.openConversation?.conversation?.title).toBe("Renamed");
  expect(store.openConversation?.watermark).toBe(2);
  store.dispose();
});

test("a restore to an older revision replaces messages and details", async () => {
  const { store, connection } = storeAt(100, {
    changes: async () => "RESYNC_REQUIRED",
    messages: async () => page(5),
    conversation: async () => ({ ...conversation, rev: 5, title: "Restored" }),
  });
  await connection.get("conversation").resync();
  expect(store.openConversation?.watermark).toBe(5);
  expect(store.openConversation?.messages).toEqual([message(5)]);
  expect(store.openConversation?.conversation?.title).toBe("Restored");
  store.dispose();
});

test("a terminal delta below the watermark is a restore", async () => {
  let latest = 0;
  const { store, connection } = storeAt(1, {
    changes: async () => ({ rev: 5, more: false, conversation: null, messages: [] }),
    messages: async () => {
      latest++;
      return page(5);
    },
    conversation: async () => ({ ...conversation, rev: 5 }),
  });
  store.open({ threads: noThreads, view: "all", cursor: "before", conversation, page: page(10) });
  await connection.get("conversation").resync();
  expect(latest).toBe(1);
  expect(store.openConversation?.watermark).toBe(5);
  expect(store.openConversation?.messages).toEqual([message(5)]);
  store.dispose();
});

test("a late event the snapshot already covers does not add history before the loaded page", async () => {
  const { store, connection } = storeAt(100, {});
  await connection.get("conversation").apply({ type: "message", message: message(1) });
  expect(store.openConversation?.messages).toEqual([message(100)]);
  await connection.get("conversation").apply({ type: "message", message: message(101) });
  expect(store.openConversation?.messages).toEqual([message(100), message(101)]);
  store.dispose();
});

test("a known sidebar row stays in an incomplete prefix when its activity still sorts last", async () => {
  const first = { ...conversation, id: "bbbbbb", lastActivityAt: message(30).createdAt };
  const second = { ...conversation, id: "aaaaaa", lastActivityAt: message(10).createdAt };
  const { store, connection } = storeAt(1, {}, { items: [first, second], nextCursor: "more" });
  const summary = chatLiveUpdates(second.id, { ...message(20), conversationId: second.id }, null, [])[1]!.data;
  await connection.get("list").apply(summary);
  expect(store.sidebar.map((row) => row.id)).toEqual([first.id, second.id]);
  expect(store.sidebar[1]).toMatchObject({ rev: 20, lastActivityAt: message(20).createdAt });
  store.dispose();
});

test("the sidebar keeps server order and only rows inside its loaded prefix", async () => {
  const at = (ms: number) => new Date(Date.UTC(2026, 9, 12) + ms).toISOString();
  // Same millisecond: the server ordered these by microseconds, which the browser cannot see.
  const first = { ...conversation, id: "aaaaaa", lastActivityAt: at(10) };
  const second = { ...conversation, id: "zzzzzz", lastActivityAt: at(10) };
  const older = { ...conversation, id: "mmmmmm", rev: 7, lastActivityAt: at(1) };
  const newer = { ...conversation, id: "nnnnnn", rev: 8, lastActivityAt: at(20) };
  const { store, connection } = storeAt(
    1,
    { conversation: async (id) => (id === older.id ? older : newer) },
    { items: [first, second], nextCursor: "more" },
  );
  expect(store.sidebar.map((row) => row.id)).toEqual(["aaaaaa", "zzzzzz"]);
  const summary = (row: typeof older, kind: "text" | "system") => {
    const data = chatLiveUpdates(row.id, { ...message(row.rev), conversationId: row.id, kind }, null, [])[1]!.data;
    if (data.type !== "summary") throw new Error("Expected summary");
    return { ...data, createdAt: row.lastActivityAt };
  };
  await connection.get("list").apply(summary(older, "system"));
  expect(store.sidebar.map((row) => row.id)).toEqual(["aaaaaa", "zzzzzz"]);
  await connection.get("list").apply(summary(newer, "text"));
  expect(store.sidebar.map((row) => row.id)).toEqual(["nnnnnn", "aaaaaa", "zzzzzz"]);
  store.dispose();
});

const windowPage = (from: number, to: number, head = to, rev = head) => ({
  items: Array.from({ length: to - from + 1 }, (_, i) => ({ ...message(from + i), systemText: null })),
  seqHead: head,
  from,
  to,
  rev,
});
const deferred = <T>() => {
  let resolve = (_value: T) => {};
  let reject = (_error: Error) => {};
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

test("a middle window holds distant live messages until newer pages close the gap", async () => {
  const queries: unknown[] = [];
  const { store, connection } = fixture({
    messages: async (_id, query) => {
      queries.push(query);
      return windowPage(6, 9, 10);
    },
  });
  store.open({ threads: noThreads, view: "all", cursor: "middle", conversation, page: windowPage(3, 5, 9) });
  expect(store.openConversation).toMatchObject({ seqHead: 9, hasOlder: true, hasNewer: true, watermark: 9 });
  await connection.get("conversation").apply({ type: "message", message: message(10) });
  expect(store.openConversation?.messages.map((m) => m.seq)).toEqual([3, 4, 5]);
  expect(store.openConversation?.seqHead).toBe(10);
  expect(await store.loadNewer()).toBe(true);
  expect(queries).toEqual([{ after: 5, thread: "all" }]);
  expect(store.openConversation?.messages.map((m) => m.seq)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  expect(store.openConversation?.hasNewer).toBe(false);
  expect(await store.loadNewer()).toBe(false);
  expect(queries).toHaveLength(1);
  store.dispose();
});

test("older paging prepends fresh history without moving the live watermark", async () => {
  const queries: unknown[] = [];
  const { store, connection } = fixture({
    messages: async (_id, query) => {
      queries.push(query);
      return windowPage(1, 2, 10, 20);
    },
  });
  store.open({ threads: noThreads, view: "all", cursor: "middle", conversation, page: windowPage(3, 5, 10) });
  await connection.get("conversation").apply({ type: "message", message: { ...message(1), rev: 15, body: "Outside the window" } });
  expect(store.openConversation?.messages.map((m) => m.seq)).toEqual([3, 4, 5]);
  expect(await store.loadOlder()).toBe(true);
  expect(queries).toEqual([{ before: 3, thread: "all" }]);
  expect(store.openConversation?.messages).toEqual([1, 2, 3, 4, 5].map(message));
  expect(store.openConversation).toMatchObject({ watermark: 15, hasOlder: false, hasNewer: true });
  expect(await store.loadOlder()).toBe(false);
  store.dispose();
});

test("loadLatest replaces a middle window and its watermark", async () => {
  const { store } = fixture({ messages: async () => windowPage(8, 10, 10, 20) });
  store.open({ threads: noThreads, view: "all", cursor: "middle", conversation, page: windowPage(3, 5, 10) });
  await store.loadLatest();
  expect(store.openConversation?.messages).toEqual([8, 9, 10].map(message));
  expect(store.openConversation).toMatchObject({ watermark: 20, seqHead: 10, hasNewer: false, hasOlder: true });
  store.dispose();
});

for (const direction of ["older", "newer"] as const)
  test(`${direction} paging shares an in-flight request and ignores a switched chat`, async () => {
    const pending = deferred<ReturnType<typeof windowPage> | null>();
    let calls = 0;
    const { store } = fixture({
      messages: async () => {
        calls++;
        return pending.promise;
      },
    });
    store.open({ threads: noThreads, view: "all", cursor: "middle", conversation, page: windowPage(3, 5, 10) });
    const loading = direction === "older" ? store.loadOlder() : store.loadNewer();
    const repeated = direction === "older" ? store.loadOlder() : store.loadNewer();
    expect(calls).toBe(1);
    store.open({
      threads: noThreads,
      view: "all",
      cursor: "other",
      conversation: { ...conversation, id: "ghijkl" },
      page: { items: [], rev: 0, seqHead: 0, from: 1, to: 0 },
    });
    pending.resolve(windowPage(1, 10));
    expect(await loading).toBe(false);
    expect(await repeated).toBe(false);
    expect(store.openConversation?.id).toBe("ghijkl");
    expect(store.openConversation?.messages).toEqual([]);
    store.dispose();
  });

for (const direction of ["older", "newer"] as const)
  test(`${direction} paging uses the no-access path on 404`, async () => {
    const { store, connection } = fixture({ messages: async () => null });
    store.open({ threads: noThreads, view: "all", cursor: "middle", conversation, page: windowPage(3, 5, 10) });
    expect(await (direction === "older" ? store.loadOlder() : store.loadNewer())).toBe(false);
    expect(store.openConversation).toMatchObject({
      status: "no-access",
      conversation: null,
      messages: [],
      hasOlder: false,
      hasNewer: false,
    });
    expect(connection.get("conversation").closed).toBe(true);
    store.dispose();
  });

test("openChat uses the winning snapshot and its focus when requests finish out of order", async () => {
  type Snapshot = NonNullable<Awaited<ReturnType<ChatStoreApi["snapshot"]>>>;
  const first = deferred<Snapshot | null>(),
    second = deferred<Snapshot | null>();
  const calls: unknown[] = [];
  const { store, connection } = fixture({
    snapshot: async (id, focus) => {
      calls.push([id, focus]);
      return id === "abcdef" ? first.promise : second.promise;
    },
  });
  const a = store.openChat("abcdef"),
    b = store.openChat("ghijkl", message(5).id);
  second.resolve({
    threads: noThreads,
    cursor: "second",
    conversation: { ...conversation, id: "ghijkl" },
    page: { items: [], seqHead: 0, rev: 0, from: 1, to: 0 },
    focus: message(5).id,
  });
  expect(await b).toEqual({ status: "opened", focus: message(5).id });
  expect(connection.get("conversation").cursor).toBe("second");
  first.resolve({ threads: noThreads, cursor: "first", conversation, page: page(1), focus: null });
  expect(await a).toEqual({ status: "superseded" });
  expect(store.openConversation?.id).toBe("ghijkl");
  expect(calls).toEqual([
    ["abcdef", undefined],
    ["ghijkl", message(5).id],
  ]);
  store.dispose();
});

for (const action of ["open", "close", "dispose"] as const)
  test(`${action} supersedes an in-flight openChat`, async () => {
    const pending = deferred<Awaited<ReturnType<ChatStoreApi["snapshot"]>>>();
    const { store } = fixture({ snapshot: async () => pending.promise });
    const opening = store.openChat("ghijkl");
    if (action === "open") store.open({ threads: noThreads, view: "all", cursor: "direct", conversation, page: page(1) });
    else if (action === "close") store.closeConversation();
    else store.dispose();
    pending.resolve(null);
    expect(await opening).toEqual({ status: "superseded" });
    expect(store.openConversation?.status).not.toBe("no-access");
    store.dispose();
  });

test("openChat 404 replaces the current chat without leaking its details", async () => {
  const { store, connection } = fixture({ snapshot: async () => null });
  let notified = 0;
  store.subscribe(() => notified++);
  expect(await store.openChat("ghijkl")).toEqual({ status: "no-access" });
  expect(store.openConversation).toEqual({
    id: "ghijkl",
    view: "all",
    threads: null,
    threadsStatus: "ready",
    membershipRev: 0,
    status: "no-access",
    conversation: null,
    messages: [],
    watermark: 0,
    seqHead: 0,
    hasOlder: false,
    hasNewer: false,
  });
  expect(connection.get("conversation").closed).toBe(true);
  expect(notified).toBe(1);
  store.dispose();
});

test("openChat network failure leaves the current view untouched", async () => {
  const { store } = fixture({
    snapshot: async () => {
      throw new Error("offline");
    },
  });
  const before = store.openConversation;
  await expect(store.openChat("ghijkl")).rejects.toThrow("offline");
  expect(store.openConversation).toBe(before);
  store.dispose();
});

test("text summaries project lastMessage, including an absent preview", async () => {
  const { store, connection } = fixture();
  for (const preview of ["A preview", null]) {
    const m = message(preview === null ? 3 : 2);
    const summary = chatLiveUpdates(conversation.id, m, preview, [])[1]!.data;
    await connection.get("list").apply(summary);
    expect(store.sidebar[0]?.lastMessage).toEqual({
      thread: null,
      id: m.id,
      author: m.author,
      preview: preview ?? "",
      createdAt: m.createdAt,
    });
  }
  store.dispose();
});

test("sidebar paging appends server rows without duplicates and shares the request", async () => {
  const pending = deferred<{ items: (typeof conversation)[]; nextCursor: string | null }>();
  const cursors: (string | undefined)[] = [];
  const first = { ...conversation, id: "bbbbbb" },
    second = { ...conversation, id: "aaaaaa" };
  const { store } = storeAt(
    1,
    {
      conversations: async (cursor) => {
        cursors.push(cursor);
        return pending.promise;
      },
    },
    { items: [first], nextCursor: "more" },
  );
  expect(store.hasMoreSidebar).toBe(true);
  const a = store.loadMoreSidebar(),
    b = store.loadMoreSidebar();
  await Promise.resolve();
  pending.resolve({ items: [first, second, second], nextCursor: null });
  await Promise.all([a, b]);
  expect(cursors).toEqual(["more"]);
  expect(store.sidebar.map((row) => row.id)).toEqual([first.id, second.id]);
  expect(store.hasMoreSidebar).toBe(false);
  await store.loadMoreSidebar();
  expect(cursors).toEqual(["more"]);
  store.dispose();
});

test("an empty window has no paging; its first live message establishes a range", async () => {
  let calls = 0;
  const { store, connection } = fixture({
    messages: async () => {
      calls++;
      return page(1);
    },
  });
  store.open({ threads: noThreads, view: "all", cursor: "empty", conversation, page: { items: [], seqHead: 0, rev: 0, from: 1, to: 0 } });
  expect(store.openConversation).toMatchObject({ messages: [], seqHead: 0, hasOlder: false, hasNewer: false });
  expect(await store.loadOlder()).toBe(false);
  expect(await store.loadNewer()).toBe(false);
  await store.loadLatest();
  expect(calls).toBe(0);
  await connection.get("conversation").apply({ type: "message", message: message(1) });
  expect(store.openConversation).toMatchObject({ messages: [message(1)], seqHead: 1, hasOlder: false, hasNewer: false });
  store.dispose();
});

test("paging cannot merge an old window after loadLatest replaced it", async () => {
  const older = deferred<ReturnType<typeof windowPage>>();
  const { store } = fixture({ messages: async (_id, query) => (query?.before ? older.promise : windowPage(8, 10)) });
  store.open({ threads: noThreads, view: "all", cursor: "middle", conversation, page: windowPage(3, 5, 10) });
  const loading = store.loadOlder();
  await store.loadLatest();
  older.resolve(windowPage(1, 2));
  expect(await loading).toBe(false);
  expect(store.openConversation?.messages).toEqual([8, 9, 10].map(message));
  store.dispose();
});

test("the typed API transports sidebar and message cursors and parses focused snapshots", async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  const snapshot = { threads: noThreads, cursor: "own-cursor", conversation, page: page(1), focus: message(1).id };
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("absent")) return Response.json({}, { status: 404 });
      if (url.includes("snapshot")) return Response.json(snapshot);
      if (url.includes("messages")) return Response.json(page(1));
      return Response.json({ items: [conversation], nextCursor: null });
    },
    { preconnect: original.preconnect },
  );
  try {
    const api = createChatStoreApi();
    const cursor = JSON.stringify({ at: conversation.lastActivityAt, id: conversation.id });
    await api.conversations(cursor);
    expect(new URL(urls[0]!, "https://example.test").searchParams.get("cursor")).toBe(cursor);
    await api.messages(conversation.id, { before: 10 });
    expect(urls[1]).toBe("/api/chat/conversations/abcdef/messages?before=10");
    await api.messages(conversation.id, { after: 10 });
    expect(urls[2]).toBe("/api/chat/conversations/abcdef/messages?after=10");
    expect(await api.snapshot(conversation.id, message(1).id)).toEqual(snapshot);
    expect(urls[3]).toBe(`/api/chat/conversations/abcdef/snapshot?message=${message(1).id}`);
    expect(await api.snapshot("absent")).toBeNull();
  } finally {
    globalThis.fetch = original;
  }
});

test("loadLatest retains live arrivals newer than its in-flight page", async () => {
  const latest = deferred<ReturnType<typeof windowPage>>();
  const { store, connection } = fixture({ messages: async () => latest.promise });
  store.open({ threads: noThreads, view: "all", cursor: "middle", conversation, page: windowPage(3, 5, 10) });
  const loading = store.loadLatest();
  await connection.get("conversation").apply({ type: "message", message: message(11) });
  latest.resolve(windowPage(8, 10));
  await loading;
  expect(store.openConversation?.messages).toEqual([8, 9, 10, 11].map(message));
  expect(store.openConversation).toMatchObject({ seqHead: 11, watermark: 11, hasNewer: false });
  store.dispose();
});

test("loadLatest retains newer metadata applied while its conversation read is in flight", async () => {
  const latest = deferred<typeof conversation>();
  const reading = deferred<void>();
  let reads = 0;
  const { store, connection } = fixture({
    messages: async () => page(2),
    conversation: async () => {
      if (++reads === 1) {
        reading.resolve();
        return latest.promise;
      }
      return { ...conversation, rev: 3, name: "Renamed", title: "Renamed" };
    },
  });
  store.open({ threads: noThreads, view: "all", cursor: "middle", conversation, page: windowPage(1, 1, 2) });
  const loading = store.loadLatest();
  await reading.promise;
  await connection.get("conversation").apply({
    type: "message",
    message: { ...message(3), kind: "system", body: null, system: { code: "details_changed", params: { name: "Renamed" } } },
  });
  expect(store.openConversation?.conversation?.title).toBe("Renamed");
  latest.resolve({ ...conversation, rev: 2 });
  await loading;
  expect(store.openConversation?.conversation).toMatchObject({ rev: 3, title: "Renamed" });
  expect(store.openConversation?.messages.map((row) => row.seq)).toEqual([2, 3]);
  store.dispose();
});

test("summary unread counts exclude own, system, no-row and messages at or before start, and cap at 100", async () => {
  const viewerId = "22222222-2222-4222-8222-222222222222";
  for (const scenario of ["other", "own", "system", "no-row", "before-start", "cap"] as const) {
    const initial = {
      ...conversation,
      unread: scenario === "cap" ? 100 : 0,
      read: scenario === "no-row" ? null : { lastReadSeq: scenario === "before-start" ? 10 : 1, unreadFromSeq: null, joinedSeq: 0 },
    };
    const { store, connection } = storeAt(
      1,
      { conversation: async () => ({ ...initial, rev: 2 }) },
      { items: [initial], nextCursor: null },
    );
    const sent = {
      ...message(2),
      ...(scenario === "own" ? { author: { type: "user" as const, id: viewerId, name: "Me" } } : {}),
      ...(scenario === "system"
        ? { kind: "system" as const, body: null, system: { code: "conversation_created" as const, params: {} } }
        : {}),
    };
    const summary = chatLiveUpdates(initial.id, sent, "text", []).find((row) => row.data.type === "summary")!.data;
    await connection.get("list").apply(summary);
    expect(store.sidebar[0]?.unread).toBe(scenario === "cap" ? 100 : scenario === "other" ? 1 : 0);
    store.dispose();
  }
});

test("read updates apply personally and stale counts refetch just that row", async () => {
  let calls = 0;
  const { store, connection } = fixture({
    conversation: async () => {
      calls++;
      return { ...conversation, rev: 4, unread: 1, read: { lastReadSeq: 3, unreadFromSeq: null, joinedSeq: 0 } };
    },
  });
  const read = {
    type: "read",
    threads: [],
    conversationId: conversation.id,
    lastReadSeq: 2,
    unreadFromSeq: null,
    joinedSeq: 0,
    unread: 0,
    asOfRev: 2,
  };
  await connection.get("me").apply(read);
  expect(store.sidebar[0]?.read?.lastReadSeq).toBe(2);
  expect(store.openConversation?.conversation?.read?.lastReadSeq).toBe(2);
  await connection.get("list").apply(chatLiveUpdates(conversation.id, message(4), "text", [])[1]!.data);
  await connection.get("me").apply(read);
  expect(calls).toBe(1);
  expect(store.sidebar[0]).toMatchObject({ unread: 1, read: { lastReadSeq: 3 } });
  store.dispose();
});

test("unknown personal rows are ignored and a stale read refetch can remove access", async () => {
  let calls = 0;
  const { store, connection } = fixture({
    conversation: async () => {
      calls++;
      return null;
    },
  });
  const read = {
    type: "read",
    threads: [],
    conversationId: "zzzzzz",
    lastReadSeq: 1,
    unreadFromSeq: null,
    joinedSeq: 0,
    unread: 0,
    asOfRev: 0,
  };
  await connection.get("me").apply(read);
  expect(calls).toBe(0);
  await connection.get("me").apply({ ...read, conversationId: conversation.id });
  expect(calls).toBe(1);
  expect(store.sidebar).toEqual([]);
  store.dispose();
});

test("personal reads update an open chat outside the sidebar and stale reads refetch it", async () => {
  let calls = 0;
  const { store, connection } = storeAt(
    3,
    {
      conversation: async () => {
        calls++;
        return { ...conversation, rev: 5, unread: 1, read: { lastReadSeq: 4, unreadFromSeq: null, joinedSeq: 0 } };
      },
    },
    { items: [], nextCursor: "more" },
  );
  const read = {
    type: "read",
    threads: [],
    conversationId: conversation.id,
    lastReadSeq: 3,
    unreadFromSeq: null,
    joinedSeq: 0,
    unread: 0,
    asOfRev: 3,
  };
  await connection.get("me").apply(read);
  expect(store.sidebar).toEqual([]);
  expect(store.openConversation?.conversation).toMatchObject({ unread: 0, read: { lastReadSeq: 3 } });
  expect(calls).toBe(0);
  await connection.get("me").apply({ ...read, lastReadSeq: 4, asOfRev: 4 });
  await connection.get("me").apply(read);
  expect(calls).toBe(1);
  expect(store.openConversation?.conversation).toMatchObject({ unread: 1, read: { lastReadSeq: 4 } });
  store.dispose();
});

for (const channel of ["me", "list"])
  test(`${channel} resync refreshes the open chat read state outside the sidebar`, async () => {
    let calls = 0;
    const { store, connection } = storeAt(
      3,
      {
        conversation: async () => {
          calls++;
          return { ...conversation, rev: 3, unread: 0, read: { lastReadSeq: 3, unreadFromSeq: null, joinedSeq: 0 } };
        },
      },
      { items: [], nextCursor: "more" },
    );
    await connection.get(channel).resync();
    expect(calls).toBe(1);
    expect(store.sidebar).toEqual([]);
    expect(store.openConversation?.conversation?.read?.lastReadSeq).toBe(3);
    await connection.get("me").apply({
      type: "read",
      threads: [],
      conversationId: conversation.id,
      lastReadSeq: 2,
      unreadFromSeq: null,
      joinedSeq: 0,
      unread: 1,
      asOfRev: 2,
    });
    expect(calls).toBe(2);
    expect(store.openConversation?.conversation?.read?.lastReadSeq).toBe(3);
    store.dispose();
  });

test("read actions return HTTP results without applying them ahead of the personal channel", async () => {
  const { store } = fixture();
  const before = store.sidebar[0];
  expect(await store.markRead(conversation.id, 1)).toMatchObject({ lastReadSeq: 1 });
  expect(await store.markUnread(conversation.id)).toMatchObject({ unreadFromSeq: 1 });
  expect(await store.readAll(true)).toEqual({ outcome: "done", marked: 0, more: false });
  expect(store.sidebar[0]).toBe(before);
  store.dispose();
});

test("readStart is shared by the store and UI, including absent rows and a personal unread mark", () => {
  expect(readStart(null)).toBeNull();
  expect(readStart({ joinedSeq: 10, lastReadSeq: null, unreadFromSeq: null })).toBe(10);
  expect(readStart({ joinedSeq: 10, lastReadSeq: 20, unreadFromSeq: null })).toBe(20);
  expect(readStart({ joinedSeq: 10, lastReadSeq: 20, unreadFromSeq: 5 })).toBe(4);
});

test("member methods forward arguments, and the reader's own changes refresh that chat's row and open view", async () => {
  const calls: unknown[][] = [];
  let reloads = 0,
    details = 0;
  const { store } = fixture({
    create: async (input) => {
      calls.push(["create", input]);
      return { outcome: "created", conversation };
    },
    updateDetails: async (id, patch) => {
      calls.push(["details", id, patch]);
      return conversation;
    },
    members: async (id, query) => {
      calls.push(["members", id, query]);
      return { items: [], nextCursor: null, managers: 1, self };
    },
    previewMembers: async (id, members) => {
      calls.push(["preview", id, members]);
      return { joining: 1, throughGroups: 0, memberCount: 3 };
    },
    addMembers: async (id, members) => {
      calls.push(["add", id, members]);
      return { added: 1 };
    },
    updateMember: async (id, accessId, permission) => {
      calls.push(["update", id, accessId, permission]);
      return { success: true };
    },
    removeMember: async (id, accessId) => {
      calls.push(["remove", id, accessId]);
      return { success: true, keptThroughGroup: false };
    },
    leave: async (id, successor) => {
      calls.push(["leave", id, successor]);
      return { success: true, keptThroughGroup: false };
    },
    people: async (search, cursor) => {
      calls.push(["people", search, cursor]);
      return { items: [], nextCursor: null };
    },
    conversations: async () => {
      reloads++;
      return { items: [{ ...conversation, title: "Refreshed" }], nextCursor: null };
    },
    conversation: async () => {
      details++;
      return { ...conversation, title: "Refreshed", rev: 2 };
    },
  });
  const members = [{ type: "user" as const, userId: "11111111-1111-4111-8111-111111111111" }];
  const input = { members, name: "New", allowDuplicate: true };
  const patch = { name: null, icon: "ti ti-home", purpose: "Welcome" };
  const query = { q: "person", cursor: "cursor" };
  expect(await store.create(input)).toEqual({ outcome: "created", conversation });
  expect(store.sidebar[0]?.title).toBe("Refreshed");
  expect(await store.updateDetails(conversation.id, patch)).toEqual(conversation);
  expect(await store.members(conversation.id, query)).toEqual({ items: [], nextCursor: null, managers: 1, self });
  expect(await store.previewMembers(conversation.id, members)).toEqual({ joining: 1, throughGroups: 0, memberCount: 3 });
  expect(await store.addMembers(conversation.id, members)).toEqual({ added: 1 });
  await store.updateMember(conversation.id, "access", "admin");
  await store.removeMember(conversation.id, "access");
  await store.leave(conversation.id, "successor");
  await store.people("search");
  expect(calls).toEqual([
    ["create", input],
    ["details", conversation.id, patch],
    ["members", conversation.id, query],
    ["preview", conversation.id, members],
    ["add", conversation.id, members],
    ["update", conversation.id, "access", "admin"],
    ["remove", conversation.id, "access"],
    ["leave", conversation.id, "successor"],
    ["people", "search", undefined],
  ]);
  // Each of the reader's own changes reads its chat's row again, not the whole list; a permission change may be the
  // reader's own, so it reads the row too. Leaving reads the membership-filtered list, which decides the sidebar.
  expect(reloads).toBe(1);
  expect(details).toBe(6);
  expect(store.openConversation?.conversation?.title).toBe("Refreshed");
  store.dispose();
});

for (const operation of ["create", "updateDetails", "addMembers", "updateMember", "removeMember", "leave"] as const)
  test(`${operation} awaits the follow-up GET but preserves mutation success when it fails`, async () => {
    const original = globalThis.fetch;
    const refresh = deferred<Response>();
    const started = deferred<boolean>();
    const calls: string[] = [];
    const result =
      operation === "create"
        ? { outcome: "created" as const, conversation }
        : operation === "updateDetails"
          ? conversation
          : operation === "addMembers"
            ? { added: 1 }
            : operation === "updateMember"
              ? { success: true as const }
              : { success: true as const, keptThroughGroup: true };
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        const method = init?.method ?? "GET";
        calls.push(`${method} ${url.pathname}`);
        if (method === "GET") {
          started.resolve(true);
          return refresh.promise;
        }
        return Response.json(result, { status: operation === "create" ? 201 : 200 });
      },
      { preconnect: original.preconnect },
    );
    const { store } = fixture(createChatStoreApi());
    try {
      let settled = false;
      const mutation =
        operation === "create"
          ? store.create({ members: [] })
          : operation === "updateDetails"
            ? store.updateDetails(conversation.id, { name: "Updated" })
            : operation === "addMembers"
              ? store.addMembers(conversation.id, [])
              : operation === "updateMember"
                ? store.updateMember(conversation.id, "access", "write")
                : operation === "removeMember"
                  ? store.removeMember(conversation.id, "access")
                  : store.leave(conversation.id);
      const pending = mutation.then((value) => {
        settled = true;
        return value;
      });
      await started.promise;
      expect(settled).toBe(false);
      refresh.resolve(Response.json({ message: "Temporary failure" }, { status: 503 }));
      expect(await pending).toEqual(result);
      expect(calls).toEqual([
        operation === "create"
          ? "POST /api/chat/conversations"
          : operation === "updateDetails"
            ? `PATCH /api/chat/conversations/${conversation.id}`
            : operation === "addMembers"
              ? `POST /api/chat/conversations/${conversation.id}/members`
              : operation === "updateMember"
                ? `PATCH /api/chat/conversations/${conversation.id}/members/access`
                : operation === "removeMember"
                  ? `DELETE /api/chat/conversations/${conversation.id}/members/access`
                  : `POST /api/chat/conversations/${conversation.id}/leave`,
        operation === "leave" ? "GET /api/chat/conversations" : `GET /api/chat/conversations/${conversation.id}`,
      ]);
      expect(store.openConversation?.status).toBe("live");
      expect(store.sidebar).toEqual([conversation]);
    } finally {
      refresh.resolve(Response.json({ message: "Temporary failure" }, { status: 503 }));
      store.dispose();
      globalThis.fetch = original;
    }
  });

test("leaving the open chat reaches no-access on the refresh 404, without a live event", async () => {
  let left = false;
  const { store, connection } = fixture({
    leave: async () => {
      left = true;
      return { success: true, keptThroughGroup: false };
    },
    conversations: async () => ({ items: [], nextCursor: null }),
    conversation: async () => (left ? null : conversation),
  });
  await store.leave(conversation.id);
  expect(store.openConversation?.status).toBe("no-access");
  expect(store.openConversation?.conversation).toBeNull();
  expect(store.sidebar).toEqual([]);
  expect(connection.get("conversation").closed).toBe(true);
  store.dispose();
});

test("changing the reader's own permission updates the open chat's effective permission", async () => {
  let demoted = false;
  const { store } = fixture({
    updateMember: async () => {
      demoted = true;
      return { success: true };
    },
    conversation: async () => ({ ...conversation, permission: demoted ? "read" : "admin", rev: demoted ? 2 : 1 }),
  });
  await store.updateMember(conversation.id, "own-access", "read");
  expect(store.openConversation?.conversation?.permission).toBe("read");
  expect(store.sidebar.find((row) => row.id === conversation.id)?.permission).toBe("read");
  store.dispose();
});

test("leaving a chat that stays readable through another grant removes it from the sidebar", async () => {
  let left = false;
  const { store } = fixture({
    leave: async () => {
      left = true;
      return { success: true, keptThroughGroup: false };
    },
    // The list holds only the reader's chats; the detail stays readable, as through a discoverable grant.
    conversations: async () => ({ items: left ? [] : [conversation], nextCursor: null }),
    conversation: async () => conversation,
  });
  expect(store.sidebar.map((row) => row.id)).toEqual([conversation.id]);
  await store.leave(conversation.id);
  expect(store.sidebar).toEqual([]);
  store.dispose();
});

test("failed member calls preserve localized errors and never refresh", async () => {
  const error = new ChatRequestError("Du darfst keine Mitglieder hinzufügen.", "FORBIDDEN", 403);
  const { store } = fixture({
    addMembers: async () => {
      throw error;
    },
    conversation: async () => {
      throw new Error("Must not refresh after failure");
    },
  });
  await expect(store.addMembers(conversation.id, [])).rejects.toBe(error);
  store.dispose();
});

test("typed member requests use their routes, payloads and schemas, including both create statuses", async () => {
  const original = globalThis.fetch;
  const calls: { path: string; method: string; body: unknown; query: string }[] = [];
  let createStatus = 201;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      calls.push({ path: url.pathname, query: url.search, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.pathname === "/api/chat/conversations")
        return Response.json(createStatus === 201 ? { outcome: "created", conversation } : { outcome: "existing", matches: [] }, {
          status: createStatus,
        });
      if (url.pathname.endsWith("/preview")) return Response.json({ joining: 1, throughGroups: 0, memberCount: 3 });
      if (url.pathname.endsWith("/members"))
        return Response.json(method === "GET" ? { items: [], nextCursor: null, managers: 1, self } : { added: 1 });
      if (url.pathname.endsWith("/people")) return Response.json({ items: [], nextCursor: null });
      if (url.pathname.endsWith(conversation.id)) return Response.json(conversation);
      return Response.json({ success: true, keptThroughGroup: true });
    },
    { preconnect: original.preconnect },
  );
  try {
    const api = createChatStoreApi();
    const members = [{ type: "user" as const, userId: "11111111-1111-4111-8111-111111111111" }];
    expect((await api.create({ members, name: "New", allowDuplicate: true })).outcome).toBe("created");
    createStatus = 200;
    expect(await api.create({ members })).toEqual({ outcome: "existing", matches: [] });
    await api.updateDetails(conversation.id, { purpose: null });
    expect(await api.members(conversation.id, { q: "A_%", cursor: "opaque" })).toEqual({
      items: [],
      nextCursor: null,
      managers: 1,
      self,
    });
    await api.previewMembers(conversation.id, members);
    await api.addMembers(conversation.id, members);
    await api.updateMember(conversation.id, "access", "admin");
    expect(await api.removeMember(conversation.id, "access")).toEqual({ success: true, keptThroughGroup: true });
    expect(await api.leave(conversation.id, "successor")).toEqual({ success: true, keptThroughGroup: true });
    await api.people("co member", "opaque");
    expect(calls.map(({ path, method, body }) => ({ path, method, body }))).toEqual([
      { path: "/api/chat/conversations", method: "POST", body: { members, name: "New", allowDuplicate: true } },
      { path: "/api/chat/conversations", method: "POST", body: { members } },
      { path: "/api/chat/conversations/abcdef", method: "PATCH", body: { purpose: null } },
      { path: "/api/chat/conversations/abcdef/members", method: "GET", body: null },
      { path: "/api/chat/conversations/abcdef/members/preview", method: "POST", body: { members } },
      { path: "/api/chat/conversations/abcdef/members", method: "POST", body: { members } },
      { path: "/api/chat/conversations/abcdef/members/access", method: "PATCH", body: { permission: "admin" } },
      { path: "/api/chat/conversations/abcdef/members/access", method: "DELETE", body: null },
      { path: "/api/chat/conversations/abcdef/leave", method: "POST", body: { successor: "successor" } },
      { path: "/api/chat/people", method: "GET", body: null },
    ]);
    expect(new URLSearchParams(calls[3]!.query).get("q")).toBe("A_%");
    expect(new URLSearchParams(calls[3]!.query).get("cursor")).toBe("opaque");
    expect(new URLSearchParams(calls[9]!.query).get("search")).toBe("co member");
    expect(new URLSearchParams(calls[9]!.query).get("cursor")).toBe("opaque");
  } finally {
    globalThis.fetch = original;
  }
});

test("HTTP errors retain server messages, optional rate-limit codes and required-call 404s", async () => {
  const original = globalThis.fetch;
  try {
    for (const [status, body] of [
      [403, { code: "FORBIDDEN", message: "Keine Berechtigung." }],
      [429, { message: "Try again later." }],
      [404, { code: "NOT_FOUND", message: "Chat nicht gefunden." }],
    ] as const) {
      globalThis.fetch = Object.assign(async () => Response.json(body, { status }), { preconnect: original.preconnect });
      const error = await createChatStoreApi()
        .addMembers(conversation.id, [])
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ChatRequestError);
      if (!(error instanceof ChatRequestError)) throw new Error("Expected ChatRequestError");
      expect(error.message).toBe(body.message);
      expect(error.status).toBe(status);
      expect(error.code).toBe("code" in body ? body.code : undefined);
    }
    globalThis.fetch = Object.assign(async () => Response.json({ code: "CONFLICT", message: "Changed." }, { status: 409 }), {
      preconnect: original.preconnect,
    });
    await expect(createChatStoreApi().changes(conversation.id, 0)).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
      message: "Changed.",
    });
    globalThis.fetch = Object.assign(async () => new Response("unavailable", { status: 503 }), { preconnect: original.preconnect });
    await expect(createChatStoreApi().previewMembers(conversation.id, [])).rejects.toBeInstanceOf(ChatRequestError);
  } finally {
    globalThis.fetch = original;
  }
});

test("a thread refresh asked for while the previous one finishes still runs", async () => {
  let calls = 0;
  const { store } = fixture({
    threads: async () => {
      calls += 1;
      return noThreads;
    },
  });
  // A listener reacting to the first list asks again in the step right after it, while that refresh is finishing.
  let asked = false;
  const unsubscribe = store.subscribe(() => {
    if (asked || calls !== 1) return;
    asked = true;
    queueMicrotask(() => void store.refreshThreads());
  });
  await store.refreshThreads();
  for (let tick = 0; tick < 20 && calls < 2; tick++) await Promise.resolve();
  expect(calls).toBe(2);
  unsubscribe();
  store.dispose();
});

test("read-all forwards continuation even when the preceding page marked no chats", async () => {
  const seen: (string | undefined)[] = [];
  const { store } = fixture({
    readAll: async (_confirmed, cursor) => {
      seen.push(cursor);
      return cursor
        ? { outcome: "done", marked: 1, more: false, nextCursor: null }
        : { outcome: "done", marked: 0, more: true, nextCursor: "hidden-page" };
    },
  });
  const first = await store.readAll(true);
  if (first.outcome !== "done") throw new Error("Expected a completed page");
  expect(await store.readAll(true, first.nextCursor ?? undefined)).toMatchObject({ marked: 1, more: false });
  expect(seen).toEqual([undefined, "hidden-page"]);
  store.dispose();
});

test("system thread refresh follows empty cursor pages, orders activity, and totals only the complete list", async () => {
  const system = {
    ...conversation,
    kind: "system" as const,
    resource: { type: "spaces.space", id: "Space1" },
    threads: 1,
    summaryCursor: "",
  };
  const entry = (id: string, at: string, unread: number) => ({
    id,
    name: id,
    description: null,
    archived: false,
    unread,
    read: null,
    lastMessage: null,
    lastActivityAt: at,
    createdAt: at,
  });
  const requested: (string | undefined)[] = [];
  const { store } = fixture({
    threads: async (_id, query) => {
      requested.push(query?.cursor);
      if (!query?.cursor)
        return { general: { unread: 2, lastMessage: null }, items: [entry("Older1", "2026-10-12T00:00:00.000Z", 3)], nextCursor: "Older1" };
      if (query.cursor === "Older1") return { general: { unread: 2, lastMessage: null }, items: [], nextCursor: "Hidden" };
      return { general: { unread: 2, lastMessage: null }, items: [entry("Newer1", "2026-10-13T00:00:00.000Z", 4)], nextCursor: null };
    },
  });
  try {
    store.open({ cursor: "cursor", conversation: system, threads: noThreads, page: page(1), view: "all" });
    await store.refreshThreads();
    expect(requested).toEqual([undefined, "Older1", "Hidden"]);
    expect(store.openConversation?.threads?.items.map((item) => item.id)).toEqual(["Newer1", "Older1"]);
    expect(store.openConversation?.conversation).toMatchObject({ threads: 2, unread: 9, summaryCursor: null });
  } finally {
    store.dispose();
  }
});

test("a failed continuation keeps the selected resource and is retryable; closing cancels a running refresh", async () => {
  const system = { ...conversation, kind: "system" as const };
  let fail = true;
  let pending = false;
  let aborted = false;
  const { store } = fixture({
    threads: async (_id, query, signal) => {
      if (pending)
        return new Promise((resolve) =>
          signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve(null);
            },
            { once: true },
          ),
        );
      if (!query?.cursor) return { ...noThreads, nextCursor: "After1" };
      if (fail) throw new Error("Unavailable");
      return noThreads;
    },
  });
  try {
    store.open({ cursor: "cursor", conversation: system, threads: noThreads, page: page(1), view: "all" });
    await store.refreshThreads();
    expect(store.openConversation?.threadsStatus).toBe("failed");
    expect(store.openConversation?.conversation?.id).toBe(conversation.id);
    fail = false;
    await store.refreshThreads();
    expect(store.openConversation?.threadsStatus).toBe("ready");
    pending = true;
    const request = store.refreshThreads();
    await Promise.resolve();
    store.closeConversation();
    await request;
    expect(aborted).toBe(true);
    expect(store.openConversation).toBeNull();
  } finally {
    store.dispose();
  }
});
