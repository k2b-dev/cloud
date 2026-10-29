import { expect, setDefaultTimeout, test } from "bun:test";
import { toPgTextArray, toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import { requireConversation } from "../service/access";
import {
  ChatSnapshotSchema,
  CONVERSATION_PAGE_SIZE,
  ConversationPageSchema,
  ConversationSchema,
  READ_ALL_BATCH,
  ReadAllOutcomeSchema,
  ReadUpdateSchema,
  UNREAD_TOTAL_CAP,
} from "../service/contracts";
import { appendMessage } from "../service/message-store";
import { unreadQuery } from "../service/read-state";
import { messageFixtures, type Person } from "./messages.test-fixture";

setDefaultTimeout(120_000);
const suite = suiteFor("database", "nats", "valkey");
suite("personal read state", () => {
  const f = messageFixtures();
  const read = async (person: Person, id: string, seq: number) => {
    const response = await f.request(person.headers, `/${id}/read`, "POST", { seq });
    expect(response.status).toBe(200);
    return ReadUpdateSchema.parse(await response.json());
  };
  const mark = async (person: Person, id: string, message?: string) => {
    const response = await f.request(person.headers, `/${id}/unread`, "POST", message ? { message } : {});
    expect(response.status).toBe(200);
    return ReadUpdateSchema.parse(await response.json());
  };
  const detail = async (person: Person, id: string) => ConversationSchema.parse(await (await f.request(person.headers, `/${id}`)).json());
  const snapshot = async (person: Person, id: string, message?: string) => {
    const response = await f.request(person.headers, `/${id}/snapshot${message ? `?message=${message}` : ""}`);
    expect(response.status).toBe(200);
    return ChatSnapshotSchema.parse(await response.json());
  };
  const fill = (person: Person, id: string, count: number) =>
    sql.begin(async (db) => {
      await db`SELECT id FROM chat.conversations WHERE short_id = ${id} FOR UPDATE`;
      const allowed = await requireConversation({ ...person.context, conversationId: id, required: "write" }, db);
      if (!allowed.ok) throw new Error(allowed.error.message);
      const rows = [];
      for (let i = 0; i < count; i++)
        rows.push(
          await appendMessage(db, allowed.data, person.context, { kind: "text", clientId: crypto.randomUUID(), body: `Message ${i}` }),
        );
      return rows;
    });
  const parts = (id: string) =>
    sql<{ row: unknown }[]>`SELECT to_jsonb(p) AS row FROM chat.participants p WHERE conversation_id = ${id}::uuid ORDER BY principal_id`;
  const outbox = (person: Person) =>
    sql<
      { payload: unknown }[]
    >`SELECT payload FROM events.outbox WHERE app_id = 'chat' AND ordering_key = ${"p:" + person.id} ORDER BY seq`;
  const all = async (person: Person, confirmed = false) => {
    const response = await f.request(person.headers, "/read-all", "POST", { confirmed });
    expect(response.status).toBe(200);
    return ReadAllOutcomeSchema.parse(await response.json());
  };

  test("sending preserves earlier unread messages and all participant rows; snapshots never advance them", async () => {
    const viewer = await f.person(),
      other = await f.person();
    const chat = await f.fixture(viewer, [{ person: other, permission: "write" }]);
    await fill(other, chat.shortId, 100);
    await read(viewer, chat.shortId, 100);
    const messages = await fill(other, chat.shortId, 10);
    const before = await parts(chat.id);
    const sent = await f.request(viewer.headers, `/${chat.shortId}/messages`, "POST", { clientId: "own", body: "own reply" });
    expect(sent.status).toBe(201);
    expect(await parts(chat.id)).toEqual(before);
    expect(await detail(viewer, chat.shortId)).toMatchObject({ unread: 10, read: { lastReadSeq: 100 } });
    const linked = await snapshot(viewer, chat.shortId, messages[5]!.short_id);
    expect(linked.focus).toBe(messages[5]!.short_id);
    expect(await parts(chat.id)).toEqual(before);
    const opened = await snapshot(viewer, chat.shortId);
    expect(opened.focus).toBeNull();
    expect(opened.conversation).toMatchObject({ unread: 10, read: { lastReadSeq: 100 } });
    expect(await parts(chat.id)).toEqual(before);
    // An unread window opens around start+1 even when the end is far beyond one page.
    await fill(other, chat.shortId, 100);
    const window = await snapshot(viewer, chat.shortId);
    expect(window.page.items.map((m) => m.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 76));
    expect(window.conversation.rev).toBe(window.page.rev);
    expect(window.conversation.read?.lastReadSeq).toBe(100);
  });

  test("concurrent devices converge to max, backwards reads do nothing, and reads do not wait on the writer lock", async () => {
    const viewer = await f.person(),
      other = await f.person();
    const chat = await f.fixture(viewer, [{ person: other, permission: "write" }]);
    await fill(other, chat.shortId, 50);
    await read(viewer, chat.shortId, 10);
    expect((await read(viewer, chat.shortId, 5)).lastReadSeq).toBe(10);
    for (let i = 0; i < 10; i++) {
      await Promise.all([read(viewer, chat.shortId, 11 + i), read(viewer, chat.shortId, 31 + i)]);
      expect((await detail(viewer, chat.shortId)).read?.lastReadSeq).toBe(31 + i);
    }
    await sql.begin(async (db) => {
      await db`SELECT id FROM chat.conversations WHERE id = ${chat.id}::uuid FOR UPDATE`;
      // This completes before the writer releases its lock; a conversation lock in read deadlocks this test.
      expect((await read(viewer, chat.shortId, 45)).lastReadSeq).toBe(45);
    });
    expect((await read(viewer, chat.shortId, Number.MAX_SAFE_INTEGER)).lastReadSeq).toBe(50);
  });

  test("concurrent first reads create one on-demand row at a read seq and retain the larger position", async () => {
    const owner = await f.person(),
      reader = await f.person();
    const chat = await f.fixture(owner, [{ person: reader, permission: "read" }]);
    await fill(owner, chat.shortId, 20);
    for (let i = 0; i < 10; i++) {
      await sql`DELETE FROM chat.participants WHERE conversation_id = ${chat.id}::uuid AND principal_id = ${reader.id}::uuid`;
      await Promise.all([read(reader, chat.shortId, 5), read(reader, chat.shortId, 15)]);
      const current = await detail(reader, chat.shortId);
      expect(current.read?.lastReadSeq).toBe(15);
      expect([5, 15]).toContain(current.read!.joinedSeq);
      expect(current.unread).toBe(5);
      const [row] = await sql<
        { origin: string; count: number }[]
      >`SELECT min(origin) AS origin, count(*)::int AS count FROM chat.participants
        WHERE conversation_id = ${chat.id}::uuid AND principal_id = ${reader.id}::uuid`;
      expect(row).toEqual({ origin: "ondemand", count: 1 });
    }
  });

  test("mark unread changes only the caller's mark, advances with partial reads, and clears at last read", async () => {
    const viewer = await f.person(),
      other = await f.person();
    const chat = await f.fixture(viewer, [{ person: other, permission: "write" }]);
    const messages = await fill(other, chat.shortId, 20);
    await read(viewer, chat.shortId, 20);
    const before = await parts(chat.id);
    const [otherBefore] = await sql<
      { row: unknown }[]
    >`SELECT to_jsonb(p) AS row FROM chat.participants p WHERE conversation_id = ${chat.id}::uuid AND principal_id = ${other.id}::uuid`;
    expect(await mark(viewer, chat.shortId)).toMatchObject({ lastReadSeq: 20, unreadFromSeq: 20, unread: 1 });
    expect(await mark(viewer, chat.shortId, messages[4]!.short_id)).toMatchObject({ lastReadSeq: 20, unreadFromSeq: 5, unread: 16 });
    expect(await read(viewer, chat.shortId, 10)).toMatchObject({ lastReadSeq: 20, unreadFromSeq: 11, unread: 10 });
    expect(await read(viewer, chat.shortId, 20)).toMatchObject({ lastReadSeq: 20, unreadFromSeq: null, unread: 0 });
    const [otherAfter] = await sql<
      { row: unknown }[]
    >`SELECT to_jsonb(p) AS row FROM chat.participants p WHERE conversation_id = ${chat.id}::uuid AND principal_id = ${other.id}::uuid`;
    expect(otherAfter).toEqual(otherBefore);
    expect(await parts(chat.id)).toEqual(before);
    const foreign = await f.fixture(viewer);
    const [foreignMessage] = await fill(viewer, foreign.shortId, 1);
    for (const message of ["ZZZZZZZZZZ", foreignMessage!.short_id]) {
      const response = await f.request(viewer.headers, `/${chat.shortId}/unread`, "POST", { message });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "NOT_FOUND", message: "Message not found." });
    }
  });

  test("unread is capped and system and own messages never count", async () => {
    const viewer = await f.person(),
      other = await f.person();
    const chat = await f.create(viewer, [other]);
    await fill(other, chat.shortId, 150);
    expect((await detail(viewer, chat.shortId)).unread).toBe(100);
    expect((await detail(other, chat.shortId)).unread).toBe(0);
    await read(viewer, chat.shortId, 140);
    expect((await detail(viewer, chat.shortId)).unread).toBe(11);
    await f.request(viewer.headers, `/${chat.shortId}`, "PATCH", { purpose: "A notice" });
    expect((await detail(viewer, chat.shortId)).unread).toBe(11);
  });

  test("directory members without rows have no unread; first read starts at its seq and open starts at head", async () => {
    const owner = await f.person(),
      reader = await f.person(),
      opener = await f.person();
    const groupId = await f.group([]);
    const response = await f.request(owner.headers, "", "POST", { members: [{ type: "group", groupId }] });
    expect(response.status).toBe(201);
    const created = z.object({ outcome: z.literal("created"), conversation: ConversationSchema }).parse(await response.json());
    const id = created.conversation.id;
    f.trackChat(id);
    const head = Number((await fill(owner, id, 30)).at(-1)!.seq);
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${reader.id}::uuid, ${groupId}::uuid), (${opener.id}::uuid, ${groupId}::uuid)`;
    const list = ConversationPageSchema.parse(await (await f.request(reader.headers, "")).json());
    expect(list.items.find((row) => row.id === id)).toMatchObject({ read: null, unread: 0 });
    expect(await read(reader, id, 10)).toMatchObject({ joinedSeq: 10, lastReadSeq: 10, unread: head - 10 });
    // Two concurrent reads must neither conflict nor lose the larger read position.
    await Promise.all([read(reader, id, 10), read(reader, id, 15)]);
    const readRow = await detail(reader, id);
    expect(readRow.read?.lastReadSeq).toBe(15);
    expect(readRow.read?.joinedSeq).toBe(10);
    expect(readRow.unread).toBe(head - 15);
    const opened = await snapshot(opener, id);
    expect(opened.conversation).toMatchObject({ unread: 0, read: { joinedSeq: head, lastReadSeq: null } });
    expect(opened.page.items.at(-1)?.seq).toBe(head);
    const openedEvents = await outbox(opener);
    expect(z.object({ d: ReadUpdateSchema.extend({ type: z.literal("read") }) }).parse(openedEvents[0]?.payload).d).toMatchObject({
      conversationId: id,
      lastReadSeq: null,
      unreadFromSeq: null,
      joinedSeq: head,
      unread: 0,
      asOfRev: opened.conversation.rev,
    });
    expect((await read(reader, id, 5)).lastReadSeq).toBe(15);
  });

  test("personal outbox payloads match read responses, unchanged reads publish nothing, and no receipts reach c:", async () => {
    const viewer = await f.person(),
      other = await f.person();
    const chat = await f.fixture(viewer, [{ person: other, permission: "write" }]);
    await fill(other, chat.shortId, 3);
    for (const result of [await read(viewer, chat.shortId, 3), await mark(viewer, chat.shortId)]) {
      const rows = await outbox(viewer);
      expect(rows.map((row) => z.object({ d: ReadUpdateSchema.extend({ type: z.literal("read") }) }).parse(row.payload).d)).toContainEqual({
        type: "read",
        ...result,
      });
    }
    await read(viewer, chat.shortId, 3);
    const before = await outbox(viewer);
    await read(viewer, chat.shortId, 2);
    expect(await outbox(viewer)).toEqual(before);
    const conversationEvents = await sql<
      { payload: unknown }[]
    >`SELECT payload FROM events.outbox WHERE app_id = 'chat' AND ordering_key = ${"c:" + chat.shortId}`;
    expect(conversationEvents.every((row) => !JSON.stringify(row.payload).includes('"type":"read"'))).toBeTrue();
  });

  test("read-all marks below ten, confirms from ten without writes, then drains bounded batches including marks", async () => {
    const viewer = await f.person(),
      other = await f.person();
    const seed = async (count: number) => {
      for (let i = 0; i < count; i++) {
        const chat = await f.fixture(viewer, [{ person: other, permission: "write" }]);
        await fill(other, chat.shortId, 1);
      }
    };
    await seed(9);
    expect(await all(viewer)).toEqual({ outcome: "done", marked: 9, more: false });
    await seed(10);
    const tenBefore = await outbox(viewer);
    expect(await all(viewer)).toEqual({ outcome: "confirm" });
    expect(await outbox(viewer)).toEqual(tenBefore);
    expect(await all(viewer, true)).toEqual({ outcome: "done", marked: 10, more: false });
    await seed(READ_ALL_BATCH + 2);
    const before = await outbox(viewer);
    expect(await all(viewer)).toEqual({ outcome: "confirm" });
    expect(await outbox(viewer)).toEqual(before);
    expect(await all(viewer, true)).toEqual({ outcome: "done", marked: READ_ALL_BATCH, more: true });
    expect(await all(viewer, true)).toEqual({ outcome: "done", marked: 2, more: false });
    const list = ConversationPageSchema.parse(await (await f.request(viewer.headers, "")).json());
    const id = list.items[0]!.id;
    await mark(viewer, id);
    expect(await all(viewer)).toEqual({ outcome: "done", marked: 1, more: false });
    const notices = await f.fixture(viewer);
    await f.request(viewer.headers, `/${notices.shortId}`, "PATCH", { purpose: "Notice" });
    await read(viewer, notices.shortId, 1);
    expect(await mark(viewer, notices.shortId)).toMatchObject({ unread: 0, unreadFromSeq: 1 });
    expect(await all(viewer)).toEqual({ outcome: "done", marked: 1, more: false });
    expect(await all(viewer)).toEqual({ outcome: "done", marked: 0, more: false });
  });

  test("the unread count covers chats beyond the first page and stops at 100", async () => {
    const viewer = await f.person(),
      other = await f.person();
    const summary = async () => {
      const response = await f.request(viewer.headers, "/unread-count");
      expect(response.status).toBe(200);
      return (await response.json()) as { count: number; text: string };
    };
    expect(await summary()).toEqual({ count: 0, text: "No unread messages" });
    // The only unread message lies in the oldest chat, behind a full first page of read ones.
    const oldest = await f.fixture(viewer, [{ person: other, permission: "write" }]);
    await fill(other, oldest.shortId, 3);
    for (let i = 0; i < CONVERSATION_PAGE_SIZE; i++) {
      const chat = await f.fixture(viewer, [{ person: other, permission: "write" }]);
      await fill(other, chat.shortId, 1);
      await read(viewer, chat.shortId, 1);
    }
    const page = ConversationPageSchema.parse(await (await f.request(viewer.headers, "")).json());
    expect(page.items.some((item) => item.id === oldest.shortId)).toBe(false);
    expect(await summary()).toEqual({ count: 3, text: "3 unread" });
    await fill(other, oldest.shortId, UNREAD_TOTAL_CAP + 5);
    expect(await summary()).toEqual({ count: UNREAD_TOTAL_CAP, text: "99+ unread" });
  });

  test("manual unread marks without unread messages cannot hide an older unread message from the total", async () => {
    const viewer = await f.person(),
      other = await f.person();
    const oldest = await f.fixture(viewer, [{ person: other, permission: "write" }]);
    await fill(other, oldest.shortId, 1);
    await sql`UPDATE chat.conversations SET last_activity_at = '2026-01-01T00:00:00Z' WHERE id = ${oldest.id}::uuid`;
    const shortIds = Array.from({ length: UNREAD_TOTAL_CAP + 1 }, () => testShortId());
    const rows = await sql<
      { id: string; short_id: string }[]
    >`INSERT INTO chat.conversations (short_id, created_by_type, created_by_id, seq_head, rev, changed_rev, member_count, last_activity_at)
      SELECT short_id, 'user', ${viewer.id}::uuid, 1, 1, 1, 1, '2026-01-02T00:00:00Z'::timestamptz
      FROM unnest(${toPgTextArray(shortIds)}::text[]) AS fixture(short_id) RETURNING id, short_id`;
    for (const row of rows) f.trackChat(row.short_id);
    const ids = toPgUuidArray(rows.map((row) => row.id));
    await sql`INSERT INTO auth.access (id, user_id, permission)
      SELECT id, ${viewer.id}::uuid, 'admin' FROM chat.conversations WHERE id = ANY(${ids}::uuid[])`;
    await sql`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id)
      SELECT id, id, 'member', 'user', ${viewer.id}::uuid FROM chat.conversations WHERE id = ANY(${ids}::uuid[])`;
    await sql`INSERT INTO chat.participants (conversation_id, principal_type, principal_id, origin, joined_seq, last_read_seq, unread_from_seq)
      SELECT id, 'user', ${viewer.id}::uuid, 'direct', 0, 1, 1 FROM chat.conversations WHERE id = ANY(${ids}::uuid[])`;
    // Marking one's own message unread leaves a mark but contributes no unread message to the badge.
    await sql`INSERT INTO chat.messages (short_id, conversation_id, seq, rev, kind, author_type, author_id, author_name, client_id, body_md)
      SELECT short_id || '0001', id, 1, 1, 'text', 'user', ${viewer.id}::uuid, 'Viewer', 'own', 'Own message'
      FROM chat.conversations WHERE id = ANY(${ids}::uuid[])`;
    const response = await f.request(viewer.headers, "/unread-count");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ count: 1, text: "1 unread" });
  });

  test("a service account without access cannot read or create a participant", async () => {
    const owner = await f.person();
    const chat = await f.fixture(owner);
    const credential = await f.credential();
    for (const action of ["read", "unread"]) {
      const response = await f.request(credential, `/${chat.shortId}/${action}`, "POST", action === "read" ? { seq: 1 } : {});
      expect(response.status).toBe(404);
    }
    expect((await parts(chat.id)).length).toBe(1);
  });

  test("a 300-chat sidebar uses the bounded messages seq index without a message sequential scan", async () => {
    const viewer = await f.person(),
      other = await f.person();
    const shortIds = Array.from({ length: 300 }, () => testShortId());
    const rows = await sql<
      { id: string; short_id: string }[]
    >`INSERT INTO chat.conversations (short_id, created_by_type, created_by_id, seq_head, rev, changed_rev, member_count)
      SELECT short_id, 'user', ${viewer.id}::uuid, 5, 5, 5, 1 FROM unnest(${toPgTextArray(shortIds)}::text[]) AS fixture(short_id) RETURNING id, short_id`;
    for (const row of rows) f.trackChat(row.short_id);
    const ids = toPgUuidArray(rows.map((row) => row.id));
    await sql`INSERT INTO auth.access (id, user_id, permission) SELECT id, ${viewer.id}::uuid, 'admin' FROM chat.conversations WHERE id = ANY(${ids}::uuid[])`;
    await sql`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id) SELECT id, id, 'member', 'user', ${viewer.id}::uuid FROM chat.conversations WHERE id = ANY(${ids}::uuid[])`;
    await sql`INSERT INTO chat.participants (conversation_id, principal_type, principal_id, origin, joined_seq, last_read_seq) SELECT c.id, 'user', ${viewer.id}::uuid, 'direct', 0, CASE WHEN fixture.n % 2 = 0 THEN 5 ELSE 0 END FROM chat.conversations c JOIN unnest(${toPgTextArray(shortIds)}::text[]) WITH ORDINALITY AS fixture(short_id, n) ON fixture.short_id = c.short_id WHERE c.id = ANY(${ids}::uuid[])`;
    await sql`INSERT INTO chat.messages (short_id, conversation_id, seq, rev, kind, author_type, author_id, author_name, client_id, body_md)
      SELECT c.short_id || lpad(n::text, 4, '0'), c.id, n, n, 'text', 'user', ${other.id}::uuid, 'Other', n::text, 'Message' FROM chat.conversations c CROSS JOIN generate_series(1, 5) n WHERE c.id = ANY(${ids}::uuid[])`;
    await sql`ANALYZE chat.conversations`;
    await sql`ANALYZE chat.participants`;
    await sql`ANALYZE chat.messages`;
    const page = ConversationPageSchema.parse(await (await f.request(viewer.headers, "")).json());
    expect(page.items).toHaveLength(CONVERSATION_PAGE_SIZE);
    const pageIds = page.items.map((row) => rows.find((candidate) => candidate.short_id === row.id)!.id);
    const plan = await sql<{ "QUERY PLAN": unknown }[]>`EXPLAIN (FORMAT JSON) ${unreadQuery(sql, viewer.context.accessSubject, pageIds)}`;
    const root = z.array(z.object({ Plan: z.unknown() })).parse(plan[0]?.["QUERY PLAN"])[0]!.Plan;
    const NodeSchema = z.object({
      "Node Type": z.string(),
      "Relation Name": z.string().optional(),
      "Index Name": z.string().optional(),
      Plans: z.array(z.unknown()).optional(),
    });
    let indexedUnderLimit = false;
    const walk = (value: unknown, limited = false) => {
      const node = NodeSchema.parse(value);
      const underLimit = limited || node["Node Type"] === "Limit";
      expect(node["Node Type"] === "Seq Scan" && node["Relation Name"] === "messages").toBeFalse();
      if (node["Index Name"] === "idx_chat_messages_seq" && underLimit) indexedUnderLimit = true;
      for (const child of node.Plans ?? []) walk(child, underLimit);
    };
    walk(root);
    expect(indexedUnderLimit).toBeTrue();
    if (process.env.CHAT_SIDEBAR_P95 === "1") {
      const samples: number[] = [];
      for (let i = 0; i < 200; i++) {
        const start = performance.now();
        const response = await f.request(viewer.headers, "");
        expect(response.status).toBe(200);
        await response.json();
        samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      console.log(`Chat sidebar (300 chats, 200 GETs): p50=${samples[99]!.toFixed(2)}ms p95=${samples[189]!.toFixed(2)}ms`);
    }
  });
});
