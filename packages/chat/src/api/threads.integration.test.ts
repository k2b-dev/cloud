import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { createAccess } from "@k2b/cloud/server";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { requireConversation } from "../service/access";
import {
  ChatLiveEventSchema,
  ChatSnapshotSchema,
  ConversationSchema,
  MAX_THREADS,
  MESSAGE_PAGE_SIZE,
  MemberPageSchema,
  MessagePageSchema,
  MessageViewSchema,
  ReadAllOutcomeSchema,
  ReadUpdateSchema,
  ThreadListSchema,
  ThreadSchema,
} from "../service/contracts";
import { appendMessage } from "../service/message-store";
import { messageFixtures, type Person } from "./messages.test-fixture";

setDefaultTimeout(120_000);
const suite = suiteFor("database", "nats", "valkey");
suite("chat threads API", () => {
  const f = messageFixtures();
  const accounts: string[] = [];
  afterAll(async () => {
    for (const id of accounts) {
      await sql`DELETE FROM events.outbox WHERE app_id = 'chat' AND ordering_key = ${`p:${id}`}`;
      await sql`DELETE FROM audit.events WHERE target_id = ${id} OR actor_uid = ${id} OR metadata->>'serviceAccountId' = ${id}`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
    }
  });
  const create = async (person: Person, chat: string, name: string, extra = {}) => {
    const response = await f.request(person.headers, `/${chat}/threads`, "POST", { name, ...extra });
    expect(response.status).toBe(201);
    return ThreadSchema.parse(await response.json());
  };
  const list = async (person: Person, chat: string) => {
    const response = await f.request(person.headers, `/${chat}/threads`);
    expect(response.status).toBe(200);
    return ThreadListSchema.parse(await response.json());
  };
  const detail = async (person: Person, chat: string) =>
    ConversationSchema.parse(await (await f.request(person.headers, `/${chat}`)).json());
  const send = async (person: Person, chat: string, extra = {}) => {
    const response = await f.request(person.headers, `/${chat}/messages`, "POST", {
      clientId: crypto.randomUUID(),
      body: "Hello **thread**",
      ...extra,
    });
    expect(response.status).toBe(201);
    return MessageViewSchema.parse(await response.json());
  };
  const read = async (person: Person, chat: string, seq: number, thread?: string) => {
    const response = await f.request(person.headers, `/${chat}/read`, "POST", { seq, ...(thread ? { thread } : {}) });
    expect(response.status).toBe(200);
    return ReadUpdateSchema.parse(await response.json());
  };
  const patch = async (person: Person, chat: string, thread: string, body: unknown) => {
    const response = await f.request(person.headers, `/${chat}/threads/${thread}`, "PATCH", body);
    expect(response.status).toBe(200);
    return ThreadSchema.parse(await response.json());
  };
  const events = async (key: string) => {
    const rows = await sql<
      { payload: unknown }[]
    >`SELECT payload FROM events.outbox WHERE app_id = 'chat' AND ordering_key = ${key} ORDER BY seq`;
    return rows.map((row) => z.object({ d: ChatLiveEventSchema }).parse(row.payload).d);
  };

  test("admin creates once per intent; General gets the localized system message and readers cannot manage", async () => {
    const owner = await f.person("Nora"),
      writer = await f.person(),
      reader = await f.person(),
      stranger = await f.person();
    const chat = await f.fixture(owner, [
      { person: writer, permission: "write" },
      { person: reader, permission: "read" },
    ]);
    const createKey = crypto.randomUUID();
    const thread = await create(owner, chat.shortId, " Problemfälle ", { description: "  Follow up  ", createKey });
    expect(thread).toMatchObject({
      name: "Problemfälle",
      description: "Follow up",
      archived: false,
      unread: 0,
      read: null,
      lastMessage: null,
    });
    const replay = await f.request(owner.headers, `/${chat.shortId}/threads`, "POST", {
      name: "Problemfälle",
      description: "Follow up",
      createKey: createKey.toUpperCase(),
    });
    expect(replay.status).toBe(200);
    expect(ThreadSchema.parse(await replay.json()).id).toBe(thread.id);
    const conflict = await f.request(owner.headers, `/${chat.shortId}/threads`, "POST", { name: "Different", createKey });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe("CONFLICT");
    const other = await f.fixture(owner);
    expect(
      (await f.request(owner.headers, `/${other.shortId}/threads`, "POST", { name: "Problemfälle", description: "Follow up", createKey }))
        .status,
    ).toBe(409);
    const page = MessagePageSchema.parse(await (await f.request(owner.headers, `/${chat.shortId}/messages?thread=general`)).json());
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      thread: null,
      system: { code: "thread_created", params: { thread: { id: thread.id, name: thread.name } } },
      systemText: "Nora created the thread “Problemfälle”",
    });
    const de = MessagePageSchema.parse(
      await (await f.request({ ...owner.headers, "accept-language": "de" }, `/${chat.shortId}/messages`)).json(),
    );
    expect(de.items[0]!.systemText).toBe("Nora hat den Thread „Problemfälle“ angelegt");
    expect(await list(reader, chat.shortId)).toMatchObject({
      general: { unread: 0, lastMessage: null },
      items: [{ id: thread.id, unread: 0 }],
    });
    expect((await detail(reader, chat.shortId)).threads).toBe(1);
    for (const person of [writer, reader]) {
      expect((await f.request(person.headers, `/${chat.shortId}/threads`, "POST", { name: "Denied" })).status).toBe(403);
      expect((await f.request(person.headers, `/${chat.shortId}/threads/${thread.id}`, "PATCH", { archived: true })).status).toBe(403);
    }
    expect((await f.request(stranger.headers, `/${chat.shortId}/threads`)).status).toBe(404);
    expect((await events(`c:${chat.shortId}`)).filter((event) => event.type === "threads")).toHaveLength(1);
  });

  test("agent admins follow the same grants and scope caps and can author system messages and replies", async () => {
    const owner = await f.person();
    const chat = await f.fixture(owner);
    const [account] = await sql<
      { id: string }[]
    >`INSERT INTO auth.service_accounts (name, kind) VALUES ('Thread agent', 'agent') RETURNING id`;
    accounts.push(account!.id);
    const access = await createAccess({ principal: { type: "service_account", serviceAccountId: account!.id }, permission: "admin" });
    if (!access.ok) throw new Error(access.error.message);
    await sql`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id)
      VALUES (${chat.id}::uuid, ${access.data.id}::uuid, 'member', 'user', ${owner.id}::uuid)`;
    const credential = async (scope: string) => {
      const token = await serviceAccountCredentials.createApiToken({
        serviceAccountId: account!.id,
        name: "threads",
        scopes: ["openid", scope],
      });
      if (!token.ok) throw new Error(token.error.message);
      return { authorization: `Bearer ${token.data.token}` };
    };
    const headers = await credential("admin");
    const createKey = crypto.randomUUID();
    const response = await f.request(headers, `/${chat.shortId}/threads`, "POST", { name: "Agent work", createKey });
    expect(response.status).toBe(201);
    const thread = ThreadSchema.parse(await response.json());
    expect((await f.request(headers, `/${chat.shortId}/threads`, "POST", { name: "Agent work", createKey })).status).toBe(200);
    for (const scope of ["read", "write"])
      expect((await f.request(await credential(scope), `/${chat.shortId}/threads`, "POST", { name: scope })).status).toBe(403);
    const sent = await f.request(headers, `/${chat.shortId}/messages`, "POST", {
      clientId: "agent-send",
      body: "Agent message",
      thread: thread.id,
    });
    expect(sent.status).toBe(201);
    expect(MessageViewSchema.parse(await sent.json())).toMatchObject({
      author: { type: "service_account", id: account!.id, name: "Thread agent" },
      thread: thread.id,
    });
    expect((await list(owner, chat.shortId)).items[0]!.unread).toBe(1);
    expect((await f.request(headers, `/${chat.shortId}/read`, "POST", { seq: 2, thread: "all" })).status).toBe(200);
  });

  test("names stay unique across archives, metadata changes emit hints, and restore permits writing", async () => {
    const owner = await f.person();
    const chat = await f.fixture(owner),
      other = await f.fixture(owner);
    const a = await create(owner, chat.shortId, "Alpha"),
      b = await create(owner, chat.shortId, "Beta");
    const duplicate = await f.request(owner.headers, `/${chat.shortId}/threads`, "POST", { name: "ALPHA" });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).code).toBe("THREAD_NAME_TAKEN");
    expect((await f.request(owner.headers, `/${chat.shortId}/threads/${b.id}`, "PATCH", { name: "alpha" })).status).toBe(409);
    expect((await f.request(owner.headers, `/${other.shortId}/threads/${a.id}`, "PATCH", { name: "Foreign" })).status).toBe(404);
    expect((await f.request(owner.headers, `/${chat.shortId}/threads/general`, "PATCH", { archived: true })).status).toBe(400);
    expect(await patch(owner, chat.shortId, a.id, { name: "Renamed", description: " Note " })).toMatchObject({
      name: "Renamed",
      description: "Note",
    });
    expect(await patch(owner, chat.shortId, a.id, { archived: true, description: " " })).toMatchObject({
      archived: true,
      description: null,
    });
    // Archived threads still count, so a chat whose last active thread is archived keeps its thread controls.
    expect((await detail(owner, chat.shortId)).threads).toBe(2);
    expect((await list(owner, chat.shortId)).items.map((row) => row.id)).toEqual([b.id, a.id]);
    expect((await f.request(owner.headers, `/${chat.shortId}/threads`, "POST", { name: "RENAMED" })).status).toBe(409);
    const rejected = await f.request(owner.headers, `/${chat.shortId}/messages`, "POST", {
      clientId: "archived",
      body: "No",
      thread: a.id,
    });
    expect(rejected.status).toBe(409);
    expect((await rejected.json()).code).toBe("THREAD_ARCHIVED");
    await patch(owner, chat.shortId, a.id, { archived: false });
    const sent = await send(owner, chat.shortId, { thread: a.id });
    expect((await list(owner, chat.shortId)).items[0]).toMatchObject({ id: a.id, lastActivityAt: sent.createdAt });
    expect((await events(`c:${chat.shortId}`)).filter((event) => event.type === "threads")).toHaveLength(5);
  });

  test("the bound includes archived threads and channels cannot create threads", async () => {
    const owner = await f.person();
    const chat = await f.fixture(owner);
    await sql`INSERT INTO chat.threads (short_id, conversation_id, name, archived_at, created_by_type, created_by_id)
      SELECT lpad(i::text, 6, '0'), ${chat.id}::uuid, 'Thread ' || i, '2026-01-01'::timestamptz, 'user', ${owner.id}::uuid
      FROM generate_series(1, ${MAX_THREADS}) i`;
    const limited = await f.request(owner.headers, `/${chat.shortId}/threads`, "POST", { name: "Too many" });
    expect(limited.status).toBe(409);
    expect((await limited.json()).code).toBe("THREAD_LIMIT");
    expect((await list(owner, chat.shortId)).items).toHaveLength(MAX_THREADS);
    const channel = await f.fixture(owner);
    await sql`UPDATE chat.conversation_access SET role = 'discoverable' WHERE conversation_id = ${channel.id}::uuid`;
    const unavailable = await f.request(owner.headers, `/${channel.shortId}/threads`, "POST", { name: "No" });
    expect(unavailable.status).toBe(409);
    expect((await unavailable.json()).code).toBe("THREADS_UNAVAILABLE");
  });

  test("replies inherit the original thread, survive deleted originals, and retain clientId idempotency", async () => {
    const owner = await f.person("Nora"),
      reader = await f.person();
    const chat = await f.fixture(owner, [{ person: reader, permission: "read" }]),
      other = await f.fixture(owner);
    const a = await create(owner, chat.shortId, "A"),
      b = await create(owner, chat.shortId, "B");
    const original = await send(owner, chat.shortId, { thread: a.id, body: "Original\ntext" });
    const reply = await send(owner, chat.shortId, { replyTo: original.id, clientId: "reply" });
    expect(reply).toMatchObject({ thread: a.id, replyTo: { id: original.id, author: original.author, preview: "Original text" } });
    expect((await detail(reader, chat.shortId)).lastMessage).toMatchObject({
      id: reply.id,
      thread: { id: a.id, name: "A" },
      preview: "Hello **thread**",
    });
    const foreign = await send(owner, other.shortId);
    for (const [extra, status] of [
      [{ thread: b.id, replyTo: original.id }, 400],
      [{ replyTo: foreign.id }, 404],
      [{ thread: "zzzzzz" }, 404],
    ] as const) {
      expect(
        (await f.request(owner.headers, `/${chat.shortId}/messages`, "POST", { clientId: crypto.randomUUID(), body: "No", ...extra }))
          .status,
      ).toBe(status);
    }
    await patch(owner, chat.shortId, a.id, { archived: true });
    expect(
      (
        await f.request(owner.headers, `/${chat.shortId}/messages`, "POST", {
          clientId: "archived-reply",
          body: "No",
          replyTo: original.id,
        })
      ).status,
    ).toBe(409);
    const retry = await f.request(owner.headers, `/${chat.shortId}/messages`, "POST", { clientId: "reply", body: "changed", thread: b.id });
    expect(retry.status).toBe(200);
    expect(MessageViewSchema.parse(await retry.json()).id).toBe(reply.id);
    await sql`DELETE FROM chat.messages WHERE conversation_id = ${chat.id}::uuid AND short_id = ${original.id}`;
    const projected = MessageViewSchema.parse(await (await f.request(reader.headers, `/${chat.shortId}/messages/${reply.id}`)).json());
    expect(projected.replyTo).toEqual({ deleted: true });
    const general = MessagePageSchema.parse(await (await f.request(owner.headers, `/${chat.shortId}/messages?thread=general`)).json());
    const systemReply = await send(owner, chat.shortId, { replyTo: general.items[0]!.id });
    expect(systemReply.thread).toBeNull();
    expect(systemReply.replyTo).toMatchObject({ preview: "Nora created the thread “A”" });
    const live = await events(`c:${chat.shortId}`);
    expect(live.find((event) => event.type === "message" && event.message.id === reply.id)).toMatchObject({
      type: "message",
      message: { thread: a.id, replyTo: reply.replyTo },
    });
  });

  test("history and snapshots filter each strand with bounded pages; changes remain whole-chat", async () => {
    const owner = await f.person(),
      reader = await f.person();
    const chat = await f.fixture(owner, [{ person: reader, permission: "read" }]);
    const thread = await create(owner, chat.shortId, "History");
    const [dbThread] = await sql<{ id: string }[]>`SELECT id FROM chat.threads WHERE short_id = ${thread.id}`;
    await sql.begin(async (db) => {
      await db`SELECT id FROM chat.conversations WHERE id = ${chat.id}::uuid FOR UPDATE`;
      const allowed = await requireConversation({ ...owner.context, conversationId: chat.shortId, required: "write" }, db);
      if (!allowed.ok) throw new Error(allowed.error.message);
      for (let i = 0; i < 120; i++)
        await appendMessage(db, allowed.data, owner.context, {
          kind: "text",
          clientId: `history-${i}`,
          body: `Message ${i}`,
          ...(i % 2 ? { threadId: dbThread!.id } : {}),
        });
    });
    for (const selector of [thread.id, "general", undefined]) {
      const query = selector ? `?thread=${selector}` : "";
      const page = MessagePageSchema.parse(await (await f.request(reader.headers, `/${chat.shortId}/messages${query}`)).json());
      expect(page.items).toHaveLength(MESSAGE_PAGE_SIZE);
      if (selector) expect(page.items.every((message) => message.thread === (selector === "general" ? null : selector))).toBeTrue();
      const snapshot = ChatSnapshotSchema.parse(await (await f.request(reader.headers, `/${chat.shortId}/snapshot${query}`)).json());
      expect(snapshot.page.items.length).toBeLessThanOrEqual(MESSAGE_PAGE_SIZE);
      if (selector)
        expect(snapshot.page.items.every((message) => message.thread === (selector === "general" ? null : selector))).toBeTrue();
      const after = MessagePageSchema.parse(
        await (await f.request(reader.headers, `/${chat.shortId}/messages?after=50${selector ? `&thread=${selector}` : ""}`)).json(),
      );
      expect(after.items.every((message) => message.seq > 50)).toBeTrue();
      expect(after.items.length).toBeLessThanOrEqual(MESSAGE_PAGE_SIZE);
    }
    const all = MessagePageSchema.parse(await (await f.request(reader.headers, `/${chat.shortId}/messages`)).json());
    expect(new Set(all.items.map((message) => message.thread)).size).toBe(2);
    const changes = z
      .object({ messages: z.array(MessageViewSchema) })
      .parse(await (await f.request(reader.headers, `/${chat.shortId}/changes?afterRev=0`)).json());
    expect(changes.messages).toHaveLength(121);
    const linked = all.items.find((message) => message.thread === thread.id)!;
    const mismatch = ChatSnapshotSchema.parse(
      await (await f.request(reader.headers, `/${chat.shortId}/snapshot?thread=general&message=${linked.id}`)).json(),
    );
    expect(mismatch.focus).toBeNull();
    for (const endpoint of ["messages", "snapshot"])
      expect((await f.request(reader.headers, `/${chat.shortId}/${endpoint}?thread=zzzzzz`)).status).toBe(404);
  });

  test("unread counts, read marks and live receipts are isolated per thread, including archived threads", async () => {
    const owner = await f.person(),
      reader = await f.person();
    const chat = await f.fixture(owner, [{ person: reader, permission: "read" }]);
    const a = await create(owner, chat.shortId, "A"),
      b = await create(owner, chat.shortId, "B");
    const general = await send(owner, chat.shortId);
    const a1 = await send(owner, chat.shortId, { thread: a.id }),
      a2 = await send(owner, chat.shortId, { thread: a.id });
    const b1 = await send(owner, chat.shortId, { thread: b.id });
    await patch(owner, chat.shortId, b.id, { archived: true });
    expect((await detail(reader, chat.shortId)).unread).toBe(4);
    expect((await list(reader, chat.shortId)).general.unread).toBe(1);
    expect((await list(reader, chat.shortId)).items.map((row) => row.unread)).toEqual([2, 1]);
    const onlyA = await read(reader, chat.shortId, b1.seq, a.id);
    expect(onlyA).toMatchObject({ lastReadSeq: null, unread: 2, threads: [{ id: a.id, lastReadSeq: b1.seq, unread: 0 }] });
    expect(await read(reader, chat.shortId, b1.seq)).toMatchObject({ unread: 1, threads: [] });
    const markedResponse = await f.request(reader.headers, `/${chat.shortId}/unread`, "POST", { message: a1.id });
    expect(markedResponse.status).toBe(200);
    const marked = ReadUpdateSchema.parse(await markedResponse.json());
    expect(marked).toMatchObject({ unread: 3, unreadFromSeq: null, threads: [{ id: a.id, unreadFromSeq: a1.seq, unread: 2 }] });
    expect(await read(reader, chat.shortId, a1.seq, a.id)).toMatchObject({
      unread: 2,
      threads: [{ unreadFromSeq: a1.seq + 1, unread: 1 }],
    });
    expect(await read(reader, chat.shortId, a2.seq, a.id)).toMatchObject({ unread: 1 });
    const all = await read(reader, chat.shortId, b1.seq, "all");
    expect(all.unread).toBe(0);
    expect(all.threads.some((row) => row.id === b.id && row.unread === 0)).toBeTrue();
    const latest = await f.request(reader.headers, `/${chat.shortId}/unread`, "POST", {});
    expect(ReadUpdateSchema.parse(await latest.json())).toMatchObject({ unread: 1, unreadFromSeq: general.seq, threads: [] });
    expect(await events(`p:${reader.id}`)).toContainEqual({ type: "read", ...marked });
    const cleared = await f.request(reader.headers, "/read-all", "POST", { confirmed: true });
    expect(ReadAllOutcomeSchema.parse(await cleared.json())).toMatchObject({ outcome: "done", marked: 1, more: false });
    expect((await detail(reader, chat.shortId)).unread).toBe(0);
    await f.request(reader.headers, `/${chat.shortId}/unread`, "POST", { message: b1.id });
    const onlyThread = await f.request(reader.headers, "/read-all", "POST", { confirmed: true });
    expect(ReadAllOutcomeSchema.parse(await onlyThread.json())).toMatchObject({ outcome: "done", marked: 1, more: false });
    expect((await list(reader, chat.shortId)).items.every((row) => row.unread === 0)).toBeTrue();
  });

  test("a thread's read state ends with the membership: after removal and a new invitation nothing old is unread", async () => {
    const owner = await f.person(),
      member = await f.person();
    const chat = await f.fixture(owner, [{ person: member, permission: "write" }]);
    const a = await create(owner, chat.shortId, "A");
    const first = await send(owner, chat.shortId, { thread: a.id });
    const second = await send(owner, chat.shortId, { thread: a.id });
    // Only what was read can be marked unread again.
    await read(member, chat.shortId, second.seq, a.id);
    expect((await f.request(member.headers, `/${chat.shortId}/unread`, "POST", { message: first.id })).status).toBe(200);
    const stored = async () =>
      (await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM chat.thread_reads WHERE principal_id = ${member.id}::uuid`)[0]!
        .count;
    expect(await stored()).toBe(1);
    const members = MemberPageSchema.parse(await (await f.request(owner.headers, `/${chat.shortId}/members`)).json()).items;
    const access = members.find((entry) => entry.principal.type === "user" && entry.principal.userId === member.id)!.accessId;
    expect((await f.request(owner.headers, `/${chat.shortId}/members/${access}`, "DELETE")).status).toBe(200);
    expect(await stored()).toBe(0);
    const invited = await f.request(owner.headers, `/${chat.shortId}/members`, "POST", { members: [{ type: "user", userId: member.id }] });
    expect(invited.status).toBe(200);
    expect((await list(member, chat.shortId)).items.map((row) => row.unread)).toEqual([0]);
    expect((await detail(member, chat.shortId)).unread).toBe(0);
  });

  test("without General text mark unread falls back to the latest incoming thread message; no participant means no unread", async () => {
    const owner = await f.person(),
      reader = await f.person();
    const chat = await f.fixture(owner, [{ person: reader, permission: "read" }]);
    const thread = await create(owner, chat.shortId, "Only thread");
    const text = await send(owner, chat.shortId, { thread: thread.id });
    await read(reader, chat.shortId, text.seq, "all");
    const response = await f.request(reader.headers, `/${chat.shortId}/unread`, "POST", {});
    expect(ReadUpdateSchema.parse(await response.json())).toMatchObject({
      unread: 1,
      unreadFromSeq: null,
      threads: [{ id: thread.id, unreadFromSeq: text.seq }],
    });
    await sql`DELETE FROM chat.participants WHERE conversation_id = ${chat.id}::uuid AND principal_id = ${reader.id}::uuid`;
    expect((await detail(reader, chat.shortId)).unread).toBe(0);
    expect((await list(reader, chat.shortId)).items[0]!.unread).toBe(0);
  });

  test("per-thread and total counts cap independently; concurrent reads converge and snapshots use the selected read start", async () => {
    const owner = await f.person(),
      reader = await f.person();
    const chat = await f.fixture(owner, [{ person: reader, permission: "read" }]);
    const a = await create(owner, chat.shortId, "A"),
      b = await create(owner, chat.shortId, "B");
    const threadRows = await sql<
      { id: string; short_id: string }[]
    >`SELECT id, short_id FROM chat.threads WHERE conversation_id = ${chat.id}::uuid`;
    const ids = new Map(threadRows.map((row) => [row.short_id, row.id]));
    await sql.begin(async (db) => {
      await db`SELECT id FROM chat.conversations WHERE id = ${chat.id}::uuid FOR UPDATE`;
      const allowed = await requireConversation({ ...owner.context, conversationId: chat.shortId, required: "write" }, db);
      if (!allowed.ok) throw new Error(allowed.error.message);
      for (let i = 0; i < 240; i++)
        await appendMessage(db, allowed.data, owner.context, {
          kind: "text",
          clientId: `cap-${i}`,
          body: `Incoming ${i}`,
          threadId: ids.get(i < 120 ? a.id : b.id)!,
        });
    });
    expect((await list(reader, chat.shortId)).items.every((row) => row.unread === 100)).toBeTrue();
    expect((await detail(reader, chat.shortId)).unread).toBe(100);
    await read(reader, chat.shortId, 242, "general");
    expect((await detail(reader, chat.shortId)).unread).toBe(100);
    await Promise.all([read(reader, chat.shortId, 80, a.id), read(reader, chat.shortId, 100, a.id)]);
    expect((await list(reader, chat.shortId)).items.find((row) => row.id === a.id)).toMatchObject({
      read: { lastReadSeq: 100 },
      unread: 22,
    });
    expect((await read(reader, chat.shortId, 50, a.id)).threads).toEqual([]);
    const untouched = ChatSnapshotSchema.parse(await (await f.request(reader.headers, `/${chat.shortId}/snapshot?thread=${b.id}`)).json());
    expect(untouched.page.items.some((message) => message.seq === 123)).toBeTrue();
    await read(reader, chat.shortId, 220, b.id);
    const mixed = ChatSnapshotSchema.parse(await (await f.request(reader.headers, `/${chat.shortId}/snapshot`)).json());
    expect(mixed.page.items.some((message) => message.seq === 101)).toBeTrue();
    const selected = ChatSnapshotSchema.parse(await (await f.request(reader.headers, `/${chat.shortId}/snapshot?thread=${b.id}`)).json());
    expect(selected.page.items.some((message) => message.seq === 221)).toBeTrue();
    expect(selected.page.items.every((message) => message.thread === b.id)).toBeTrue();
    await sql.begin(async (db) => {
      await db`SELECT id FROM chat.conversations WHERE id = ${chat.id}::uuid FOR UPDATE`;
      expect((await read(reader, chat.shortId, 230, b.id)).unread).toBe(34);
    });
    await read(reader, chat.shortId, Number.MAX_SAFE_INTEGER, "all");
    expect((await detail(reader, chat.shortId)).unread).toBe(0);
  });

  test("concurrent creates serialize the name and intent without duplicate messages", async () => {
    const owner = await f.person();
    const chat = await f.fixture(owner);
    const createKey = crypto.randomUUID();
    const repeated = await Promise.all(
      [1, 2].map(() => f.request(owner.headers, `/${chat.shortId}/threads`, "POST", { name: "Once", createKey })),
    );
    expect(repeated.map((response) => response.status).sort()).toEqual([200, 201]);
    const records = await Promise.all(repeated.map(async (response) => ThreadSchema.parse(await response.json())));
    expect(records[0]!.id).toBe(records[1]!.id);
    const competing = await Promise.all(
      ["Duplicate", "DUPLICATE"].map((name) => f.request(owner.headers, `/${chat.shortId}/threads`, "POST", { name })),
    );
    expect(competing.map((response) => response.status).sort()).toEqual([201, 409]);
    const page = MessagePageSchema.parse(await (await f.request(owner.headers, `/${chat.shortId}/messages`)).json());
    expect(page.items).toHaveLength(2);
  });
});
