import { expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { loadChatView } from "../service";
import { requireConversation } from "../service/access";
import { ChatSnapshotSchema, ConversationPageSchema, ConversationSchema, MessagePageSchema, MessageViewSchema } from "../service/contracts";
import { appendMessage } from "../service/message-store";
import * as resourceAccess from "../service/resource-access";
import { INITIAL_MESSAGE_PAGE_SIZE } from "../service/snapshot-budget";
import * as threadAccess from "../service/thread-access";
import { messagePreview } from "../system-messages";
import { messageFixtures, type Person } from "./messages.test-fixture";

setDefaultTimeout(120_000);
const suite = suiteFor("database", "nats", "valkey");
suite("chat view snapshots", () => {
  const f = messageFixtures();
  const detail = async (person: Person, id: string) => ConversationSchema.parse(await (await f.request(person.headers, `/${id}`)).json());
  const sidebar = async (person: Person) => ConversationPageSchema.parse(await (await f.request(person.headers, "")).json());
  const snapshot = async (person: Person, id: string, message?: string) => {
    const response = await f.request(
      person.headers,
      `/${id}/snapshot${message === undefined ? "" : `?message=${encodeURIComponent(message)}`}`,
    );
    expect(response.status).toBe(200);
    return ChatSnapshotSchema.parse(await response.json());
  };
  const fill = async (person: Person, id: string, count: number) =>
    sql.begin(async (db) => {
      await db`SELECT id FROM chat.conversations WHERE short_id = ${id} FOR UPDATE`;
      const allowed = await requireConversation({ ...person.context, conversationId: id, required: "write" }, db);
      if (!allowed.ok) throw new Error(allowed.error.message);
      for (let i = 0; i < count; i++)
        await appendMessage(db, allowed.data, person.context, { kind: "text", clientId: `snapshot-${i}`, body: `Message ${i}` });
    });

  test("conversation projections keep the newest text preview after a later system message", async () => {
    const owner = await f.person("Lea Müller");
    const chat = await f.create(owner, []);
    expect((await detail(owner, chat.shortId)).lastMessage).toBeNull();
    expect((await sidebar(owner)).items.find((row) => row.id === chat.shortId)?.lastMessage).toBeNull();
    const send = async (clientId: string, body: string) => {
      const response = await f.request(owner.headers, `/${chat.shortId}/messages`, "POST", { clientId, body });
      expect(response.status).toBe(201);
      return MessageViewSchema.parse(await response.json());
    };
    await send("first", "Earlier text");
    const body = `  **Latest**\n\t${"😀 ".repeat(6000)}`;
    const text = await send("latest", body);
    const before = await detail(owner, chat.shortId);
    const changed = await f.request(owner.headers, `/${chat.shortId}`, "PATCH", { purpose: "Updated details" });
    expect(changed.status).toBe(200);
    const expected = { thread: null, id: text.id, author: text.author, preview: messagePreview(body), createdAt: text.createdAt };
    const after = await detail(owner, chat.shortId);
    expect(after.lastMessage).toEqual(expected);
    expect(ConversationSchema.parse(await changed.json()).lastMessage).toEqual(expected);
    expect(after.lastActivityAt).toBe(before.lastActivityAt);
    expect((await sidebar(owner)).items.find((row) => row.id === chat.shortId)?.lastMessage).toEqual(expected);
    expect(after.rev).toBeGreaterThan(text.rev);
  });

  test("conversation projections collapse long whitespace runs before truncating previews", async () => {
    const owner = await f.person();
    const chat = await f.create(owner, []);
    // Exercise Postgres ARE escapes and every character in JavaScript's whitespace set.
    const whitespace =
      "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
    for (const [index, run] of [" ", whitespace].entries()) {
      const body = `Hello${run.repeat(700)}world`;
      const response = await f.request(owner.headers, `/${chat.shortId}/messages`, "POST", { clientId: `whitespace-${index}`, body });
      expect(response.status).toBe(201);
      const sent = MessageViewSchema.parse(await response.json());
      expect(messagePreview(body)).toBe("Hello world");
      const expected = { thread: null, id: sent.id, author: sent.author, preview: messagePreview(body), createdAt: sent.createdAt };
      expect((await detail(owner, chat.shortId)).lastMessage).toEqual(expected);
      expect((await sidebar(owner)).items.find((row) => row.id === chat.shortId)?.lastMessage).toEqual(expected);
    }
  });

  test("snapshot includes a live cursor, latest history, and the ascending middle-message window", async () => {
    const owner = await f.person();
    const chat = await f.fixture(owner);
    await fill(owner, chat.shortId, 120);
    const latest = await snapshot(owner, chat.shortId);
    expect(latest.cursor.length).toBeGreaterThan(0);
    expect(latest.focus).toBeNull();
    expect(latest.page.seqHead).toBe(120);
    expect(latest.page.rev).toBe(120);
    expect(latest.conversation.rev).toBe(120);
    expect(latest.page.items.map((m) => m.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 71));
    const page = MessagePageSchema.parse(await (await f.request(owner.headers, `/${chat.shortId}/messages?after=40`)).json());
    const target = page.items.find((m) => m.seq === 60)!;
    const middle = await snapshot(owner, chat.shortId, target.id);
    expect(middle.focus).toBe(target.id);
    expect(middle.page.items).toContainEqual(target);
    expect(middle.page.items.map((m) => m.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 35));
    expect(middle.page.seqHead).toBe(120);
    expect(middle.page.rev).toBe(middle.conversation.rev);
    expect(middle.conversation.lastMessage?.id).toBe(latest.page.items.at(-1)?.id);
    const ssr = await loadChatView(owner.context, { conversationId: chat.shortId, messageId: target.id });
    expect(ssr.cursor.length).toBeGreaterThan(0);
    expect(ssr.noAccess).toBe(false);
    expect(ssr.open).toMatchObject({ threads: middle.threads, conversation: middle.conversation, focus: middle.focus });
    expect(ssr.open!.page.items.map((message) => message.seq)).toEqual(
      Array.from({ length: INITIAL_MESSAGE_PAGE_SIZE }, (_, i) => i + 60 - INITIAL_MESSAGE_PAGE_SIZE / 2),
    );
    expect(ssr.open!.page).toMatchObject({ from: 52, to: 67, seqHead: 120, rev: 120 });
    expect(ssr.open!.page.items.every((message) => !("systemText" in message))).toBeTrue();
    // The existing cursor API covers both sides of the smaller SSR range without a gap.
    const older = MessagePageSchema.parse(await (await f.request(owner.headers, `/${chat.shortId}/messages?before=52`)).json());
    const newer = MessagePageSchema.parse(await (await f.request(owner.headers, `/${chat.shortId}/messages?after=67`)).json());
    expect(older.to).toBe(51);
    expect(newer.from).toBe(68);
    const initialLatest = await loadChatView(owner.context, { conversationId: chat.shortId });
    expect(initialLatest.open!.page.items).toHaveLength(INITIAL_MESSAGE_PAGE_SIZE);
    expect(initialLatest.open!.page).toMatchObject({ from: 105, to: 120, seqHead: 120 });
    expect(ssr.sidebar.items.some((row) => row.id === chat.shortId)).toBe(true);
  });

  test("a partially deferred compact unread snapshot keeps the inspected prefix and resumes at its boundary", async () => {
    const reader = await f.person(),
      writer = await f.person();
    const chat = await f.fixture(reader, [{ person: writer, permission: "write" }]);
    await fill(writer, chat.shortId, 120);
    expect((await f.request(reader.headers, `/${chat.shortId}/read`, "POST", { seq: 59 })).status).toBe(200);
    // Simulate an authorization traversal stopping at the second candidate. Its
    // direction determines which inspected side is safe to commit as the cursor.
    const stopped = spyOn(resourceAccess, "discussionStopped").mockReturnValue(true);
    const visible = spyOn(threadAccess, "visibleMessages").mockImplementation(async (_db, _context, candidates, backward) => {
      if (backward) candidates.splice(0, candidates.length - 1);
      else candidates.splice(1);
      return candidates;
    });
    try {
      const view = await loadChatView(reader.context, { conversationId: chat.shortId });
      expect(view.open!.page.items.map((message) => message.seq)).toEqual([60]);
      expect(view.open!.page).toMatchObject({ from: 60, to: 60, seqHead: 120 });
      const continuation = MessagePageSchema.parse(await (await f.request(reader.headers, `/${chat.shortId}/messages?after=60`)).json());
      expect(continuation.from).toBe(61);
    } finally {
      visible.mockRestore();
      stopped.mockRestore();
    }
  });

  test("the compact SSR unread page begins at the first unread message and keeps both cursors", async () => {
    const reader = await f.person(),
      writer = await f.person();
    const chat = await f.fixture(reader, [{ person: writer, permission: "write" }]);
    await fill(writer, chat.shortId, 120);
    const response = await f.request(reader.headers, `/${chat.shortId}/read`, "POST", { seq: 59 });
    expect(response.status).toBe(200);
    const view = await loadChatView(reader.context, { conversationId: chat.shortId });
    expect(view.open!.conversation.read?.lastReadSeq).toBe(59);
    expect(view.open!.page.items.map((message) => message.seq)).toEqual(
      Array.from({ length: INITIAL_MESSAGE_PAGE_SIZE }, (_, i) => i + 60),
    );
    expect(view.open!.page).toMatchObject({ from: 60, to: 75, seqHead: 120 });
    expect(view.open!.focus).toBeNull();
  });

  test("unknown, foreign, and malformed message links open the latest page without focus", async () => {
    const owner = await f.person();
    const chat = await f.fixture(owner),
      other = await f.fixture(owner);
    await fill(owner, chat.shortId, 60);
    await fill(owner, other.shortId, 1);
    const latest = await snapshot(owner, chat.shortId);
    const foreign = (await snapshot(owner, other.shortId)).page.items[0]!.id;
    for (const id of ["ZZZZZZZZZZ", "mistyped!", "", "x".repeat(65), foreign]) {
      const result = await snapshot(owner, chat.shortId, id);
      expect(result.focus).toBeNull();
      expect(result.page).toEqual(latest.page);
    }
  });

  test("forbidden and missing chats return the same 404 and SSR reveals no details", async () => {
    const owner = await f.person(),
      outsider = await f.person();
    const chat = await f.create(owner, []);
    await f.request(owner.headers, `/${chat.shortId}`, "PATCH", { name: "Private name" });
    const missing = await f.request(outsider.headers, "/ZZZZZZ/snapshot");
    const forbidden = await f.request(outsider.headers, `/${chat.shortId}/snapshot`);
    expect(missing.status).toBe(404);
    expect(forbidden.status).toBe(404);
    expect(await forbidden.json()).toEqual(await missing.json());
    for (const conversationId of [chat.shortId, "ZZZZZZ", "malformed!"]) {
      const result = await loadChatView(outsider.context, { conversationId });
      expect(result.open).toBeNull();
      expect(result.noAccess).toBe(true);
      expect(JSON.stringify(result)).not.toContain("Private name");
    }
    const landing = await loadChatView(owner.context, {});
    expect(landing.open).toBeNull();
    expect(landing.noAccess).toBe(false);
  });
});
