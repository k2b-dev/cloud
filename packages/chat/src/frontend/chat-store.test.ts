import { expect, test } from "bun:test";
import type { LiveConnection, LiveSubscriptionHandlers } from "@k2b/cloud/browser/live";
import { ConversationSchema, MessageSchema, readStart } from "../service/contracts";
import { chatLiveUpdates } from "../service/live-updates";
import { ChatRequestError, type ChatStoreApi, createChatStore, createChatStoreApi } from "./chat-store";

const noThreads = { general: { unread: 0, lastMessage: null }, items: [] };

const conversation = ConversationSchema.parse({
  threads: 0,
  channel: false,
  member: true,
  id: "abcdef",
  name: "Chat",
  title: "Chat",
  icon: null,
  purpose: null,
  memberCount: 2,
  unread: 0,
  read: { lastReadSeq: null, unreadFromSeq: null, joinedSeq: 0 },
  archived: false,
  pinnedRank: null,
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
    reactions: [],
    mentions: [],
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
  applyBatch(data: unknown[], cursors?: string[]): Promise<void>;
  resync(): Promise<void>;
  revoked(): void;
  unavailable(): void;
  caughtUp(value: boolean): void;
  closed: boolean;
  cursor: string | null;
};
class ManualConnection implements LiveConnection {
  channels = new Map<string, Controls>();
  subscribe<T>(channel: string, _scope: unknown, handlers: LiveSubscriptionHandlers<T>) {
    let confirmed = true;
    const run = async (apply: () => Promise<void>) => {
      handlers.caughtUp?.(false);
      await apply();
      if (confirmed) handlers.caughtUp?.(true);
    };
    const controls: Controls = {
      apply: (data) => run(() => handlers.apply([{ data: handlers.parse(data), cursor: "cursor" }])),
      applyBatch: (data, cursors) =>
        run(() => handlers.apply(data.map((event, i) => ({ data: handlers.parse(event), cursor: cursors?.[i] ?? "cursor" })))),
      resync: () => run(handlers.resync),
      revoked: () => handlers.revoked?.("access_denied"),
      unavailable: handlers.unavailable,
      caughtUp: (value) => {
        confirmed = value;
        handlers.caughtUp?.(value);
      },
      closed: false,
      cursor: handlers.cursor,
    };
    this.channels.set(channel, controls);
    controls.caughtUp(true);
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
  react: async () => {},
  reactions: async () => ({ items: [] }),
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
  leave: async () => ({ success: true as const, keptThroughGroup: false, canRejoin: false }),
  people: async () => ({ items: [], nextCursor: null }),
};
const fixture = (overrides: Partial<ChatStoreApi> = {}, options: { unread?: boolean; nextCursor?: string } = {}) => {
  const connection = new ManualConnection();
  const api: ChatStoreApi = {
    ...memberApi,
    personal: async () => {
      throw new Error("Unused personal write");
    },
    preferences: async () => ({ collapsed: [] }),
    savePreferences: async (collapsed) => ({ collapsed }),
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
      ...options,
      viewerId: "22222222-2222-4222-8222-222222222222",
      cursor: "cursor",
      sidebar: { items: [conversation], nextCursor: options.nextCursor ?? null },
      open: { threads: noThreads, view: "all", conversation, page: page(1) },
    },
    { api, connection },
  );
  return { api, connection, store };
};

test("replay publishes one complete feed window when caught up and retains accepted data when unavailable", async () => {
  for (const outcome of ["ready", "unavailable"] as const) {
    const { store, connection } = fixture();
    const live = connection.get("conversation");
    live.caughtUp(false);
    const windows: number[][] = [];
    store.subscribe(() => windows.push(store.openConversation!.messages.map((message) => message.seq)));
    for (const rev of [2, 3]) await live.apply({ type: "message", message: message(rev) });
    expect(store.openConversation?.watermark).toBe(3);
    expect(store.openConversation?.messages.map((message) => message.seq)).toEqual([1]);
    expect(windows).toEqual([]);
    if (outcome === "ready") live.caughtUp(true);
    else live.unavailable();
    expect(windows).toHaveLength(1);
    expect(windows.every((window) => window.join() === "1,2,3")).toBe(true);
    expect(store.openConversation?.caughtUp).toBe(outcome === "ready");
    expect(store.openConversation?.status).toBe(outcome === "ready" ? "live" : "stopped");
    store.dispose();
  }
});

test("personal writes and list refreshes preserve the open conversation's catch-up state", async () => {
  const { store, connection } = fixture({ personal: async () => conversation });
  try {
    for (const caughtUp of [false, true]) {
      connection.get("conversation").caughtUp(caughtUp);
      await store.personal(conversation.id, { pinned: true });
      expect(store.openConversation?.caughtUp).toBe(caughtUp);
      await store.showArchive(false, true);
      expect(store.openConversation?.caughtUp).toBe(caughtUp);
      await connection.get("me").apply({ type: "personal" });
      expect(store.openConversation?.caughtUp).toBe(caughtUp);
    }
  } finally {
    store.dispose();
  }
});

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

test("a system chat resync replaces the history and counts an access reconciliation, also at the same position", async () => {
  const system = { ...conversation, kind: "system" as const, resource: { type: "spaces.space", id: "Space1" } };
  const { store, connection } = fixture({
    snapshot: async () => ({ threads: noThreads, cursor: "snapshot", conversation: system, page: page(1), focus: null }),
    conversation: async () => system,
    messages: async () => page(1),
  });
  await store.openChat(conversation.id);
  const before = store.openConversation!;
  expect(before.accessRev).toBe(0);
  await connection.get("conversation").resync();
  // A revoked item removes its messages without a new position; readers of the history must read again.
  expect(store.openConversation?.seqHead).toBe(before.seqHead);
  expect(store.openConversation?.accessRev).toBe(1);
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

test("a channel subscription by someone else updates the open chat's members and its sidebar row", async () => {
  const { store, connection } = fixture({ conversation: async () => ({ ...conversation, channel: true, rev: 2, memberCount: 3 }) });
  await connection.get("conversation").apply({ type: "membership", conversationId: conversation.id });
  expect(store.openConversation?.membershipRev).toBe(1);
  expect(store.openConversation?.conversation?.memberCount).toBe(3);
  expect(store.openConversation?.messages).toHaveLength(1);
  await connection.get("list").apply({ type: "membership", conversationId: conversation.id });
  expect(store.sidebar.find((row) => row.id === conversation.id)?.memberCount).toBe(3);
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
    personal: async () => {
      throw new Error("Unused personal write");
    },
    preferences: async () => ({ collapsed: [] }),
    savePreferences: async (collapsed) => ({ collapsed }),
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
        personal: async () => {
          throw new Error("Unused personal write");
        },
        preferences: async () => ({ collapsed: [] }),
        savePreferences: async (collapsed) => ({ collapsed }),
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
    threadsRevision: 0,
    membershipRev: 0,
    accessRev: 0,
    status: "no-access",
    caughtUp: false,
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
      return { success: true, keptThroughGroup: false, canRejoin: false };
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
              : operation === "leave"
                ? { success: true as const, keptThroughGroup: true, canRejoin: false }
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
      return { success: true, keptThroughGroup: false, canRejoin: false };
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
      return { success: true, keptThroughGroup: false, canRejoin: false };
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
      return Response.json({ success: true, keptThroughGroup: true, canRejoin: false });
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
    expect(await api.leave(conversation.id, "successor")).toEqual({ success: true, keptThroughGroup: true, canRejoin: false });
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

test("personal archive events refresh membership-filtered rows and never resurrect an archived row on new activity", async () => {
  let archived = false;
  const { store, connection } = fixture({
    personal: async (_id, patch) => {
      archived = patch.archived ?? archived;
      return { ...conversation, archived };
    },
    conversation: async () => ({ ...conversation, archived }),
    conversations: async (_cursor, mode) => ({ items: archived === !!mode ? [{ ...conversation, archived }] : [], nextCursor: null }),
  });
  try {
    await store.personal(conversation.id, { archived: true });
    expect(store.sidebar).toEqual([]);
    expect(store.openConversation?.conversation?.archived).toBe(true);
    await connection.get("list").applyBatch([
      {
        type: "summary",
        thread: null,
        mention: false,
        conversationId: conversation.id,
        id: "0000000002",
        seq: 2,
        rev: 2,
        kind: "text",
        author: message(2).author,
        createdAt: message(2).createdAt,
        preview: "Still archived",
      },
    ]);
    expect(store.sidebar).toEqual([]);
    await store.showArchive(true);
    expect(store.sidebar.map((row) => row.id)).toEqual([conversation.id]);
    archived = false;
    await connection.get("me").applyBatch([{ type: "personal" }]);
    expect(store.sidebar).toEqual([]);
    await store.showArchive(false);
    expect(store.sidebar.map((row) => row.id)).toEqual([conversation.id]);
  } finally {
    store.dispose();
  }
});

test("a failed archive navigation leaves the active list mode intact for later live events", async () => {
  const { store, connection } = fixture({
    conversations: async (_cursor, archived) => {
      if (archived) throw new Error("Unavailable archive");
      return { items: [conversation], nextCursor: null };
    },
  });
  try {
    await expect(store.showArchive(true)).rejects.toThrow("Unavailable archive");
    await connection.get("me").applyBatch([{ type: "personal" }]);
    expect(store.sidebar.map((row) => row.id)).toEqual([conversation.id]);
  } finally {
    store.dispose();
  }
});

test("Unread retains read rows but rechecks their authorization on membership refresh", async () => {
  let accessible = true;
  const { store, connection } = fixture(
    {
      conversations: async (_cursor, _archived, _unread, ids) => ({ items: ids && accessible ? [conversation] : [], nextCursor: null }),
      conversation: async () => (accessible ? conversation : null),
    },
    { unread: true },
  );
  try {
    await connection.get("me").applyBatch([{ type: "personal" }]);
    expect(store.sidebar.map((row) => row.id)).toEqual([conversation.id]);
    accessible = false;
    await connection.get("me").applyBatch([{ type: "membership", conversationId: conversation.id }]);
    expect(store.sidebar).toEqual([]);
  } finally {
    store.dispose();
  }
});

test("preferences events preserve loaded sidebar depth without querying conversations", async () => {
  const next = { ...conversation, id: "ghijkl" };
  let requests = 0;
  const { store, connection } = fixture(
    {
      conversations: async () => {
        requests++;
        return { items: [next], nextCursor: null };
      },
    },
    { nextCursor: "page2" },
  );
  try {
    await store.loadMoreSidebar();
    const before = requests;
    const ids = store.sidebar.map((row) => row.id);
    expect(ids).toEqual([conversation.id, next.id]);
    await connection.get("me").applyBatch([{ type: "preferences", collapsed: ["pinned"] }]);
    expect(store.collapsed).toEqual(["pinned"]);
    expect(store.sidebar.map((row) => row.id)).toEqual(ids);
    expect(requests).toBe(before);
  } finally {
    store.dispose();
  }
});

test("text bursts from another list mode fetch once until membership or resync changes it", async () => {
  let reads = 0;
  let archived = true;
  const hidden = { ...conversation, id: "ghijkl" };
  const { store, connection } = fixture({
    conversation: async (id) => (id === hidden.id ? (reads++, { ...hidden, archived }) : conversation),
  });
  const summary = (rev: number) => chatLiveUpdates(hidden.id, { ...message(rev), conversationId: hidden.id }, null, [])[1]!.data;
  try {
    for (let rev = 2; rev < 22; rev++) await connection.get("list").apply(summary(rev));
    expect(reads).toBe(1);
    expect(store.sidebar.map((row) => row.id)).not.toContain(hidden.id);
    archived = false;
    await connection.get("me").apply({ type: "membership", conversationId: hidden.id });
    await connection.get("list").apply(summary(22));
    expect(reads).toBe(2);
    expect(store.sidebar.map((row) => row.id)).toContain(hidden.id);
    await store.showArchive(true);
    await connection.get("list").apply(summary(23));
    expect(reads).toBe(3);
  } finally {
    store.dispose();
  }
});

test("personal writes expose refresh failures for visible retry and refresh obsolete pin targets", async () => {
  let refreshes = 0;
  const { store } = fixture({
    personal: async () => conversation,
    conversations: async () => {
      refreshes++;
      throw new Error("Refresh unavailable");
    },
  });
  try {
    await expect(store.personal(conversation.id, { archived: true })).rejects.toThrow("Refresh unavailable");
    expect(refreshes).toBe(1);
  } finally {
    store.dispose();
  }
  const invalid = new ChatRequestError("Target removed", "BAD_INPUT", 400);
  const next = fixture({
    personal: async () => {
      throw invalid;
    },
    conversations: async () => {
      refreshes++;
      return { items: [], nextCursor: null };
    },
  });
  try {
    await expect(next.store.personal(conversation.id, { pinned: true, before: "ghijkl" })).rejects.toBe(invalid);
    expect(refreshes).toBe(2);
    expect(next.store.sidebar).toEqual([]);
  } finally {
    next.store.dispose();
  }
});

test("retained read rows keep activity order when a personal action refreshes Unread", async () => {
  const older = { ...conversation, id: "ghijkl", unread: 1, lastActivityAt: "2026-10-11T00:00:00.000Z" };
  const { store } = fixture(
    {
      personal: async () => conversation,
      conversations: async (_cursor, _archived, _unread, ids) => ({ items: ids ? [conversation] : [older], nextCursor: null }),
    },
    { unread: true },
  );
  try {
    await store.personal(conversation.id, { pinned: false });
    expect(store.sidebar.map((row) => row.id)).toEqual([conversation.id, older.id]);
  } finally {
    store.dispose();
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

test("automatic system refresh reads one short page and never exhausts directory cursors", async () => {
  const queries: unknown[] = [];
  const { store } = systemFixture(
    {
      threads: async (_id, query) => {
        queries.push(query);
        return { ...noThreads, nextCursor: "Older1" };
      },
    },
    "Chosen",
  );
  try {
    await store.refreshThreads();
    expect(queries).toEqual([{ short: "true", selected: "Chosen" }]);
    expect(store.openConversation?.threads?.nextCursor).toBe("Older1");
  } finally {
    store.dispose();
  }
});

test("a failed open projection leaves a list-mode switch atomic", async () => {
  const calls: boolean[] = [];
  let fail = true;
  const { store, connection } = fixture({
    conversations: async (_cursor, archived) => {
      calls.push(!!archived);
      return { items: archived ? [] : [conversation], nextCursor: null };
    },
    conversation: async () => {
      if (fail) throw new Error("Projection unavailable");
      return conversation;
    },
  });
  try {
    await expect(store.showArchive(true)).rejects.toThrow("Projection unavailable");
    expect(store.sidebar.map((row) => row.id)).toEqual([conversation.id]);
    fail = false;
    await connection.get("me").apply({ type: "personal" });
    expect(calls).toEqual([true, false]);
  } finally {
    store.dispose();
  }
});

test("a failed pin-target refresh preserves the definitive 400", async () => {
  const invalid = new ChatRequestError("Target removed", "BAD_INPUT", 400);
  const { store } = fixture({
    personal: async () => {
      throw invalid;
    },
    conversations: async () => {
      throw new Error("Refresh unavailable");
    },
  });
  try {
    await expect(store.personal(conversation.id, { pinned: true, before: "ghijkl" })).rejects.toBe(invalid);
  } finally {
    store.dispose();
  }
});

test("a failed short read keeps the selected resource and is retryable; closing cancels a running refresh", async () => {
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

test("retry restores retained read rows from the visible Unread visit after a superseded mode load", async () => {
  let accessible = true;
  const idsRead: string[][] = [];
  const { store } = fixture(
    {
      conversations: async (_cursor, _archived, unread, ids) => {
        if (ids) idsRead.push([...ids]);
        return { items: ids ? (accessible ? [conversation] : []) : unread ? [] : [conversation], nextCursor: null };
      },
    },
    { unread: true },
  );
  try {
    await store.showArchive(false, false);
    await store.showArchive(false, true, [conversation.id]);
    expect(idsRead).toEqual([[conversation.id]]);
    expect(store.sidebar.map((row) => row.id)).toEqual([conversation.id]);
    accessible = false;
    await store.showArchive(false, true, [conversation.id]);
    expect(store.sidebar).toEqual([]);
  } finally {
    store.dispose();
  }
});

test("reactions update optimistically and restore the previous counts on failure", async () => {
  const pending = deferred<void>();
  const { store } = fixture({ react: () => pending.promise });
  const before = store.sidebar;
  const writing = store.react(conversation.id, message(1).id, "👍", true);
  expect(store.openConversation?.messages[0]?.reactions).toEqual([{ emoji: "👍", count: 1, own: true }]);
  pending.reject(new Error("Try again"));
  await expect(writing).rejects.toThrow("Try again");
  expect(store.openConversation?.messages[0]?.reactions).toEqual([]);
  expect(store.sidebar).toBe(before);
  store.dispose();
});

test("reactions add and remove optimistically, preserve other people and serialize rapid toggles", async () => {
  const first = deferred<void>();
  const second = deferred<void>();
  let calls = 0;
  const { store, connection } = fixture({
    react: () => (++calls === 1 ? first.promise : second.promise),
    reactions: async () => ({ items: [{ emoji: "👍", count: 2, own: false, people: ["Ana", "Lea"] }] }),
  });
  await connection.get("conversation").apply({ type: "reactions", conversationId: conversation.id, messageId: message(1).id, rev: 2 });
  const add = store.react(conversation.id, message(1).id, "👍", true);
  expect(store.openConversation?.messages[0]?.reactions).toEqual([{ emoji: "👍", count: 3, own: true }]);
  const remove = store.react(conversation.id, message(1).id, "👍", false);
  expect(store.openConversation?.messages[0]?.reactions).toEqual([{ emoji: "👍", count: 2, own: false }]);
  first.resolve();
  await add;
  expect(store.openConversation?.messages[0]?.reactions).toEqual([{ emoji: "👍", count: 2, own: false }]);
  second.resolve();
  await remove;
  expect(calls).toBe(2);
  expect(store.openConversation?.messages[0]?.reactions).toEqual([{ emoji: "👍", count: 2, own: false }]);
  store.dispose();
});

test("a late write answer never outlives newer reactions from elsewhere", async () => {
  const write = deferred<void>();
  // The server has the latest state: another tab took the reaction back after this tab's write.
  const { store, connection } = fixture({ react: () => write.promise, reactions: async () => ({ items: [] }) });
  const add = store.react(conversation.id, message(1).id, "👍", true);
  await connection.get("conversation").apply({ type: "reactions", conversationId: conversation.id, messageId: message(1).id, rev: 3 });
  write.resolve();
  await add;
  await Bun.sleep(0);
  expect(store.openConversation?.messages[0]?.reactions).toEqual([]);
  store.dispose();
});

test("reaction hint batches coalesce per loaded message and skip old or foreign hints", async () => {
  const calls: string[] = [];
  const { store, connection } = fixture({
    reactions: async (id, message) => {
      calls.push(`${id}:${message}`);
      return { items: [{ emoji: "👍", count: 2, own: false, people: ["Ana", "Lea"] }] };
    },
  });
  const hint = { type: "reactions", conversationId: conversation.id, messageId: message(1).id, rev: 2 };
  await connection
    .get("conversation")
    .applyBatch([
      hint,
      { ...hint, rev: 3 },
      { ...hint, rev: 2 },
      { ...hint, messageId: message(9).id },
      { ...hint, conversationId: "ghijkl" },
    ]);
  expect(calls).toEqual([`${conversation.id}:${message(1).id}`]);
  expect(store.openConversation?.messages[0]).toMatchObject({ rev: 3, reactions: [{ emoji: "👍", count: 2, own: false }] });
  await connection.get("conversation").applyBatch([hint, { ...hint, rev: 1 }, { ...hint, rev: 3 }]);
  expect(calls).toHaveLength(1);
  store.dispose();
});

test("a failed reaction hint read rejects the live batch for retry", async () => {
  const { store, connection } = fixture({
    reactions: async () => {
      throw new Error("Offline");
    },
  });
  await expect(
    connection.get("conversation").apply({ type: "reactions", conversationId: conversation.id, messageId: message(1).id, rev: 2 }),
  ).rejects.toThrow("Offline");
  expect(store.openConversation?.messages[0]?.rev).toBe(1);
  store.dispose();
});

test("reaction HTTP client encodes emoji paths, accepts empty 204s and preserves failures", async () => {
  const original = globalThis.fetch;
  const requests: { url: string; method: string }[] = [];
  try {
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requests.push({ url: String(input), method: init?.method ?? "GET" });
        return init?.method === "GET"
          ? Response.json({ items: [{ emoji: "👍🏽", count: 1, own: true, people: ["Ana"] }] })
          : new Response(null, { status: 204 });
      },
      { preconnect: original.preconnect },
    );
    const api = createChatStoreApi();
    await api.react(conversation.id, message(1).id, "👍🏽", true);
    await api.react(conversation.id, message(1).id, "👍🏽", false);
    expect((await api.reactions(conversation.id, message(1).id)).items[0]?.own).toBeTrue();
    expect(requests.map(({ url, method }) => [new URL(url, "https://cloud.example.test").pathname, method])).toEqual([
      [`/api/chat/conversations/${conversation.id}/messages/${message(1).id}/reactions/${encodeURIComponent("👍🏽")}`, "PUT"],
      [`/api/chat/conversations/${conversation.id}/messages/${message(1).id}/reactions/${encodeURIComponent("👍🏽")}`, "DELETE"],
      [`/api/chat/conversations/${conversation.id}/messages/${message(1).id}/reactions`, "GET"],
    ]);
    globalThis.fetch = Object.assign(
      async () => Response.json({ code: "REACTION_PERSON_LIMIT", message: "Remove a reaction." }, { status: 409 }),
      { preconnect: original.preconnect },
    );
    await expect(api.react(conversation.id, message(1).id, "👍🏽", true)).rejects.toMatchObject({
      status: 409,
      code: "REACTION_PERSON_LIMIT",
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("reaction hint reads cannot overwrite a newly opened chat", async () => {
  const pending = deferred<Awaited<ReturnType<ChatStoreApi["reactions"]>>>();
  const { store, connection } = fixture({ reactions: () => pending.promise });
  const hinted = connection
    .get("conversation")
    .apply({ type: "reactions", conversationId: conversation.id, messageId: message(1).id, rev: 2 });
  await connection.get("conversation").resync();
  store.open({
    threads: noThreads,
    view: "all",
    cursor: "new",
    conversation,
    page: { ...page(1), items: [{ ...message(1), rev: 3, reactions: [{ emoji: "❤️", count: 1, own: false }], systemText: null }] },
  });
  pending.resolve({ items: [{ emoji: "👍", count: 1, own: true, people: ["Ana"] }] });
  await hinted;
  expect(store.openConversation?.messages[0]).toMatchObject({ rev: 3, reactions: [{ emoji: "❤️", count: 1, own: false }] });
  store.dispose();
});

test("failed optimistic reactions keep other people's updates received while the write waits", async () => {
  const pending = deferred<void>();
  const { store, connection } = fixture({
    react: () => pending.promise,
    reactions: async () => ({ items: [{ emoji: "👍", count: 2, own: false, people: ["Ana", "Lea"] }] }),
  });
  const writing = store.react(conversation.id, message(1).id, "👍", true);
  await connection.get("conversation").apply({ type: "reactions", conversationId: conversation.id, messageId: message(1).id, rev: 2 });
  expect(store.openConversation?.messages[0]?.reactions).toEqual([{ emoji: "👍", count: 3, own: true }]);
  pending.reject(new Error("Try again"));
  await expect(writing).rejects.toThrow("Try again");
  expect(store.openConversation?.messages[0]?.reactions).toEqual([{ emoji: "👍", count: 2, own: false }]);
  store.dispose();
});

const systemConversation = { ...conversation, kind: "system" as const, resource: { type: "spaces.space", id: "Space1" }, unread: 5 };
const systemFixture = (overrides: Partial<ChatStoreApi> = {}, view = "all") => {
  const fixtureState = fixture({ conversation: async () => systemConversation, ...overrides });
  fixtureState.store.open({ cursor: "cursor", conversation: systemConversation, threads: noThreads, page: page(1), view });
  return fixtureState;
};

test("system resync replaces loaded messages with the current authorized window", async () => {
  const { store, connection } = systemFixture({ messages: async () => ({ ...page(1), items: [] }) });
  try {
    expect(store.openConversation?.messages).toHaveLength(1);
    await connection.get("conversation").resync();
    expect(store.openConversation?.messages).toHaveLength(0);
  } finally {
    store.dispose();
  }
});

test("a selected item that becomes unavailable clears its messages and thread metadata", async () => {
  const { store, connection } = systemFixture({ messages: async () => null }, "Thread");
  try {
    await connection.get("conversation").resync();
    expect(store.openConversation).toMatchObject({ status: "no-access", messages: [], threads: null });
  } finally {
    store.dispose();
  }
});

test("system read and unread HTTP results update boundaries without a personal event", async () => {
  const { store } = systemFixture({ conversation: async () => ({ ...systemConversation, unread: 0 }) });
  try {
    await store.markRead(conversation.id, 1, "all");
    expect(store.openConversation?.conversation?.read?.lastReadSeq).toBe(1);
    expect(store.sidebar.find((row) => row.id === conversation.id)?.unread).toBe(0);
    await store.markUnread(conversation.id);
    expect(store.openConversation?.conversation?.read?.unreadFromSeq).toBe(1);
  } finally {
    store.dispose();
  }
});

test("system All reads continue empty pages with the same seq and selection", async () => {
  const seen: unknown[] = [];
  const { store } = systemFixture({
    read: async (id, seq, thread, cursor) => {
      seen.push([id, seq, thread, cursor]);
      return {
        conversationId: id,
        lastReadSeq: seq,
        unreadFromSeq: null,
        joinedSeq: 0,
        unread: 0,
        asOfRev: 1,
        threads: [],
        summaryCursor: cursor === "Page02" ? null : cursor === "Page01" ? "Page02" : "Page01",
      };
    },
  });
  try {
    await store.markRead(conversation.id, 1, "all");
    expect(seen).toEqual([
      [conversation.id, 1, "all", undefined],
      [conversation.id, 1, "all", "Page01"],
      [conversation.id, 1, "all", "Page02"],
    ]);
  } finally {
    store.dispose();
  }
});

test("thread hints invalidate the sidebar through its canonical read", async () => {
  let reads = 0;
  const { store, connection } = systemFixture({
    conversation: async () => {
      reads++;
      return systemConversation;
    },
  });
  try {
    await connection.get("list").apply({ type: "threads", conversationId: conversation.id });
    expect(reads).toBe(1);
  } finally {
    store.dispose();
  }
});

test("thread discovery renews the existing conversation subscription from the hint cursor", async () => {
  const { store, connection } = systemFixture();
  try {
    const original = connection.get("conversation");
    const revision = store.openConversation?.threadsRevision ?? 0;
    await original.apply({ type: "threads", conversationId: conversation.id });
    expect(original.closed).toBe(true);
    expect(connection.get("conversation").cursor).toBe("cursor");
    expect(store.openConversation?.threadsRevision).toBeGreaterThan(revision);
  } finally {
    store.dispose();
  }
});

test("All-thread read continuation failures reject; retry preserves the target and cancellation stops later pages", async () => {
  let fail = true;
  const cursors: (string | undefined)[] = [];
  const { store } = systemFixture({
    read: async (id, seq, _thread, cursor) => {
      cursors.push(cursor);
      if (cursor && fail) throw new Error("offline");
      return {
        conversationId: id,
        lastReadSeq: seq,
        unreadFromSeq: null,
        joinedSeq: 0,
        unread: 0,
        asOfRev: 1,
        threads: [],
        summaryCursor: cursor ? null : "Page01",
      };
    },
  });
  try {
    await expect(store.markRead(conversation.id, 1, "all")).rejects.toThrow("offline");
    fail = false;
    await store.markRead(conversation.id, 1, "all");
    expect(cursors).toEqual([undefined, "Page01", undefined, "Page01"]);
  } finally {
    store.dispose();
  }
});

test("closing a selection aborts its All-thread read before another continuation", async () => {
  let calls = 0;
  let signal: AbortSignal | undefined;
  const first = deferred<Awaited<ReturnType<ChatStoreApi["read"]>>>();
  const { store } = systemFixture({
    read: async (_id, _seq, _view, _cursor, requestSignal) => {
      calls++;
      signal = requestSignal;
      return first.promise;
    },
  });
  const pending = store.markRead(conversation.id, 1, "all");
  store.closeConversation();
  first.resolve({
    conversationId: conversation.id,
    lastReadSeq: 1,
    unreadFromSeq: null,
    joinedSeq: 0,
    unread: 0,
    asOfRev: 1,
    threads: [],
    summaryCursor: "Page01",
  });
  try {
    await expect(pending).rejects.toThrow();
    expect(signal?.aborted).toBe(true);
    expect(calls).toBe(1);
  } finally {
    store.dispose();
  }
});

test("selection-only system receipts refresh the aggregate instead of replacing it with a selection count", async () => {
  let reads = 0;
  const { store } = systemFixture({
    conversation: async () => {
      reads++;
      return { ...systemConversation, unread: 4, read: { lastReadSeq: 1, unreadFromSeq: null, joinedSeq: 0 } };
    },
    read: async (id) => ({
      conversationId: id,
      lastReadSeq: 1,
      unreadFromSeq: null,
      joinedSeq: 0,
      unread: 0,
      asOfRev: 1,
      threads: [],
      summaryCursor: "",
    }),
  });
  try {
    await store.markRead(conversation.id, 1, "Thread");
    expect(reads).toBe(1);
    expect(store.openConversation?.conversation?.unread).toBe(4);
    expect(store.sidebar.find((row) => row.id === conversation.id)?.unread).toBe(4);
  } finally {
    store.dispose();
  }
});

test("a repeated All-thread receipt cursor fails instead of looping", async () => {
  let calls = 0;
  const { store } = systemFixture({
    read: async (id) => {
      calls++;
      return {
        conversationId: id,
        lastReadSeq: 1,
        unreadFromSeq: null,
        joinedSeq: 0,
        unread: 0,
        asOfRev: 1,
        threads: [],
        summaryCursor: "Page01",
      };
    },
  });
  try {
    await expect(store.markRead(conversation.id, 1, "all")).rejects.toThrow("Repeated chat read cursor");
    expect(calls).toBe(2);
  } finally {
    store.dispose();
  }
});

test("system Jump to latest retains an acknowledged arrival newer than its snapshot", async () => {
  const latest = deferred<ReturnType<typeof windowPage>>();
  const { store, connection } = systemFixture({ messages: async () => latest.promise });
  store.open({ cursor: "middle", conversation: systemConversation, threads: noThreads, view: "all", page: windowPage(1, 1, 5, 1) });
  try {
    const loading = store.loadLatest();
    await connection.get("conversation").apply({ type: "message", message: message(6) });
    latest.resolve(windowPage(1, 5));
    await loading;
    expect(store.openConversation).toMatchObject({ watermark: 6, seqHead: 6, hasNewer: false });
    expect(store.openConversation?.messages.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  } finally {
    store.dispose();
  }
});

test("system revocation reconciliation drops concurrent arrivals outside the authorized snapshot", async () => {
  const latest = deferred<ReturnType<typeof windowPage>>();
  const { store, connection } = systemFixture({ messages: async () => latest.promise });
  try {
    const loading = connection.get("conversation").resync();
    await connection.get("conversation").apply({ type: "message", message: message(6) });
    latest.resolve(windowPage(1, 5));
    await loading;
    expect(store.openConversation?.messages.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
  } finally {
    store.dispose();
  }
});

for (const channel of ["conversation", "list"]) {
  test(`${channel} batched discovery resumes at the first relevant hint, then deduplicates replay`, async () => {
    const { store, connection } = systemFixture();
    try {
      const subscription = connection.get(channel);
      const known = { ...message(3), rev: 30 };
      const missed = { ...message(2), rev: 20 };
      const event =
        channel === "conversation" ? { type: "message", message: known } : chatLiveUpdates(conversation.id, known, "known", [])[1]!.data;
      await subscription.applyBatch(
        [
          { type: "threads", conversationId: "Other1" },
          { type: "threads", conversationId: conversation.id },
          { type: "threads", conversationId: conversation.id },
          event,
        ],
        ["5", "10", "25", "30"],
      );
      expect(connection.get(channel).cursor).toBe("10");
      expect(subscription.closed).toBe(true);
      await connection
        .get(channel)
        .applyBatch(channel === "conversation" ? [{ type: "message", message: missed }, event, event] : [event, event]);
      if (channel === "conversation") expect(store.openConversation?.messages.map((row) => row.seq)).toEqual([1, 2, 3]);
    } finally {
      store.dispose();
    }
  });
}

test("sidebar discovery authorizes a recent thread outside the summary page before renewal", async () => {
  const order: string[] = [];
  const { store, connection } = systemFixture({
    conversation: async () => {
      order.push("summary:ids-1-100");
      return systemConversation;
    },
    threads: async (_id, query) => {
      order.push(`recent:${query?.short}`);
      return noThreads;
    },
  });
  try {
    const original = connection.get("list");
    await original.apply({ type: "threads", conversationId: conversation.id });
    expect(order).toEqual(["summary:ids-1-100", "recent:true"]);
    expect(original.closed).toBe(true);
  } finally {
    store.dispose();
  }
});

test("failed sidebar recent-thread authorization leaves discovery unacknowledged for retry", async () => {
  const { store, connection } = systemFixture({
    threads: async () => {
      throw new Error("reader unavailable");
    },
  });
  try {
    const original = connection.get("list");
    await expect(original.apply({ type: "threads", conversationId: conversation.id })).rejects.toThrow("reader unavailable");
    expect(original.closed).toBe(false);
  } finally {
    store.dispose();
  }
});

test("a latest response started during revocation and finishing first cannot cancel it", async () => {
  const reconcile = deferred<ReturnType<typeof windowPage>>();
  let calls = 0;
  const { store, connection } = systemFixture({
    messages: async () => (++calls === 1 ? reconcile.promise : windowPage(1, 5)),
  });
  store.open({ cursor: "middle", conversation: systemConversation, threads: noThreads, view: "all", page: windowPage(1, 1, 5, 1) });
  try {
    expect(store.openConversation?.hasNewer).toBe(true);
    const resync = connection.get("conversation").resync();
    // The reader jumps to the latest messages while access is being reconciled; that read answers first.
    await store.loadLatest();
    reconcile.resolve({ ...windowPage(1, 5), items: [] });
    await resync;
    expect(store.openConversation?.messages).toEqual([]);
  } finally {
    store.dispose();
  }
});

test("a latest response started before revocation cannot restore the superseded authorized window", async () => {
  const latest = deferred<ReturnType<typeof windowPage>>();
  let calls = 0;
  const { store, connection } = systemFixture({
    messages: async () => (++calls === 1 ? latest.promise : { ...windowPage(1, 5), items: [] }),
  });
  store.open({ cursor: "middle", conversation: systemConversation, threads: noThreads, view: "all", page: windowPage(1, 1, 5, 1) });
  try {
    const loading = store.loadLatest();
    await connection.get("conversation").resync();
    expect(store.openConversation?.messages).toEqual([]);
    latest.resolve(windowPage(1, 5));
    await loading;
    expect(store.openConversation?.messages).toEqual([]);
  } finally {
    store.dispose();
  }
});

test("personal list changes retain and refresh nonmember system rows independently of archive mode", async () => {
  const system = { ...conversation, id: "System", kind: "system" as const, member: false, pinnedRank: null, archived: false };
  const { store, connection } = fixture({
    conversations: async () => ({ items: [], nextCursor: null }),
    conversation: async (id) => (id === system.id ? system : conversation),
  });
  try {
    store.includeSystemChats([system]);
    await store.showArchive(true);
    expect(store.sidebar).toContainEqual(system);
    await connection.get("me").apply({ type: "membership", conversationId: conversation.id });
    expect(store.sidebar).toContainEqual(system);
  } finally {
    store.dispose();
  }
});
