import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { AuthContext } from "@k2b/cloud/server";
import { toPgTextArray } from "@k2b/cloud/services";
import { redis, sql } from "bun";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import {
  ChangesPageSchema,
  ChatSnapshotSchema,
  ConversationSchema,
  ForYouPageSchema,
  ItemEventsPageSchema,
  MessagePageSchema,
  SharedPageSchema,
  SystemChatPageSchema,
  ThreadListSchema,
  ThreadSchema,
} from "../service/contracts";
import { mockDiscussionCatalog, providerApp } from "../service/discussions.test-fixture";
import { chatLiveChannels } from "../service/live-channels";
import { accessKey, authorizationKey, resourceReaderDependencies } from "../service/resource-access";
import { SearchResultSchema } from "../service/search-contracts";
import chatApi from ".";
import { messageFixtures, type Person } from "./messages.test-fixture";

suiteFor(
  "database",
  "nats",
  "valkey",
)("third-party resource discussions", () => {
  const f = messageFixtures();
  const server = new Hono<AuthContext>().route("/api/chat", chatApi);
  const collection = { type: "inventory.collection", id: "11111111-1111-4111-8111-111111111111" };
  const item = { type: "inventory.item", id: "22222222-2222-4222-8222-222222222222" };
  const keys = new Set<string>();
  let catalog: ReturnType<typeof mockDiscussionCatalog>, reader: ReturnType<typeof spyOn>;
  let apps = [providerApp("inventory")];
  let readable = true,
    writable = true,
    down = false,
    moved = false;
  const calls: { app: string; capability: string; input: Record<string, unknown> }[] = [];
  const api = (person: Person, path: string, method = "GET", body?: unknown) =>
    server.request(`http://chat.test/api/chat${path}`, {
      method,
      headers: { ...person.headers, "x-forwarded-for": uniqueCallerAddress(), ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const trackKeys = (person: Person, ref: typeof collection) => {
    const principal = `user:${person.id}`;
    const values = [accessKey(principal, ref, "en"), accessKey(principal, ref, "de"), authorizationKey(principal, ref)];
    values.forEach((key) => keys.add(key));
    return values;
  };
  beforeEach(() => {
    apps = [providerApp("inventory")];
    readable = true;
    writable = true;
    down = false;
    moved = false;
    calls.length = 0;
    catalog = mockDiscussionCatalog(apps);
    reader = spyOn(resourceReaderDependencies, "invoke").mockImplementation(async (app, capability, input) => {
      calls.push({ app, capability, input });
      if (down && app === "inventory") throw new Error("offline");
      const containerType = `${app}.collection`;
      if (capability === "collection.containers")
        return { data: { items: [{ ref: { ...collection, type: containerType }, title: "Warehouse" }], next: null } };
      if (capability === "collection.activity")
        return {
          data: [
            {
              id: "event-1",
              at: "2026-10-29T12:00:00Z",
              ref: item,
              title: "Box",
              actor: { type: "system", id: null, name: "Inventory" },
              icon: "ti ti-package",
              sentence: "Stock changed",
              count: 1,
            },
          ],
          page: { nextCursor: "activity-next" },
        };
      if (capability === "item.read" && !readable) return null;
      return {
        data: {
          view: {
            title: capability === "item.read" ? "Box" : "Warehouse",
            context: "In stock",
            permission: capability === "item.read" ? "read" : writable ? "write" : "read",
            ...(capability === "item.read"
              ? {
                  container: {
                    ref: moved ? { ...collection, id: "33333333-3333-4333-8333-333333333333" } : collection,
                    title: "Warehouse",
                  },
                  status: "Ready",
                  done: false,
                }
              : {}),
          },
        },
        links: [{ rel: "open", href: "/app/inventory/resource" }],
      };
    });
  });
  afterEach(async () => {
    reader.mockRestore();
    catalog.mockRestore();
    if (keys.size) await redis.send("DEL", [...keys]);
    keys.clear();
  });
  const open = async (person: Person) => {
    trackKeys(person, collection);
    trackKeys(person, item);
    const response = await api(person, `/system-chats/${collection.type}/${collection.id}/open`, "POST");
    expect(response.status).toBe(200);
    const chat = ConversationSchema.parse(await response.json());
    f.trackChat(chat.id);
    return chat;
  };
  test("lists, opens UUID resources, discusses and reads activity without built-in providers", async () => {
    const person = await f.person();
    trackKeys(person, collection);
    trackKeys(person, item);
    const page = SystemChatPageSchema.parse(await (await api(person, "/system-chats")).json());
    expect(page.items).toMatchObject([{ ref: collection, name: "Warehouse", icon: "ti ti-box", color: "blue", conversation: null }]);
    expect(page.cursors).toEqual({ "inventory.collection": "" });
    const chat = await open(person);
    expect(chat.discussionItemType).toBe(item.type);
    const response = await api(person, `/conversations/${chat.id}/threads/for-resource`, "POST", { ref: item });
    expect(response.status).toBe(200);
    const thread = ThreadSchema.parse(await response.json());
    expect(thread.resource).toMatchObject({
      ref: item,
      title: "Box",
      context: "In stock",
      status: "Ready",
      permission: "read",
      container: { ref: collection },
      icon: "ti ti-package",
    });
    expect(
      (
        await api(person, `/conversations/${chat.id}/messages`, "POST", {
          clientId: "inventory-message",
          body: "Count this box",
          thread: thread.id,
        })
      ).status,
    ).toBe(201);
    const activity = ItemEventsPageSchema.parse(
      await (await api(person, `/conversations/${chat.id}/events?thread=${thread.id}&cursor=before`)).json(),
    );
    expect(activity.items[0]?.thread).toEqual({ id: thread.id, name: "Box" });
    expect(activity.nextCursor).toBe("activity-next");
    expect(calls.find((call) => call.capability === "collection.activity")?.input).toMatchObject({
      container: collection.id,
      item: item.id,
      cursor: "before",
      limit: 50,
    });
    expect(calls.every((call) => call.app === "inventory")).toBeTrue();
    const search = await (await api(person, "/search?q=Box")).json();
    expect(JSON.stringify(search)).toContain(thread.id);
  });
  test("keeps separate container and item authority for messages, summaries and live resync", async () => {
    const person = await f.person(),
      chat = await open(person);
    const thread = ThreadSchema.parse(
      await (await api(person, `/conversations/${chat.id}/threads/for-resource`, "POST", { ref: item })).json(),
    );
    await api(person, `/conversations/${chat.id}/messages`, "POST", {
      clientId: "private-message",
      body: "Visible before revocation",
      thread: thread.id,
    });
    const viewer = { id: `user:${person.id}`, ...person.context, scopes: [] };
    expect((await chatLiveChannels.conversation.authorize(`t:${chat.id}:${thread.id}`, [viewer])).size).toBe(1);
    readable = false;
    await redis.send("DEL", trackKeys(person, item));
    expect((await chatLiveChannels.conversation.authorize(`t:${chat.id}:${thread.id}`, [viewer])).size).toBe(0);
    expect((await chatLiveChannels.list.authorize(`s:${chat.id}:${thread.id}`, [viewer])).size).toBe(0);
    const page = MessagePageSchema.parse(await (await api(person, `/conversations/${chat.id}/messages`)).json());
    expect(page.items).toEqual([]);
    expect(ThreadListSchema.parse(await (await api(person, `/conversations/${chat.id}/threads`)).json()).items).toEqual([]);
    readable = true;
    moved = true;
    await redis.send("DEL", trackKeys(person, item));
    expect((await api(person, `/conversations/${chat.id}/threads/${thread.id}`)).status).toBe(404);
    expect(ThreadListSchema.parse(await (await api(person, `/conversations/${chat.id}/threads`)).json()).items).toEqual([]);
    await redis.send("DEL", trackKeys(person, collection));
    down = true;
    expect((await api(person, `/conversations/${chat.id}/messages`)).status).toBe(404);
  });
  test("requires container write even when the item is readable", async () => {
    writable = false;
    const person = await f.person(),
      chat = await open(person);
    expect((await api(person, `/conversations/${chat.id}/threads/for-resource`, "POST", { ref: item })).status).toBe(403);
    expect((await api(person, `/system-chats/${item.type}/${item.id}/open`, "POST")).status).toBe(404);
  });
  test("reports unavailable providers with a retry cursor and continues other providers", async () => {
    catalog.mockRestore();
    catalog = mockDiscussionCatalog([providerApp("inventory"), providerApp("supplies")]);
    const person = await f.person();
    trackKeys(person, { ...collection, type: "supplies.collection" });
    down = true;
    const page = SystemChatPageSchema.parse(await (await api(person, "/system-chats")).json());
    expect(page.skipped).toEqual(["inventory.collection"]);
    expect(page.items.map((entry) => entry.ref.type)).toEqual(["supplies.collection"]);
    expect(page.cursors["inventory.collection"]).toEqual({});
    down = false;
    trackKeys(person, collection);
    const next = SystemChatPageSchema.parse(
      await (await api(person, `/system-chats?cursors=${encodeURIComponent(JSON.stringify(page.cursors))}`)).json(),
    );
    expect(next.items.map((entry) => entry.ref.type)).toEqual(["inventory.collection"]);
  });
  test("rotates skipped providers before previously served ones within the shared call limit", async () => {
    catalog.mockRestore();
    const many = Array.from({ length: 32 }, (_, index) => providerApp(`inventory-${index}`));
    catalog = mockDiscussionCatalog(many);
    const person = await f.person();
    for (const app of many) trackKeys(person, { ...collection, type: `${app.appId}.collection` });
    const first = SystemChatPageSchema.parse(await (await api(person, "/system-chats")).json());
    expect(calls.length).toBeLessThanOrEqual(59); // one additional call read the catalog
    expect(first.skipped.length).toBeGreaterThan(0);
    calls.length = 0;
    const next = SystemChatPageSchema.parse(
      await (await api(person, `/system-chats?cursors=${encodeURIComponent(JSON.stringify(first.cursors))}`)).json(),
    );
    expect(next.items.map((entry) => entry.ref.type)).toEqual(first.skipped);
    expect(new Set([...first.items, ...next.items].map((entry) => entry.ref.type)).size).toBe(32);
  });
  test("paginates more than one request budget of activity without losing unique items", async () => {
    const person = await f.person(),
      chat = await open(person);
    const refs = Array.from({ length: 120 }, (_, i) => ({ type: item.type, id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` }));
    refs.forEach((ref) => trackKeys(person, ref));
    reader.mockImplementation(async (_app: string, capability: string, input: Record<string, unknown>) => {
      calls.push({ app: "inventory", capability, input });
      if (capability === "collection.activity") {
        const offset = Number(input.cursor ?? 0),
          limit = Number(input.limit);
        const page = refs.slice(offset, offset + limit);
        return {
          data: page.map((ref) => ({
            id: ref.id,
            at: "2026-10-29T12:00:00Z",
            ref,
            actor: { type: "system", id: null, name: "Inventory" },
            icon: "ti ti-package",
            sentence: "Stock changed",
            count: 1,
          })),
          page: offset + page.length < refs.length ? { nextCursor: String(offset + page.length) } : undefined,
        };
      }
      return {
        data: { view: { title: "Box", permission: "read", container: { ref: collection, title: "Warehouse" } } },
        links: [{ rel: "open", href: "/app/inventory/resource" }],
      };
    });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page++) {
      calls.length = 0;
      const response = await api(person, `/conversations/${chat.id}/events?limit=100${cursor ? `&cursor=${cursor}` : ""}`);
      expect(response.status).toBe(200);
      const result = ItemEventsPageSchema.parse(await response.json());
      expect(result.unavailable).toBeUndefined();
      expect(calls.length).toBeLessThanOrEqual(59); // catalog shares the 60-call allowance
      seen.push(...result.items.map((event) => event.id));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    expect(seen).toEqual(refs.map((ref) => ref.id));
  });
  test("deduplicates activity authorization and preserves the cursor on reader failure", async () => {
    const person = await f.person(),
      chat = await open(person);
    await redis.send("DEL", trackKeys(person, item));
    let broken = true;
    let nextCursor = "next";
    reader.mockImplementation(async (_app: string, capability: string) => {
      if (capability === "collection.activity")
        return {
          data: Array.from({ length: 20 }, (_, i) => ({
            id: String(i),
            at: "2026-10-29T12:00:00Z",
            ref: item,
            actor: { type: "system", id: null, name: "Inventory" },
            icon: "ti ti-package",
            sentence: "Stock changed",
            count: 1,
          })),
          page: { nextCursor },
        };
      calls.push({ app: "inventory", capability, input: {} });
      if (broken) throw new Error("offline");
      return {
        data: { view: { title: "Box", permission: "read", container: { ref: collection, title: "Warehouse" } } },
        links: [{ rel: "open", href: "/app/inventory/resource" }],
      };
    });
    calls.length = 0;
    const path = `/conversations/${chat.id}/events?cursor=before`;
    const failed = ItemEventsPageSchema.parse(await (await api(person, path)).json());
    expect(failed).toEqual({ items: [], nextCursor: "before", unavailable: true });
    expect(calls.filter((call) => call.capability === "item.read")).toHaveLength(1);
    broken = false;
    calls.length = 0;
    const recovered = ItemEventsPageSchema.parse(await (await api(person, path)).json());
    expect(recovered.items).toHaveLength(20);
    expect(recovered.nextCursor).toBe("next");
    expect(calls.filter((call) => call.capability === "item.read")).toHaveLength(1);
    nextCursor = "before";
    const stalled = ItemEventsPageSchema.parse(await (await api(person, path)).json());
    expect(stalled).toEqual({ items: [], nextCursor: "before", unavailable: true });
  });
  test("lists a useful provider page and continues past a broken container reader", async () => {
    const person = await f.person();
    const refs = Array.from({ length: 30 }, (_, i) => ({
      type: collection.type,
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    }));
    refs.forEach((ref) => trackKeys(person, ref));
    reader.mockImplementation(async (_app: string, capability: string, input: Record<string, unknown>) => {
      if (capability === "collection.containers") {
        const offset = Number(input.cursor ?? 0),
          limit = Number(input.limit);
        const page = refs.slice(offset, offset + limit);
        return {
          data: {
            items: page.map((ref) => ({ ref, title: "Warehouse" })),
            next: offset + page.length < refs.length ? String(offset + page.length) : null,
          },
        };
      }
      if (input.id === refs[0]!.id) throw new Error("Broken container");
      return { data: { view: { title: "Warehouse", permission: "read" } }, links: [{ rel: "open", href: "/app/inventory/resource" }] };
    });
    const first = SystemChatPageSchema.parse(await (await api(person, "/system-chats")).json());
    expect(first.items.length).toBeGreaterThan(20);
    expect(first.skipped).toEqual([collection.type]);
    expect(first.cursors[collection.type]).not.toBe("");
    const next = SystemChatPageSchema.parse(
      await (await api(person, `/system-chats?cursors=${encodeURIComponent(JSON.stringify(first.cursors))}`)).json(),
    );
    expect(next.cursors[collection.type]).toBe("");
    expect([...first.items, ...next.items].map((entry) => entry.ref)).toEqual(refs.slice(1));
  });
  test("cold snapshots and directory continuations survive more than sixty item threads", async () => {
    const person = await f.person();
    const container = { ...collection, id: "44444444-4444-4444-8444-444444444444" };
    const refs = Array.from({ length: 61 }, (_, i) => ({ type: item.type, id: `55555555-5555-4555-8555-${String(i).padStart(12, "0")}` }));
    trackKeys(person, container);
    refs.forEach((ref) => trackKeys(person, ref));
    let broken = false;
    reader.mockImplementation(async (_app: string, capability: string, input: Record<string, unknown>) => {
      if (capability === "item.read" && broken && input.id === refs[0]!.id) throw new Error("Reader unavailable");
      return {
        data: {
          view: {
            title: "Box",
            permission: "write",
            ...(capability === "item.read" ? { container: { ref: container, title: "Warehouse" } } : {}),
          },
        },
        links: [{ rel: "open", href: "/app/inventory/resource" }],
      };
    });
    const response = await api(person, `/system-chats/${container.type}/${container.id}/open`, "POST");
    expect(response.status).toBe(200);
    const chat = ConversationSchema.parse(await response.json());
    f.trackChat(chat.id);
    const [stored] = await sql<{ id: string }[]>`SELECT id FROM chat.conversations WHERE short_id = ${chat.id}`;
    if (!stored) throw new Error("Missing test conversation");
    await sql`INSERT INTO chat.threads
      (short_id, conversation_id, name, resource_type, resource_id, created_by_type, created_by_id, last_activity_at)
      SELECT 'b' || lpad((ordinal - 1)::text, 5, '0'), ${stored.id}::uuid, 'Box', ${item.type}, resource_id,
        'user', ${person.id}::uuid, '2026-10-29T12:00:00Z'
      FROM unnest(${toPgTextArray(refs.map((ref) => ref.id))}::text[]) WITH ORDINALITY AS resources(resource_id, ordinal)`;
    await sql`INSERT INTO chat.messages
      (short_id, conversation_id, thread_id, seq, rev, kind, author_type, author_id, author_name, body_md, client_id)
      SELECT 'b' || lpad(right(short_id, 5), 9, '0'), conversation_id, id, right(short_id, 5)::int + 1,
        right(short_id, 5)::int + 1, 'text', 'user', ${person.id}::uuid, 'Reader', 'Count this box', 'budget-' || right(short_id, 5)::int
      FROM chat.threads WHERE conversation_id = ${stored.id}::uuid`;
    await sql`UPDATE chat.conversations SET seq_head = 61, rev = 61 WHERE id = ${stored.id}::uuid`;
    await redis.send("DEL", trackKeys(person, container));
    const snapshotResponse = await api(person, `/conversations/${chat.id}/snapshot`);
    expect(snapshotResponse.status).toBe(200);
    const snapshot = ChatSnapshotSchema.parse(await snapshotResponse.json());
    expect(snapshot.conversation.summaryCursor).not.toBeNull();
    expect(snapshot.threads.incomplete).toBeTrue();
    expect(snapshot.threads.nextCursor).not.toBeNull();
    const first = ThreadListSchema.parse(await (await api(person, `/conversations/${chat.id}/threads`)).json());
    expect(first.items).toHaveLength(60);
    expect(first.nextCursor).toBe("b00059");
    const second = ThreadListSchema.parse(await (await api(person, `/conversations/${chat.id}/threads?cursor=${first.nextCursor}`)).json());
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((thread) => thread.id)).size).toBe(61);
    await redis.send(
      "DEL",
      refs.flatMap((ref) => trackKeys(person, ref)),
    );
    broken = true;
    const failedResponse = await api(person, `/conversations/${chat.id}/changes?afterRev=0`);
    expect(failedResponse.status).toBe(200);
    const failed = ChangesPageSchema.parse(await failedResponse.json());
    expect(failed.incomplete).toBeTrue();
    expect(failed.messages.some((message) => message.thread === "b00000")).toBeFalse();
    expect(failed.messages.length).toBeGreaterThan(0);
    broken = false;
    await redis.send(
      "DEL",
      refs.flatMap((ref) => trackKeys(person, ref)),
    );
    const changes = ChangesPageSchema.parse(await (await api(person, `/conversations/${chat.id}/changes?afterRev=0`)).json());
    expect(changes.messages).toHaveLength(59);
    expect(changes.rev).toBe(59);
    expect(changes.more).toBeTrue();
    const next = ChangesPageSchema.parse(await (await api(person, `/conversations/${chat.id}/changes?afterRev=${changes.rev}`)).json());
    expect(next.messages).toHaveLength(2);
    expect(next.rev).toBe(61);
    expect(next.more).toBeFalse();
    expect(new Set([...changes.messages, ...next.messages].map((message) => message.id)).size).toBe(61);
    await sql`UPDATE chat.messages m SET refs = jsonb_build_array(jsonb_build_object('type', t.resource_type, 'id', t.resource_id))
      FROM chat.threads t WHERE m.thread_id = t.id AND m.conversation_id = ${stored.id}::uuid`;
    await redis.send(
      "DEL",
      refs.flatMap((ref) => trackKeys(person, ref)),
    );
    reader.mockImplementation(async (_app: string, capability: string) => ({
      data: {
        view: {
          title: "Box",
          permission: "read",
          ...(capability === "item.read" ? { container: { ref: container, title: "Warehouse" } } : {}),
        },
        padding: "x".repeat(200 * 1024),
      },
    }));
    const shared = SharedPageSchema.parse(await (await api(person, `/conversations/${chat.id}/shared?kind=elements`)).json());
    expect(shared.incomplete).toBeTrue();
    expect(shared.nextCursor).toBe("");
    const sharedRetry = SharedPageSchema.parse(await (await api(person, `/conversations/${chat.id}/shared?kind=elements&cursor=`)).json());
    expect(sharedRetry.incomplete).toBeUndefined();
    expect(sharedRetry.items).toHaveLength(30);
    const recipient = await f.person();
    trackKeys(recipient, container);
    refs.forEach((ref) => trackKeys(recipient, ref));
    await sql`INSERT INTO chat.message_mentions (message_id, principal_type, principal_id, start_offset, end_offset, created_at)
      SELECT id, 'user', ${recipient.id}::uuid, 0, 1, '2026-10-29T12:00:00Z'
      FROM chat.messages WHERE conversation_id = ${stored.id}::uuid`;
    const forYou = ForYouPageSchema.parse(await (await api(recipient, "/for-you")).json());
    expect(forYou.incomplete).toBeTrue();
    expect(forYou.nextCursor).toBe("");
    const forYouRetry = ForYouPageSchema.parse(await (await api(recipient, "/for-you?cursor=")).json());
    expect(forYouRetry.incomplete).toBeUndefined();
    expect(forYouRetry.items).toHaveLength(30);
  }, 30_000);
  test("missing open links and a broken item leave sibling summaries, messages and discovery usable", async () => {
    const person = await f.person();
    const collection = { type: "inventory.collection", id: "failure-isolation-container" };
    const item = { type: "inventory.item", id: "failed-item" };
    const nextCursor = '"'.repeat(2048);
    trackKeys(person, collection);
    reader.mockImplementation(async (_app: string, capability: string, input: Record<string, unknown>) => {
      if (capability === "collection.containers") {
        if (input.cursor !== undefined) {
          expect(input.cursor).toBe(nextCursor);
          return { data: { items: [], next: null } };
        }
        return { data: { items: [{ ref: collection, title: "Warehouse" }], next: nextCursor } };
      }
      if (input.id === item.id) throw new Error("One item offline");
      return {
        data: {
          view: {
            title: "Readable sibling",
            permission: "read",
            ...(capability === "item.read" ? { container: { ref: collection, title: "Warehouse" } } : {}),
          },
        },
      };
    });
    const opened = await api(person, `/system-chats/${collection.type}/${collection.id}/open`, "POST");
    expect(opened.status).toBe(200);
    const chat = ConversationSchema.parse(await opened.json());
    f.trackChat(chat.id);
    const [stored] = await sql<{ id: string }[]>`SELECT id FROM chat.conversations WHERE short_id = ${chat.id}`;
    if (!stored) throw new Error("Missing conversation");
    const refs = [item, { ...item, id: "sibling" }];
    for (const [i, ref] of refs.entries()) {
      trackKeys(person, ref);
      await sql`INSERT INTO chat.threads (short_id, conversation_id, name, resource_type, resource_id, created_by_type, created_by_id)
        VALUES (${`fail0${i}`}, ${stored.id}::uuid, 'Box', ${ref.type}, ${ref.id}, 'user', ${person.id}::uuid)`;
    }
    const summaryResponse = await api(person, `/conversations/${chat.id}`);
    expect(summaryResponse.status).toBe(200);
    expect(ConversationSchema.parse(await summaryResponse.json()).incomplete).toBeTrue();
    const directory = ThreadListSchema.parse(await (await api(person, `/conversations/${chat.id}/threads`)).json());
    expect(directory.items.map((thread) => thread.id)).toEqual(["fail01"]);
    expect(directory.items[0]?.resource?.href).toBeUndefined();
    expect(directory.incomplete).toBeTrue();
    expect((await api(person, `/conversations/${chat.id}/messages`)).status).toBe(200);
    expect((await api(person, `/conversations/${chat.id}/snapshot`)).status).toBe(200);
    const discovery = SystemChatPageSchema.parse(await (await api(person, "/system-chats")).json());
    expect(discovery.items.map((entry) => entry.ref)).toEqual([collection]);
    expect(discovery.cursors[collection.type]).toEqual({ cursor: nextCursor });
    const continuation = await api(person, `/system-chats?cursors=${encodeURIComponent(JSON.stringify(discovery.cursors))}`);
    expect(continuation.status).toBe(200);
    expect(SystemChatPageSchema.parse(await continuation.json()).cursors[collection.type]).toBe("");
    expect(discovery.skipped).toEqual([collection.type]);
  });

  test("search covers the full directory and deduplicates cold container reads", async () => {
    const person = await f.person();
    const refs = Array.from({ length: 12 }, (_, i) => ({ ...collection, id: `search-container-${i}` }));
    const parents = new Map<string, typeof collection>();
    const at = "2026-10-29T12:00:00Z";
    for (const [index, ref] of refs.entries()) {
      trackKeys(person, ref);
      const [stored] = await sql<{ id: string }[]>`INSERT INTO chat.conversations
        (short_id, kind, resource_type, resource_id, name, created_by_type, created_by_id, created_at, last_activity_at)
        VALUES (${`sr${String(index).padStart(4, "0")}`}, 'system', ${ref.type}, ${ref.id}, 'Warehouse', 'user', ${person.id}::uuid, ${at}, ${at}) RETURNING id`;
      if (!stored) throw new Error("Missing conversation");
      f.trackChat(`sr${String(index).padStart(4, "0")}`);
      for (let i = 0; i < 3; i++) {
        const id = `search-item-${index}-${i}`;
        parents.set(id, ref);
        trackKeys(person, { type: item.type, id });
        await sql`INSERT INTO chat.threads (short_id, conversation_id, name, resource_type, resource_id, created_by_type, created_by_id, last_activity_at)
          VALUES (${`s${String(index * 3 + i).padStart(5, "0")}`}, ${stored.id}::uuid, 'Old name', ${item.type}, ${id}, 'user', ${person.id}::uuid, ${at})`;
      }
    }
    const counts = new Map<string, number>();
    reader.mockImplementation(async (_app: string, capability: string, input: Record<string, unknown>) => {
      if (capability === "collection.containers")
        return { data: { items: input.query ? [] : refs.map((ref) => ({ ref, title: "Warehouse" })), next: null } };
      const id = String(input.id);
      counts.set(id, (counts.get(id) ?? 0) + 1);
      const parent = parents.get(id);
      return {
        data: {
          view: {
            title: parent?.id === refs[11]!.id ? "Needle" : "Box",
            permission: "read",
            ...(parent ? { container: { ref: parent, title: "Warehouse" } } : {}),
          },
        },
      };
    });
    const response = await api(person, "/search?q=Needle");
    expect(response.status).toBe(200);
    const result = SearchResultSchema.parse(await response.json());
    expect(result.systemUnavailable).toBeUndefined();
    expect(result.items).toHaveLength(3);
    expect(JSON.stringify(result.items)).toContain("sr0011");
    expect([...counts.values()].every((count) => count === 1)).toBeTrue();
    expect([...counts.values()].reduce((sum, count) => sum + count, 0)).toBe(48);
    // A larger cold directory reaches the transport budget, which is partial scope, not an owner outage.
    const [first] = await sql<{ id: string }[]>`SELECT id FROM chat.conversations WHERE short_id = 'sr0000'`;
    if (!first) throw new Error("Missing first conversation");
    for (let i = 0; i < 15; i++) {
      const id = `search-extra-${i}`;
      parents.set(id, refs[0]!);
      trackKeys(person, { type: item.type, id });
      await sql`INSERT INTO chat.threads (short_id, conversation_id, name, resource_type, resource_id, created_by_type, created_by_id, last_activity_at)
        VALUES (${`x${String(i).padStart(5, "0")}`}, ${first.id}::uuid, 'Old name', ${item.type}, ${id}, 'user', ${person.id}::uuid, ${at})`;
    }
    await redis.send("DEL", [...keys]);
    counts.clear();
    const partial = SearchResultSchema.parse(await (await api(person, "/search?q=Needle")).json());
    expect(partial.systemUnavailable).toBeUndefined();
    expect(partial.incomplete).toBeTrue();
    expect(partial.items).toHaveLength(3);
  });
});
