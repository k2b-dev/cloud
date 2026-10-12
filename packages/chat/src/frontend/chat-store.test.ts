import { expect, test } from "bun:test";
import type { LiveConnection, LiveSubscriptionHandlers } from "@k2b/cloud/browser/live";
import { ConversationSchema, MessageSchema } from "../service/contracts";
import { chatLiveUpdates } from "../service/live-updates";
import { type ChatStoreApi, createChatStore, createChatStoreApi } from "./chat-store";

const conversation = ConversationSchema.parse({
  id: "abcdef",
  name: "Chat",
  title: "Chat",
  icon: null,
  purpose: null,
  memberCount: 2,
  permission: "write",
  rev: 1,
  createdAt: "2026-10-12T00:00:00.000Z",
  lastActivityAt: "2026-10-12T00:00:00.000Z",
});
const message = (rev: number) =>
  MessageSchema.parse({
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
const page = (rev: number) => ({ items: [{ ...message(rev), systemText: null }], rev, seqHead: rev });
type Controls = { apply(data: unknown): Promise<void>; resync(): Promise<void>; revoked(): void; unavailable(): void; closed: boolean };
class ManualConnection implements LiveConnection {
  channels = new Map<string, Controls>();
  subscribe<T>(channel: string, _scope: unknown, handlers: LiveSubscriptionHandlers<T>) {
    const controls: Controls = {
      apply: async (data) => handlers.apply([{ data: handlers.parse(data), cursor: "cursor" }]),
      resync: handlers.resync,
      revoked: () => handlers.revoked?.("access_denied"),
      unavailable: handlers.unavailable,
      closed: false,
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
const fixture = (overrides: Partial<ChatStoreApi> = {}) => {
  const connection = new ManualConnection();
  const api: ChatStoreApi = {
    conversations: async () => ({ items: [conversation], nextCursor: null }),
    conversation: async () => conversation,
    messages: async () => page(1),
    changes: async () => ({ rev: 1, more: false, conversation: null, messages: [] }),
    ...overrides,
  };
  const store = createChatStore(
    { cursor: "cursor", sidebar: { items: [conversation], nextCursor: null }, open: { conversation, page: page(1) } },
    { api, connection },
  );
  return { api, connection, store };
};

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
  store.open({ cursor: "next", conversation: { ...conversation, id: "ghijkl", title: "Other" }, page: { items: [], rev: 0, seqHead: 0 } });
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
    conversations: async () => ({ items: [conversation], nextCursor: null }),
    conversation: async () => ({ ...conversation, rev: 2, name: "Renamed", title: "Renamed" }),
    messages: async () => ({ ...page(2), items: [{ ...system, systemText: null }] }),
    changes: async () => ({ rev: 2, more: false, conversation: null, messages: [] }),
  };
  const store = createChatStore(
    {
      cursor: "before",
      sidebar: { items: [conversation], nextCursor: null },
      open: { conversation, page: { ...page(2), items: [{ ...system, systemText: null }] } },
    },
    { api, connection },
  );
  await connection.get("conversation").apply({ type: "message", message: system });
  expect(store.openConversation?.conversation?.title).toBe("Renamed");
  expect(store.openConversation?.messages).toEqual([system]);
  store.dispose();
});
