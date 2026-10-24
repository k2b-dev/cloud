import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { createAccess } from "@k2b/cloud/server";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import {
  ChatLiveEventSchema,
  MAX_MESSAGE_LINKS,
  MAX_MESSAGE_REFS,
  MessagePageSchema,
  MessageViewSchema,
  SHARED_PAGE_SIZE,
  SharedPageSchema,
  ThreadSchema,
} from "../service/contracts";
import { messageFixtures, type Person } from "./messages.test-fixture";

setDefaultTimeout(30_000);
const suite = suiteFor("database", "nats", "valkey");
suite("chat shared items API", () => {
  const f = messageFixtures();
  const accounts: string[] = [];
  afterAll(async () => {
    for (const id of accounts) {
      await sql`DELETE FROM audit.events WHERE target_id = ${id} OR actor_uid = ${id} OR metadata->>'serviceAccountId' = ${id}`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
    }
  });
  const refs = [
    { type: "spaces.task", id: "task-1" },
    { type: "notebooks.note", id: "note-1" },
  ];
  const send = async (person: Person, chat: string, extra = {}) => {
    const response = await f.request(person.headers, `/${chat}/messages`, "POST", {
      clientId: crypto.randomUUID(),
      body: "Shared",
      ...extra,
    });
    expect(response.status).toBe(201);
    return MessageViewSchema.parse(await response.json());
  };
  const list = async (person: Person, chat: string, query: Record<string, string> = {}) => {
    const response = await f.request(person.headers, `/${chat}/shared?${new URLSearchParams(query)}`);
    expect(response.status).toBe(200);
    return SharedPageSchema.parse(await response.json());
  };
  const thread = async (person: Person, chat: string, name: string) => {
    const response = await f.request(person.headers, `/${chat}/threads`, "POST", { name });
    expect(response.status).toBe(201);
    return ThreadSchema.parse(await response.json());
  };

  test("stores ordered unique refs, allows ref-only sends, and preserves the stored retry and live event", async () => {
    const owner = await f.person();
    const chat = await f.fixture(owner);
    const clientId = "shared-once";
    const message = await send(owner, chat.shortId, { clientId, body: "", refs: [refs[0], refs[1], refs[0]] });
    expect(message.refs).toEqual(refs);
    expect(message.body).toBe("");
    const retry = await f.request(owner.headers, `/${chat.shortId}/messages`, "POST", {
      clientId,
      body: "changed https://ignored.test",
      refs: [refs[1]],
    });
    expect(retry.status).toBe(200);
    expect(MessageViewSchema.parse(await retry.json())).toEqual(message);
    const rows = await sql<
      { payload: unknown }[]
    >`SELECT payload FROM events.outbox WHERE app_id = 'chat' AND ordering_key = ${`c:${chat.shortId}`} ORDER BY seq`;
    const events = rows.map((row) => z.object({ d: ChatLiveEventSchema }).parse(row.payload).d);
    const { systemText: _, ...storedMessage } = message;
    expect(events.filter((event) => event.type === "message")).toEqual([{ type: "message", message: storedMessage }]);
    const history = MessagePageSchema.parse(await (await f.request(owner.headers, `/${chat.shortId}/messages`)).json());
    expect(history.items[0]!.refs).toEqual(refs);
    expect((await list(owner, chat.shortId, { kind: "links" })).items).toEqual([]);
  });

  test("rejects excess or invalid refs and empty bodies without refs, retaining body limits", async () => {
    const owner = await f.person();
    const chat = await f.fixture(owner);
    for (const extra of [
      { refs: Array.from({ length: MAX_MESSAGE_REFS + 1 }, () => refs[0]) },
      { refs: [{ type: "not-qualified", id: "a" }] },
      { refs: [{ type: "spaces.task", id: "" }] },
      { refs: [{ type: "spaces.task", id: "a\u0000b" }] },
      { refs: [{ type: "spaces.task", id: "\ud800" }] },
      { refs: [{ ...refs[0], title: "not identity" }] },
      { body: "" },
      { body: "", refs: [] },
      { body: " \n", refs },
      { body: "\u0000", refs },
      { body: "x".repeat(20_001), refs },
    ]) {
      const response = await f.request(owner.headers, `/${chat.shortId}/messages`, "POST", {
        clientId: crypto.randomUUID(),
        body: "Shared",
        ...extra,
      });
      expect(response.status).toBe(400);
    }
    expect((await send(owner, chat.shortId)).refs).toEqual([]);
  });

  test("extracts Markdown, autolinks and bare HTTP links in order, deduplicates and caps them", async () => {
    const owner = await f.person();
    const chat = await f.fixture(owner);
    const urls = ["https://example.test/markdown", "https://example.test/auto", "http://example.test/bare"];
    const body = `[Markdown](${urls[0]}) <${urls[1]}> ${urls[2]}. [again](${urls[0]}) [unsafe](javascript:alert(1)) [relative](/local) ![image](https://example.test/image.png) \`https://example.test/code\``;
    const message = await send(owner, chat.shortId, { body });
    const items = (await list(owner, chat.shortId)).items;
    expect(items).toEqual(
      urls.map((url) => ({
        kind: "link",
        url,
        messageId: message.id,
        seq: message.seq,
        thread: null,
        author: message.author,
        createdAt: message.createdAt,
      })),
    );
    const links = Array.from({ length: 25 }, (_, i) => `https://example.test/${i}`);
    const capped = await send(owner, chat.shortId, { body: `[long](https://example.test/${"x".repeat(2048)}) ${links.join(" ")}` });
    const page = await list(owner, chat.shortId, { kind: "links" });
    expect(page.items.filter((item) => item.messageId === capped.id).map((item) => item.kind === "link" && item.url)).toEqual(
      links.slice(0, MAX_MESSAGE_LINKS),
    );
  });

  test("filters kinds and threads across the whole chat, including archived threads; deletion removes items", async () => {
    const owner = await f.person();
    const chat = await f.fixture(owner);
    const a = await thread(owner, chat.shortId, "Planning");
    const general = await send(owner, chat.shortId, { refs: [refs[0]], body: "https://example.test/general" });
    const selected = await send(owner, chat.shortId, { thread: a.id, refs: [refs[1]], body: "https://example.test/thread" });
    expect((await list(owner, chat.shortId)).items.map((item) => [item.messageId, item.kind])).toEqual([
      [selected.id, "element"],
      [selected.id, "link"],
      [general.id, "element"],
      [general.id, "link"],
    ]);
    expect((await list(owner, chat.shortId, { kind: "elements" })).items.map((item) => item.kind === "element" && item.ref)).toEqual([
      refs[1]!,
      refs[0]!,
    ]);
    expect((await list(owner, chat.shortId, { thread: "general" })).items.map((item) => [item.messageId, item.thread])).toEqual([
      [general.id, null],
      [general.id, null],
    ]);
    expect((await list(owner, chat.shortId, { thread: a.id })).items.map((item) => item.thread)).toEqual([a.id, a.id]);
    expect((await f.request(owner.headers, `/${chat.shortId}/threads/${a.id}`, "PATCH", { archived: true })).status).toBe(200);
    expect((await list(owner, chat.shortId, { thread: a.id })).items).toHaveLength(2);
    for (const kind of ["images", "documents"]) expect(await list(owner, chat.shortId, { kind })).toEqual({ items: [], nextCursor: null });
    await sql`DELETE FROM chat.messages WHERE short_id = ${selected.id}`;
    expect((await list(owner, chat.shortId)).items.map((item) => item.messageId)).toEqual([general.id, general.id]);
  });

  test("pages by items within a message without loss or duplication, despite newer sends or cursor-message deletion", async () => {
    const owner = await f.person();
    const chat = await f.fixture(owner);
    const manyRefs = Array.from({ length: 10 }, (_, i) => ({ type: "spaces.task", id: String(i) }));
    const body = Array.from({ length: 20 }, (_, i) => `https://example.test/${i}`).join(" ");
    const oldest = await send(owner, chat.shortId, { refs: manyRefs, body });
    const middle = await send(owner, chat.shortId, { refs: manyRefs, body });
    const newest = await send(owner, chat.shortId, { refs: [refs[0]] });
    const first = await list(owner, chat.shortId);
    expect(first.items).toHaveLength(SHARED_PAGE_SIZE);
    expect(first.items[0]!.messageId).toBe(newest.id);
    expect(first.items.at(-1)!.messageId).toBe(middle.id);
    expect(first.nextCursor).not.toBeNull();
    await send(owner, chat.shortId, { refs });
    const second = await list(owner, chat.shortId, { cursor: first.nextCursor! });
    expect(second.items).toHaveLength(SHARED_PAGE_SIZE);
    expect(second.items[0]).toMatchObject({ messageId: middle.id, kind: "link", url: "https://example.test/19" });
    const third = await list(owner, chat.shortId, { cursor: second.nextCursor! });
    expect(third.items).toHaveLength(1);
    expect(third.nextCursor).toBeNull();
    const all = [...first.items, ...second.items, ...third.items];
    expect(new Set(all.map((item) => JSON.stringify(item))).size).toBe(61);
    expect(all.filter((item) => item.messageId === oldest.id)).toHaveLength(30);
    await sql`DELETE FROM chat.messages WHERE short_id = ${middle.id}`;
    const afterDeletion = await list(owner, chat.shortId, { cursor: first.nextCursor! });
    expect(afterDeletion.items).toHaveLength(30);
    expect(afterDeletion.items.every((item) => item.messageId === oldest.id)).toBeTrue();
    expect(afterDeletion.nextCursor).toBeNull();
    const elements = await list(owner, chat.shortId, { kind: "elements" });
    expect(elements.items.every((item) => item.kind === "element")).toBeTrue();
  });

  test("keeps sparse and kind-filtered pages full until the final item", async () => {
    const owner = await f.person();
    const chat = await f.fixture(owner);
    await sql`INSERT INTO chat.messages
      (short_id, conversation_id, seq, rev, kind, author_type, author_id, author_name, client_id, body_md, links, created_at)
      SELECT ${chat.shortId} || lpad(n::text, 4, '0'), ${chat.id}::uuid, n, n, 'text', 'user', ${owner.id}::uuid,
        ${owner.name}, n::text, 'link', ARRAY['https://example.test/' || n::text], '2026-10-20T12:00:00Z'::timestamptz
      FROM generate_series(1, 35) n`;
    await sql`UPDATE chat.conversations SET seq_head = 35, rev = 35 WHERE id = ${chat.id}::uuid`;
    const first = await list(owner, chat.shortId, { kind: "links" });
    expect(first.items.map((item) => item.seq)).toEqual(Array.from({ length: 30 }, (_, i) => 35 - i));
    const last = await list(owner, chat.shortId, { kind: "links", cursor: first.nextCursor! });
    expect(last.items.map((item) => item.seq)).toEqual([5, 4, 3, 2, 1]);
    expect(last.nextCursor).toBeNull();
    for (let i = 0; i < 4; i++)
      await send(owner, chat.shortId, {
        refs: Array.from({ length: 10 }, (_, j) => ({ type: "spaces.task", id: `${i}-${j}` })),
      });
    const elements = await list(owner, chat.shortId, { kind: "elements" });
    expect(elements.items).toHaveLength(30);
    const rest = await list(owner, chat.shortId, { kind: "elements", cursor: elements.nextCursor! });
    expect(rest.items).toHaveLength(10);
    expect(rest.nextCursor).toBeNull();
    expect([...elements.items, ...rest.items].every((item) => item.kind === "element")).toBeTrue();
    expect(new Set([...elements.items, ...rest.items].map((item) => JSON.stringify(item))).size).toBe(40);
  });

  test("requires read access, respects service scope caps, and rejects unknown threads and invalid cursors", async () => {
    const owner = await f.person(),
      reader = await f.person(),
      stranger = await f.person();
    const chat = await f.fixture(owner, [{ person: reader, permission: "read" }]);
    await send(owner, chat.shortId, { refs });
    expect((await list(reader, chat.shortId)).items).toHaveLength(2);
    for (const kind of ["all", "elements", "images", "documents"]) {
      expect((await f.request(stranger.headers, `/${chat.shortId}/shared?kind=${kind}`)).status).toBe(404);
      expect((await f.request(owner.headers, `/${chat.shortId}/shared?kind=${kind}&thread=Absent`)).status).toBe(404);
    }
    const other = await f.fixture(owner);
    const foreign = await thread(owner, other.shortId, "Other chat");
    expect((await f.request(owner.headers, `/${chat.shortId}/shared?thread=${foreign.id}`)).status).toBe(404);
    for (const query of ["kind=unknown", "thread=bad", "cursor=bad", "cursor=", `cursor=${"x".repeat(161)}`])
      expect((await f.request(owner.headers, `/${chat.shortId}/shared?${query}`)).status).toBe(400);
    // An agent with write access but a read-only token lists what was shared and cannot share more; a delegated token
    // acts for its person, whose access applies (Identity → Authorization).
    const [account] = await sql<
      { id: string }[]
    >`INSERT INTO auth.service_accounts (name, kind) VALUES ('Shared agent', 'agent') RETURNING id`;
    accounts.push(account!.id);
    const access = await createAccess({ principal: { type: "service_account", serviceAccountId: account!.id }, permission: "write" });
    if (!access.ok) throw new Error(access.error.message);
    await sql`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id)
      VALUES (${chat.id}::uuid, ${access.data.id}::uuid, 'member', 'user', ${owner.id}::uuid)`;
    const token = await serviceAccountCredentials.createApiToken({
      serviceAccountId: account!.id,
      name: "shared",
      scopes: ["openid", "read"],
    });
    if (!token.ok) throw new Error(token.error.message);
    const readOnly = { authorization: `Bearer ${token.data.token}` };
    expect((await f.request(readOnly, `/${chat.shortId}/shared`)).status).toBe(200);
    expect((await f.request(readOnly, `/${chat.shortId}/messages`, "POST", { clientId: "scoped", body: "", refs })).status).toBe(403);
    expect((await f.request(await f.credential(owner), `/${chat.shortId}/shared`)).status).toBe(200);
    expect((await f.request(await f.credential(), `/${chat.shortId}/shared`)).status).toBe(404);
  });

  test("additive migration preserves legacy empty arrays and existing shared values", async () => {
    const owner = await f.person();
    const chat = await f.fixture(owner);
    await sql`INSERT INTO chat.messages (short_id, conversation_id, seq, rev, kind, author_type, author_id, author_name, client_id, body_md)
      VALUES ('SharedOld1', ${chat.id}::uuid, 1, 1, 'text', 'user', ${owner.id}::uuid, ${owner.name}, 'old', 'https://legacy.test')`;
    await sql`UPDATE chat.conversations SET seq_head = 1, rev = 1 WHERE id = ${chat.id}::uuid`;
    const fresh = await send(owner, chat.shortId, { refs });
    await migrate();
    const [legacy] = await sql<{ refs: unknown; links: string[] }[]>`SELECT refs, links FROM chat.messages WHERE short_id = 'SharedOld1'`;
    expect(legacy).toEqual({ refs: [], links: [] });
    expect((await list(owner, chat.shortId)).items.map((item) => item.messageId)).toEqual([fresh.id, fresh.id]);
  });
});
