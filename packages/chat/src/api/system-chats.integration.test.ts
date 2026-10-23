import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { AuthContext } from "@k2b/cloud/server";
import { redis, sql } from "bun";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import {
  ChangesPageSchema,
  ChatSnapshotSchema,
  ConversationSchema,
  MessagePageSchema,
  MessageViewSchema,
  ReadAllOutcomeSchema,
  SharedPageSchema,
  SystemChatPageSchema,
  ThreadListSchema,
  ThreadSchema,
} from "../service/contracts";
import { chatLiveChannels } from "../service/live-channels";
import { reconcile } from "../service/maintenance";
import { accessKey, type ResourceReaderDependencies, resourceReaderDependencies } from "../service/resource-access";
import { READER_REQUEST_BUDGET, SUMMARY_TRAVERSAL_BUDGET } from "../service/thread-access";
import chatApi from ".";
import { messageFixtures, type Person } from "./messages.test-fixture";

const suite = suiteFor("database", "nats", "valkey");
suite("system chats use caller-authorized readers", () => {
  const f = messageFixtures();
  const server = new Hono<AuthContext>().route("/api/chat", chatApi);
  type Reply = Awaited<ReturnType<ResourceReaderDependencies["invoke"]>>;
  const replies = new Map<string, Reply>();
  const calls: { capability: string; caller: string; input: Record<string, unknown> }[] = [];
  const keys = new Set<string>();
  let down = false;
  let reader: ReturnType<typeof spyOn>;
  const credential = (person: Person) => person.headers.cookie!;
  const key = (person: Person, type: string, id: string) => {
    const key = accessKey(`user:${person.id}`, { type, id });
    keys.add(key);
    return key;
  };
  const expire = async (person: Person, type: string, id: string) => {
    // Redis expiration, without a wall-clock sleep or a process-local clock/cache.
    await redis.send("PEXPIREAT", [key(person, type, id), "1"]);
  };
  const grant = (person: Person, type: string, id: string, data: Record<string, unknown>) => {
    key(person, type, id);
    replies.set(`${credential(person)}:${type}:${id}`, {
      data: { id, ...data },
      links: [{ rel: "open", href: `/app/${type.split(".")[0]}/${id}` }],
    });
  };
  const revoke = (person: Person, type: string, id: string) => replies.delete(`${credential(person)}:${type}:${id}`);
  const api = (person: Pick<Person, "headers">, path: string, method = "GET", body?: unknown) =>
    server.request(`https://cloud.example.test/api/chat${path}`, {
      method,
      headers: { ...person.headers, "x-forwarded-for": uniqueCallerAddress(), ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const open = async (person: Person, id: string, type = "spaces.space") => {
    const response = await api(person, `/system-chats/${type}/${id}/open`, "POST");
    expect(response.status).toBe(200);
    const conversation = ConversationSchema.parse(await response.json());
    f.trackChat(conversation.id);
    return conversation;
  };
  const thread = async (person: Person, conversation: string, id: string, type = "spaces.item") => {
    const response = await f.request(person.headers, `/${conversation}/threads/for-resource`, "POST", { ref: { type, id } });
    expect(response.status).toBe(200);
    return ThreadSchema.parse(await response.json());
  };
  const viewer = (person: Person) => ({ id: `user:${person.id}`, ...person.context, scopes: [] });
  beforeEach(() => {
    replies.clear();
    calls.length = 0;
    down = false;
    reader = spyOn(resourceReaderDependencies, "invoke").mockImplementation(async (appId, capabilityId, input, caller) => {
      const who = caller.cookie ?? caller.authorization ?? "";
      calls.push({ capability: `${appId}.${capabilityId}`, caller: who, input });
      if (down) throw new Error("reader unavailable");
      if (capabilityId.endsWith(".list")) return replies.get(`${who}:${appId}.${capabilityId}`) ?? { data: [] };
      return replies.get(`${who}:${appId}.${capabilityId.split(".")[0]}:${input.id}`) ?? null;
    });
  });
  afterEach(async () => {
    reader.mockRestore();
    if (keys.size) await redis.send("DEL", [...keys]);
    keys.clear();
  });

  test("maps read/write/manage/admin, creates no grants, and opens idempotently at the first open head", async () => {
    const people = await Promise.all([f.person(), f.person(), f.person(), f.person()]);
    const id = testShortId();
    for (const [index, permission] of (["read", "write", "manage", "admin"] as const).entries()) {
      const person = people[index]!;
      grant(person, "spaces.space", id, { name: "Project", permission });
      const conversation = await open(person, id);
      expect(conversation.permission).toBe(permission === "manage" ? "admin" : permission);
      expect((await open(person, id)).id).toBe(conversation.id);
      expect(conversation.read?.joinedSeq).toBe(0);
      const [count] = await sql<
        { n: number }[]
      >`SELECT count(*)::int AS n FROM chat.conversation_access a JOIN chat.conversations c ON c.id = a.conversation_id WHERE c.short_id = ${conversation.id}`;
      expect(count!.n).toBe(0);
    }
    expect(calls.every((call) => call.caller.startsWith("session_token="))).toBeTrue();
  });

  test("lists containers without conversations, forwards independent source cursors, and excludes unreadable containers", async () => {
    const person = await f.person();
    const space = testShortId(),
      notebook = testShortId(),
      denied = testShortId();
    grant(person, "spaces.space", space, { name: "Space", permission: "write" });
    grant(person, "notebooks.notebook", notebook, { name: "Notebook", permission: "read" });
    replies.set(`${credential(person)}:spaces.space.list`, {
      data: [
        { id: space, name: "Space", permission: "write" },
        { id: denied, name: "Hidden", permission: "read" },
      ],
      page: { nextCursor: "next-space" },
    });
    replies.set(`${credential(person)}:notebooks.notebook.list`, {
      data: [{ id: notebook, name: "Notebook", permission: "read" }],
      page: { nextCursor: "next-note" },
    });
    key(person, "spaces.space", denied);
    const conversation = await open(person, space);
    const response = await api(person, "/system-chats?spacesCursor=space-page&notebooksCursor=note-page");
    const list = SystemChatPageSchema.parse(await response.json());
    expect(list.items.map((item) => item.conversation?.id ?? null)).toEqual([conversation.id, null]);
    expect(list.spacesCursor).toBe("next-space");
    expect(list.notebooksCursor).toBe("next-note");
    expect(calls.find((call) => call.capability === "spaces.space.list")?.input).toEqual({ limit: 100, cursor: "space-page" });
    expect(calls.find((call) => call.capability === "notebooks.notebook.list")?.input).toEqual({ limit: 100, cursor: "note-page" });
  });

  test("refuses manual threads, metadata, member edits and cross-container item threads", async () => {
    const person = await f.person();
    const id = testShortId();
    grant(person, "spaces.space", id, { name: "Project", permission: "manage" });
    const chat = await open(person, id);
    const item = testShortId();
    grant(person, "spaces.item", item, { title: "Task", kind: "task", spaceId: id, completedAt: null });
    const created = await thread(person, chat.id, item);
    expect((await thread(person, chat.id, item)).id).toBe(created.id);
    expect(created.resource).toMatchObject({ ref: { type: "spaces.item", id: item }, kind: "task", done: false, status: null });
    for (const [path, method, body] of [
      ["/threads", "POST", { name: "manual" }],
      [`/threads/${created.id}`, "PATCH", { name: "new" }],
      [`/threads/${created.id}`, "PATCH", { archived: true }],
      ["", "PATCH", { name: "new" }],
      ["/members", "POST", { members: [{ type: "user", userId: person.id }] }],
      ["/members/preview", "POST", { members: [{ type: "user", userId: person.id }] }],
      [`/members/${person.id}`, "PATCH", { permission: "read" }],
      [`/members/${person.id}`, "DELETE", undefined],
      ["/leave", "POST", {}],
    ] as const)
      expect((await f.request(person.headers, `/${chat.id}${path}`, method, body)).status).toBe(403);
    const outsider = testShortId();
    grant(person, "spaces.item", outsider, { title: "Other", kind: "task", spaceId: testShortId() });
    expect(
      (await f.request(person.headers, `/${chat.id}/threads/for-resource`, "POST", { ref: { type: "spaces.item", id: outsider } })).status,
    ).toBe(404);
    const [count] = await sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM chat.messages m JOIN chat.conversations c ON c.id = m.conversation_id WHERE c.short_id = ${chat.id}`;
    expect(count!.n).toBe(0);
  });

  test("hides item content in lists, counts, search, snapshots, shared items, changes, replies and live delivery", async () => {
    const owner = await f.person(),
      guest = await f.person();
    const id = testShortId(),
      hidden = testShortId(),
      visible = testShortId();
    for (const person of [owner, guest]) grant(person, "spaces.space", id, { name: "Project", permission: "write" });
    grant(owner, "spaces.item", hidden, { title: "Secret", kind: "task", spaceId: id });
    for (const person of [owner, guest]) grant(person, "spaces.item", visible, { title: "Visible", kind: "event", spaceId: id });
    key(guest, "spaces.item", hidden);
    const chat = await open(owner, id);
    await open(guest, id);
    const secret = await thread(owner, chat.id, hidden),
      publicThread = await thread(owner, chat.id, visible);
    const send = await f.request(owner.headers, `/${chat.id}/messages`, "POST", {
      clientId: "secret",
      body: "Secret https://example.test/hidden",
      thread: secret.id,
      refs: [{ type: "spaces.item", id: hidden }],
    });
    expect(send.status).toBe(201);
    const message = MessageViewSchema.parse(await send.json());
    const list = ThreadListSchema.parse(await (await f.request(guest.headers, `/${chat.id}/threads`)).json());
    expect(list.items.map((item) => item.id)).toEqual([publicThread.id]);
    const searched = ThreadListSchema.parse(await (await f.request(guest.headers, `/${chat.id}/threads?q=Secret`)).json());
    expect(searched.items).toEqual([]);
    const snapshot = ChatSnapshotSchema.parse(await (await f.request(guest.headers, `/${chat.id}/snapshot`)).json());
    expect(snapshot.conversation.threads).toBe(1);
    expect(snapshot.conversation.unread).toBe(0);
    expect(snapshot.conversation.lastMessage).toBeNull();
    expect(snapshot.page.items).toEqual([]);
    const shared = SharedPageSchema.parse(await (await f.request(guest.headers, `/${chat.id}/shared`)).json());
    expect(shared.items).toEqual([]);
    for (const path of [`/threads?filter=unread`, `/messages`, `/changes?afterRev=0`]) {
      const response = await f.request(guest.headers, `/${chat.id}${path}`);
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain("Secret");
    }
    for (const path of [
      `/snapshot?thread=${secret.id}`,
      `/messages?thread=${secret.id}`,
      `/shared?thread=${secret.id}`,
      `/messages/${message.id}`,
      `/messages/${message.id}/reactions`,
    ])
      expect((await f.request(guest.headers, `/${chat.id}${path}`)).status).toBe(404);
    for (const method of ["PUT", "DELETE"])
      expect(
        (await f.request(guest.headers, `/${chat.id}/messages/${message.id}/reactions/${encodeURIComponent("👍")}`, method)).status,
      ).toBe(404);
    expect(
      (await f.request(guest.headers, `/${chat.id}/messages`, "POST", { clientId: "bad-reply", body: "reply", replyTo: message.id }))
        .status,
    ).toBe(404);
    expect((await chatLiveChannels.conversation.authorize(`t:${chat.id}:${secret.id}`, [viewer(guest)])).size).toBe(0);
    expect((await chatLiveChannels.conversation.authorize(`t:${chat.id}:${publicThread.id}`, [viewer(guest)])).size).toBe(1);
    const outbox = await sql<
      { ordering_key: string }[]
    >`SELECT ordering_key FROM events.outbox WHERE app_id = 'chat' AND payload::text LIKE ${`%${message.id}%`}`;
    expect(outbox.map((row) => row.ordering_key).sort()).toEqual([`s:${chat.id}:${secret.id}`, `t:${chat.id}:${secret.id}`]);
  });

  test("system item messages project each viewer's reactions and publish only an item-scoped hint", async () => {
    const owner = await f.person(),
      reader = await f.person();
    const id = testShortId(),
      item = testShortId();
    for (const person of [owner, reader]) {
      grant(person, "spaces.space", id, { name: "Project", permission: person === owner ? "write" : "read" });
      grant(person, "spaces.item", item, { title: "Discuss", kind: "task", spaceId: id });
    }
    const chat = await open(owner, id);
    await open(reader, id);
    const discussion = await thread(owner, chat.id, item);
    const message = MessageViewSchema.parse(
      await (
        await f.request(owner.headers, `/${chat.id}/messages`, "POST", {
          clientId: "system-reactions",
          body: "Discuss this item",
          thread: discussion.id,
        })
      ).json(),
    );
    expect(message.reactions).toEqual([]);
    const path = `/${chat.id}/messages/${message.id}/reactions/${encodeURIComponent("👍")}`;
    expect((await f.request(reader.headers, path, "PUT")).status).toBe(204);
    const own = [{ emoji: "👍", count: 1, own: true }];
    for (const person of [owner, reader]) {
      const expected = person === reader ? own : [{ emoji: "👍", count: 1, own: false }];
      const single = MessageViewSchema.parse(await (await f.request(person.headers, `/${chat.id}/messages/${message.id}`)).json());
      expect(single.reactions).toEqual(expected);
      const snapshot = ChatSnapshotSchema.parse(
        await (await f.request(person.headers, `/${chat.id}/snapshot?thread=${discussion.id}`)).json(),
      );
      expect(snapshot.page.items.find((row) => row.id === message.id)?.reactions).toEqual(expected);
      const page = MessagePageSchema.parse(await (await f.request(person.headers, `/${chat.id}/messages?thread=${discussion.id}`)).json());
      expect(page.items.find((row) => row.id === message.id)?.reactions).toEqual(expected);
      const changes = ChangesPageSchema.parse(await (await f.request(person.headers, `/${chat.id}/changes?afterRev=0`)).json());
      expect(changes.messages.find((row) => row.id === message.id)?.reactions).toEqual(expected);
    }
    const events = await sql<{ ordering_key: string; payload: unknown }[]>`SELECT ordering_key, payload FROM events.outbox
      WHERE app_id = 'chat' AND ordering_key = ${`t:${chat.id}:${discussion.id}`}`;
    const hint = events.find((row) => JSON.stringify(row.payload).includes('"reactions"'));
    expect(hint).toBeDefined();
    expect(JSON.stringify(hint!.payload)).not.toContain('"own"');
    expect(JSON.stringify(hint!.payload)).not.toContain('"people"');
    expect((await f.request(reader.headers, path, "DELETE")).status).toBe(204);
    expect(MessageViewSchema.parse(await (await f.request(reader.headers, `/${chat.id}/messages/${message.id}`)).json()).reactions).toEqual(
      [],
    );
  });

  test("caches for 60 seconds, closes all reads after expiration/revocation, and closes on app failure", async () => {
    const person = await f.person();
    const id = testShortId();
    grant(person, "spaces.space", id, { name: "Project", permission: "manage" });
    const chat = await open(person, id);
    const ttl = Number(await redis.send("TTL", [key(person, "spaces.space", id)]));
    expect(ttl).toBeGreaterThan(55);
    expect(ttl).toBeLessThanOrEqual(60);
    revoke(person, "spaces.space", id);
    expect((await f.request(person.headers, `/${chat.id}`)).status).toBe(200);
    await expire(person, "spaces.space", id);
    for (const path of ["", "/snapshot", "/threads", "/shared", "/messages", "/changes?afterRev=0", "/members"])
      expect((await f.request(person.headers, `/${chat.id}${path}`)).status).toBe(404);
    expect((await chatLiveChannels.conversation.authorize(`c:${chat.id}`, [viewer(person)])).size).toBe(0);
    expect((await f.request(person.headers, "")).status).toBe(200);
    expect(await (await f.request(person.headers, "")).text()).not.toContain(chat.id);
    await expire(person, "spaces.space", id);
    down = true;
    expect((await api(person, `/system-chats/spaces.space/${id}/open`, "POST")).status).toBe(404);
  });

  test("unread starts at first open and General sends use a null thread", async () => {
    const owner = await f.person(),
      guest = await f.person();
    const id = testShortId();
    for (const person of [owner, guest]) grant(person, "notebooks.notebook", id, { name: "Book", permission: "write" });
    const chat = await open(owner, id, "notebooks.notebook");
    for (const clientId of ["before-1", "before-2"])
      expect((await f.request(owner.headers, `/${chat.id}/messages`, "POST", { clientId, body: "before" })).status).toBe(201);
    expect((await open(guest, id, "notebooks.notebook")).read?.joinedSeq).toBe(2);
    const response = await f.request(owner.headers, `/${chat.id}/messages`, "POST", { clientId: "after", body: "after" });
    expect(MessageViewSchema.parse(await response.json()).thread).toBeNull();
    const result = await open(guest, id, "notebooks.notebook");
    expect(result.unread).toBe(1);
    expect(result.read?.joinedSeq).toBe(2);
    const history = await f.request(guest.headers, `/${chat.id}/messages`);
    const before = (await history.json()).items[0];
    expect((await f.request(guest.headers, `/${chat.id}/unread`, "POST", { message: before.id })).status).toBe(200);
    expect((await open(guest, id, "notebooks.notebook")).unread).toBe(1);
    const marked = await f.request(guest.headers, "/read-all", "POST", { confirmed: true });
    expect(marked.status).toBe(200);
    expect((await open(guest, id, "notebooks.notebook")).unread).toBe(0);
    await reconcile({ signal: new AbortController().signal, heartbeat: () => {} });
    expect((await open(guest, id, "notebooks.notebook")).read?.joinedSeq).toBe(2);

    const note = testShortId();
    grant(owner, "notebooks.note", note, { title: "Note", notebookId: id });
    expect((await thread(owner, chat.id, note, "notebooks.note")).resource?.kind).toBe("note");
  });
  test("standalone and agent credentials use their own reader and retain read-only scope caps", async () => {
    const headers = await f.credential();
    const id = testShortId();
    replies.set(`${headers.authorization}:spaces.space:${id}`, {
      data: { id, name: "For credential", permission: "manage" },
      links: [{ rel: "open", href: "/space" }],
    });
    const response = await api({ headers }, `/system-chats/spaces.space/${id}/open`, "POST");
    expect(response.status).toBe(200);
    const chat = ConversationSchema.parse(await response.json());
    f.trackChat(chat.id);
    expect(chat.permission).toBe("read");
    expect((await f.request(headers, `/${chat.id}/messages`, "POST", { clientId: "read-only", body: "forbidden" })).status).toBe(403);
    const [account] = await sql<{ created_by_id: string }[]>`SELECT created_by_id FROM chat.conversations WHERE short_id = ${chat.id}`;
    expect(account).toBeDefined();
    const cacheKey = accessKey(`service_account:${account!.created_by_id}:scopes=openid,read`, { type: "spaces.space", id });
    keys.add(cacheKey);
    await sql`UPDATE auth.service_accounts SET kind = 'agent' WHERE id = ${account!.created_by_id}::uuid`;
    await redis.send("DEL", [cacheKey]);
    expect((await f.request(headers, `/${chat.id}`)).status).toBe(200);
    expect(
      (await f.request(headers, `/${chat.id}/threads/for-resource`, "POST", { ref: { type: "spaces.item", id: testShortId() } })).status,
    ).toBe(403);
    expect(
      calls.filter((call) => call.capability === "spaces.space.read").every((call) => call.caller === headers.authorization),
    ).toBeTrue();
  });

  test("item revocation expires in Valkey and metadata/filter results follow the reader", async () => {
    const person = await f.person(),
      id = testShortId(),
      item = testShortId();
    grant(person, "spaces.space", id, { name: "Space", permission: "write" });
    grant(person, "spaces.item", item, { title: "Before", kind: "task", spaceId: id, columnId: "todo01", completedAt: null });
    const chat = await open(person, id),
      first = await thread(person, chat.id, item);
    grant(person, "spaces.item", item, {
      title: "After",
      description: "Updated",
      kind: "task",
      spaceId: id,
      columnId: "done01",
      completedAt: "2026-10-01T12:00:00Z",
    });
    await expire(person, "spaces.item", item);
    const done = ThreadListSchema.parse(await (await f.request(person.headers, `/${chat.id}/threads?filter=done&q=After`)).json());
    expect(done.items[0]).toMatchObject({
      id: first.id,
      name: "After",
      description: "Updated",
      resource: { done: true, status: "done01" },
    });
    expect(ThreadListSchema.parse(await (await f.request(person.headers, `/${chat.id}/threads?filter=open`)).json()).items).toEqual([]);
    revoke(person, "spaces.item", item);
    await expire(person, "spaces.item", item);
    expect((await chatLiveChannels.conversation.authorize(`t:${chat.id}:${first.id}`, [viewer(person)])).size).toBe(0);
    expect(ThreadListSchema.parse(await (await f.request(person.headers, `/${chat.id}/threads`)).json()).items).toEqual([]);
  });

  test("pages system threads by activity beyond the manual limit and advances through fully hidden pages", async () => {
    const person = await f.person(),
      id = testShortId();
    grant(person, "spaces.space", id, { name: "Space", permission: "write" });
    const chat = await open(person, id);
    // Bulk setup exercises the real page/read seam without 101 HTTP writes.
    for (let index = 0; index < 101; index++) {
      const shortId = `p${String(100 - index).padStart(5, "0")}`;
      const item = `i${String(index).padStart(5, "0")}`;
      key(person, "spaces.item", item);
      if (index === 100) grant(person, "spaces.item", item, { title: "Visible", kind: "task", spaceId: id });
      await sql`INSERT INTO chat.threads (short_id, conversation_id, name, created_by_type, created_by_id, resource_type, resource_id, last_activity_at)
        SELECT ${shortId}, c.id, 'Same item title', 'user', ${person.id}::uuid, 'spaces.item', ${item}, ${new Date(Date.UTC(2026, 9, 14, 12) - index * 60_000)} FROM chat.conversations c WHERE c.short_id = ${chat.id}`;
    }
    const first = ThreadListSchema.parse(await (await f.request(person.headers, `/${chat.id}/threads`)).json());
    expect(first.items).toEqual([]);
    expect(first.nextCursor).toBe("p00001");
    const next = ThreadListSchema.parse(await (await f.request(person.headers, `/${chat.id}/threads?cursor=${first.nextCursor}`)).json());
    expect(next.items.map((item) => item.id)).toEqual(["p00000"]);
    expect(next.nextCursor).toBeNull();
    const secondReads = calls.filter((call) => call.capability === "spaces.item.read");
    expect(secondReads.length).toBe(101);
  });
  test("General and a selected thread do not read unrelated items, including snapshots and shared history", async () => {
    const person = await f.person(),
      space = testShortId(),
      item = testShortId();
    grant(person, "spaces.space", space, { name: "Space", permission: "write" });
    grant(person, "spaces.item", item, { title: "Selected", kind: "task", spaceId: space });
    const chat = await open(person, space);
    const selected = await thread(person, chat.id, item);
    await sql`INSERT INTO chat.threads (short_id, conversation_id, name, created_by_type, created_by_id, resource_type, resource_id)
      SELECT 'b' || lpad(n::text, 5, '0'), c.id, 'Hidden', 'user', ${person.id}::uuid, 'spaces.item', 'x' || lpad(n::text, 5, '0')
      FROM chat.conversations c CROSS JOIN generate_series(1, 1000) n WHERE c.short_id = ${chat.id}`;
    for (const endpoint of ["messages", "shared", "snapshot"]) {
      for (const selector of ["general", selected.id]) {
        await expire(person, "spaces.space", space);
        await expire(person, "spaces.item", item);
        calls.length = 0;
        expect((await f.request(person.headers, `/${chat.id}/${endpoint}?thread=${selector}`)).status).toBe(200);
        expect(calls.length).toBe(selector === "general" ? 1 : 2);
      }
    }
  });

  test("summary traversal shares one request budget across large containers and continues counts", async () => {
    const person = await f.person(),
      author = await f.person();
    const containers = [];
    for (let c = 0; c < 3; c++) {
      const space = testShortId();
      grant(person, "spaces.space", space, { name: "Space", permission: "write" });
      const chat = await open(person, space);
      containers.push({ id: space, name: "Space", permission: "write", chat: chat.id });
      for (let n = 0; n < SUMMARY_TRAVERSAL_BUDGET + 1; n++) {
        const item = testShortId(),
          shortId = `${c}${String(n).padStart(5, "0")}`;
        grant(person, "spaces.item", item, { title: "Item", kind: "task", spaceId: space });
        await sql`INSERT INTO chat.threads (short_id, conversation_id, name, created_by_type, created_by_id, resource_type, resource_id)
          SELECT ${shortId}, id, 'Item', 'user', ${person.id}::uuid, 'spaces.item', ${item} FROM chat.conversations WHERE short_id = ${chat.id}`;
      }
      await sql`INSERT INTO chat.messages (short_id, conversation_id, seq, rev, kind, author_type, author_id, author_name, body_md, client_id)
        SELECT ${`g${String(c).padStart(9, "0")}`}, id, 1, 1, 'text', 'user', ${author.id}::uuid, 'Author', 'General', 'general'
        FROM chat.conversations WHERE short_id = ${chat.id}`;
      await sql`UPDATE chat.conversations SET seq_head = 1, rev = 1 WHERE short_id = ${chat.id}`;
      await expire(person, "spaces.space", space);
    }
    replies.set(`${credential(person)}:spaces.space.list`, { data: containers });
    calls.length = 0;
    const result = SystemChatPageSchema.parse(await (await api(person, "/system-chats")).json());
    expect(calls.length).toBe(2 + containers.length + SUMMARY_TRAVERSAL_BUDGET);
    expect(calls.length).toBeLessThanOrEqual(READER_REQUEST_BUDGET);
    expect(result.items.map((entry) => entry.conversation?.unread)).toEqual([1, 0, 0]);
    expect(result.items.map((entry) => entry.conversation?.threads)).toEqual([SUMMARY_TRAVERSAL_BUDGET, 0, 0]);
    expect(result.items.map((entry) => entry.conversation?.summaryCursor)).toEqual(["000099", "", ""]);
    calls.length = 0;
    const next = ConversationSchema.parse(await (await f.request(person.headers, `/${containers[0]!.chat}?summaryCursor=000099`)).json());
    expect(next.threads).toBe(1);
    expect(next.unread).toBe(0);
    expect(next.summaryCursor).toBeNull();
    expect(calls.length).toBe(1);
  });

  test("fully hidden read-all candidates consume one page and return a progressing cursor", async () => {
    const person = await f.person(),
      author = await f.person();
    // No readable container: a cold cache still spends at most READ_ALL_BATCH readers.
    for (let n = 0; n < 51; n++) {
      const chat = await f.fixture(person),
        resource = testShortId();
      key(person, "spaces.space", resource);
      await sql`UPDATE chat.conversations SET kind = 'system', resource_type = 'spaces.space', resource_id = ${resource},
        last_activity_at = '2026-10-01T00:00:00Z', seq_head = 1, rev = 1 WHERE id = ${chat.id}::uuid`;
      await sql`INSERT INTO chat.messages (short_id, conversation_id, seq, rev, kind, author_type, author_id, author_name, body_md, client_id)
        VALUES (${`r${String(n).padStart(9, "0")}`}, ${chat.id}::uuid, 1, 1, 'text', 'user', ${author.id}::uuid, 'Author', 'Hidden', ${`hidden-${n}`})`;
    }
    calls.length = 0;
    const first = ReadAllOutcomeSchema.parse(await (await f.request(person.headers, "/read-all", "POST", { confirmed: true })).json());
    expect(first).toMatchObject({ outcome: "done", marked: 0, more: true });
    expect(calls.length).toBe(50);
    if (first.outcome !== "done") throw new Error("Expected completed page");
    calls.length = 0;
    const next = ReadAllOutcomeSchema.parse(
      await (await f.request(person.headers, "/read-all", "POST", { confirmed: true, cursor: first.nextCursor })).json(),
    );
    expect(next).toMatchObject({ outcome: "done", marked: 0, more: false, nextCursor: null });
    expect(calls.length).toBe(1);
  });

  test("hidden history, changes, shared items and read-all thread pages preserve continuation", async () => {
    const author = await f.person(),
      person = await f.person(),
      space = testShortId();
    grant(person, "spaces.space", space, { name: "Space", permission: "write" });
    const chat = await open(person, space);
    let lastItem = "";
    for (let n = 0; n < 101; n++) {
      const item = testShortId(),
        shortId = `h${String(n).padStart(5, "0")}`;
      lastItem = item;
      key(person, "spaces.item", item);
      await sql`INSERT INTO chat.threads (short_id, conversation_id, name, created_by_type, created_by_id, resource_type, resource_id)
        SELECT ${shortId}, id, 'Hidden', 'user', ${person.id}::uuid, 'spaces.item', ${item} FROM chat.conversations WHERE short_id = ${chat.id}`;
      await sql`INSERT INTO chat.messages (short_id, conversation_id, seq, rev, kind, author_type, author_id, author_name, body_md, client_id, thread_id, links)
        SELECT ${`m${String(n).padStart(9, "0")}`}, conversation_id, ${n + 1}, ${n + 1}, 'text', 'user', ${author.id}::uuid, 'Person', 'Hidden', ${`hidden-${n}`}, id,
        ARRAY['https://example.com'] FROM chat.threads WHERE short_id = ${shortId}`;
    }
    await sql`UPDATE chat.conversations SET seq_head = 101, rev = 101 WHERE short_id = ${chat.id}`;
    calls.length = 0;
    const first = MessagePageSchema.parse(await (await f.request(person.headers, `/${chat.id}/messages`)).json());
    expect(first.items).toEqual([]);
    expect(first.from).toBe(52);
    expect(calls.length).toBe(50);
    const next = MessagePageSchema.parse(await (await f.request(person.headers, `/${chat.id}/messages?before=${first.from}`)).json());
    expect(next.items).toEqual([]);
    expect(next.from).toBe(2);
    const changes = ChangesPageSchema.parse(await (await f.request(person.headers, `/${chat.id}/changes?afterRev=0`)).json());
    expect(changes.messages).toEqual([]);
    expect(changes.rev).toBe(101);
    const shared = SharedPageSchema.parse(await (await f.request(person.headers, `/${chat.id}/shared`)).json());
    expect(shared.items).toEqual([]);
    expect(shared.nextCursor).not.toBeNull();
    for (const cacheKey of keys) await redis.del(cacheKey);
    calls.length = 0;
    const read = ReadAllOutcomeSchema.parse(await (await f.request(person.headers, "/read-all", "POST", { confirmed: true })).json());
    expect(read).toMatchObject({ outcome: "done", marked: 0, more: true });
    expect(calls.length).toBe(1 + SUMMARY_TRAVERSAL_BUDGET);
    if (read.outcome !== "done") throw new Error("Expected completed page");
    calls.length = 0;
    const done = ReadAllOutcomeSchema.parse(
      await (await f.request(person.headers, "/read-all", "POST", { confirmed: true, cursor: read.nextCursor })).json(),
    );
    expect(done).toMatchObject({ outcome: "done", marked: 0, more: false });
    expect(calls.length).toBe(1);
    // A later authorized item on a resumed page is marked; hidden items stay untouched.
    grant(person, "spaces.item", lastItem, { title: "Now readable", kind: "task", spaceId: space });
    await expire(person, "spaces.item", lastItem);
    const resumed = ReadAllOutcomeSchema.parse(
      await (await f.request(person.headers, "/read-all", "POST", { confirmed: true, cursor: read.nextCursor })).json(),
    );
    expect(resumed).toMatchObject({ outcome: "done", marked: 1, more: false });
    const marked = await sql<{ short_id: string; last_read_seq: string }[]>`SELECT t.short_id, tr.last_read_seq FROM chat.thread_reads tr
      JOIN chat.threads t ON t.id = tr.thread_id JOIN chat.conversations c ON c.id = t.conversation_id
      WHERE c.short_id = ${chat.id} AND tr.principal_id = ${person.id}::uuid`;
    expect(marked.map((row) => row.short_id)).toEqual(["h00100"]);
    expect(Number(marked[0]!.last_read_seq)).toBe(101);
  });

  test("concurrent open and item-thread retries allocate one row", async () => {
    const person = await f.person(),
      id = testShortId(),
      item = testShortId();
    grant(person, "spaces.space", id, { name: "Space", permission: "write" });
    grant(person, "spaces.item", item, { title: "Task", kind: "task", spaceId: id });
    const opened = await Promise.all(Array.from({ length: 8 }, () => open(person, id)));
    expect(new Set(opened.map((entry) => entry.id)).size).toBe(1);
    const threads = await Promise.all(Array.from({ length: 8 }, () => thread(person, opened[0]!.id, item)));
    expect(new Set(threads.map((entry) => entry.id)).size).toBe(1);
  });
  test("Chat grants cannot bypass a system container reader, including the ordinary sidebar", async () => {
    const person = await f.person(),
      resourceId = testShortId();
    const chat = await f.fixture(person);
    key(person, "spaces.space", resourceId);
    // Deliberately retain an old Chat grant to prove the second access source cannot be bypassed.
    await sql`UPDATE chat.conversations SET kind = 'system', resource_type = 'spaces.space', resource_id = ${resourceId} WHERE id = ${chat.id}::uuid`;
    for (const path of ["", "/snapshot", "/threads", "/shared", "/members", "/messages"])
      expect((await f.request(person.headers, `/${chat.shortId}${path}`)).status).toBe(404);
    expect(await (await f.request(person.headers, "")).text()).not.toContain(chat.shortId);
    expect((await chatLiveChannels.conversation.authorize(`c:${chat.shortId}`, [viewer(person)])).size).toBe(0);
  });
});
