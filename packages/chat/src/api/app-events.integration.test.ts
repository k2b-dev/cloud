import { afterAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { type CapabilityExecutionContext, ServiceAccountSchema } from "@k2b/cloud/contracts";
import { AppEventEnvelopeSchema } from "@k2b/cloud/contracts/app-events";
import { createAccess } from "@k2b/cloud/server";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { chatEvents } from "../app-events";
import { chatCapabilities } from "../capabilities";
import { MessageReadDataSchema } from "../capability-contracts";
import { requireConversation } from "../service/access";
import { MessageViewSchema, ThreadSchema } from "../service/contracts";
import { appendMessage } from "../service/message-store";
import { messageFixtures, type Person } from "./messages.test-fixture";

suiteFor(
  "database",
  "nats",
  "valkey",
)("Chat posted-message app events", () => {
  const f = messageFixtures();
  const accounts: string[] = [];
  afterAll(async () => {
    for (const id of accounts) {
      await sql`DELETE FROM events.outbox WHERE app_id = 'chat' AND ordering_key = ${`p:service_account:${id}`}`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
    }
  });
  const context = (person: Person, key = "event-reader"): CapabilityExecutionContext => ({
    actor: person.context.actor,
    accessSubject: person.context.accessSubject,
    user: null,
    origin: "http",
    via: null,
    requestId: key,
    idempotencyKey: key,
    locale: "en",
    signal: new AbortController().signal,
  });
  const outbox = async (chat: string, db = sql) => {
    const rows = await db<{ payload: unknown }[]>`SELECT payload FROM events.outbox
      WHERE app_id = 'chat' AND kind = 'event' AND payload->'place'->>'id' = ${chat} ORDER BY seq`;
    return rows.map(({ payload }) => {
      const envelope = AppEventEnvelopeSchema.parse(payload);
      return { ...envelope, data: chatEvents["message.posted"].schema.parse(envelope.data) };
    });
  };
  const send = async (person: Person, chat: string, key: string, extra = {}) => {
    const response = await f.request({ ...person.headers, "x-request-id": key }, `/${chat}/messages`, "POST", {
      clientId: key,
      body: "A private message",
      ...extra,
    });
    expect(response.status).toBe(201);
    return MessageViewSchema.parse(await response.json());
  };

  test("top-level publication carries public refs and cause once, including capability posts", async () => {
    const author = await f.person();
    const chat = await f.fixture(author);
    const first = await send(author, chat.shortId, "first");
    const repeated = await f.request(author.headers, `/${chat.shortId}/messages`, "POST", { clientId: "first", body: "A private message" });
    expect(repeated.status).toBe(200);
    expect(await outbox(chat.shortId)).toMatchObject([
      {
        type: "chat.message.posted",
        version: 1,
        subject: { type: "chat.message", id: first.id },
        place: { type: "chat.conversation", id: chat.shortId },
        cause: { requestId: "first" },
        data: { threadReply: false, root: null, author: { type: "user", id: author.id }, mentions: [] },
      },
    ]);
    const posted = await chatCapabilities.actions["message.post"].run(
      { conversation: chat.shortId, body: "Result" },
      context(author, "background-post"),
    );
    expect(posted.ok).toBeTrue();
    expect((await outbox(chat.shortId)).at(-1)?.cause).toEqual({ requestId: "background-post" });
    if (posted.ok) expect((await outbox(chat.shortId)).at(-1)?.subject.id).toBe(posted.data.data.id);
  });

  test("service-account posts retain their principal so handlers can skip self-posts", async () => {
    const owner = await f.person();
    const chat = await f.fixture(owner);
    const [row] = await sql<
      { id: string }[]
    >`INSERT INTO auth.service_accounts (name, kind) VALUES ('Chat event fixture', 'standalone') RETURNING id`;
    if (!row) throw new Error("Missing service account");
    accounts.push(row.id);
    const access = await createAccess({ principal: { type: "service_account", serviceAccountId: row.id }, permission: "write" });
    if (!access.ok) throw new Error(access.error.message);
    await sql`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id)
      VALUES (${chat.id}::uuid, ${access.data.id}::uuid, 'member', 'user', ${owner.id}::uuid)`;
    const account = ServiceAccountSchema.parse({
      id: row.id,
      name: "Chat event fixture",
      kind: "standalone",
      status: "active",
      delegatedUserId: null,
      appId: null,
      resourceType: null,
      resourceId: null,
      createdBy: null,
      createdAt: "2026-11-07T10:00:00Z",
    });
    const execution: CapabilityExecutionContext = {
      ...context(owner, "account-post"),
      actor: { kind: "service_account", serviceAccount: account, delegatedUser: null, scopes: ["read", "write"] },
      accessSubject: { type: "service_account", serviceAccountId: row.id },
    };
    const result = await chatCapabilities.actions["message.post"].run({ conversation: chat.shortId, body: "Automated result" }, execution);
    expect(result.ok).toBeTrue();
    const [event] = await outbox(chat.shortId);
    expect(event?.data.author).toEqual({ type: "service_account", id: row.id });
    expect(event?.cause).toEqual({ requestId: "account-post" });
    // The documented handler predicate stops before any second post or content read.
    expect(event?.data.author.type === "service_account" && event.data.author.id === row.id).toBeTrue();
    const scoped = { ...execution, actor: { ...execution.actor, scopes: [] } };
    expect((await chatCapabilities.queries["conversation.read"].run({ id: chat.shortId }, scoped)).ok).toBeFalse();
    if (result.ok) expect((await chatCapabilities.queries["message.read"].run({ id: result.data.data.id }, scoped)).ok).toBeFalse();
  });

  test("replies in general and named threads name the original root, not a reply's body", async () => {
    const author = await f.person();
    const chat = await f.fixture(author);
    const root = await send(author, chat.shortId, "root");
    const reply = await send(author, chat.shortId, "reply", { replyTo: root.id });
    await send(author, chat.shortId, "nested", { replyTo: reply.id });
    const response = await f.request(author.headers, `/${chat.shortId}/threads`, "POST", { name: "Plans" });
    expect(response.status).toBe(201);
    const thread = ThreadSchema.parse(await response.json());
    const namedRoot = await send(author, chat.shortId, "named-root", { thread: thread.id });
    await send(author, chat.shortId, "named-reply", { thread: thread.id, replyTo: namedRoot.id });
    expect((await outbox(chat.shortId)).map((event) => event.data)).toMatchObject([
      { threadReply: false, root: null },
      { threadReply: true, root: { type: "chat.message", id: root.id } },
      { threadReply: true, root: { type: "chat.message", id: root.id } },
      { threadReply: false, root: null },
      { threadReply: true, root: { type: "chat.message", id: namedRoot.id } },
    ]);
  });

  test("legacy reply targets anchor new chains without walking old history", async () => {
    const author = await f.person();
    const chat = await f.fixture(author);
    const oldRoot = await send(author, chat.shortId, "old-root");
    const legacy = await send(author, chat.shortId, "legacy", { replyTo: oldRoot.id });
    await sql`UPDATE chat.messages SET reply_root_id = NULL WHERE short_id = ${legacy.id}`;
    const newReply = await send(author, chat.shortId, "new-reply", { replyTo: legacy.id });
    await send(author, chat.shortId, "new-nested", { replyTo: newReply.id });
    expect((await outbox(chat.shortId)).slice(-2).map((event) => event.data.root)).toEqual([
      { type: "chat.message", id: legacy.id },
      { type: "chat.message", id: legacy.id },
    ]);
  });

  test("invalid optional request correlation cannot roll back a message", async () => {
    const author = await f.person();
    const chat = await f.fixture(author);
    for (const [key, requestId] of [
      ["empty-cause", ""],
      ["long-cause", "x".repeat(257)],
    ] as const) {
      const response = await f.request({ ...author.headers, "x-request-id": requestId }, `/${chat.shortId}/messages`, "POST", {
        clientId: key,
        body: "Stored",
      });
      expect(response.status).toBe(201);
    }
    expect((await outbox(chat.shortId)).map((event) => event.cause)).toEqual([undefined, undefined]);
  });

  test("mentions contain only distinct validated principals", async () => {
    const author = await f.person();
    const member = await f.person();
    const outsider = await f.person();
    const chat = await f.fixture(author, [{ person: member, permission: "read" }]);
    await send(author, chat.shortId, "mention", {
      body: "@one @two @out",
      mentions: [
        { start: 0, end: 4, principal: { type: "user", id: member.id } },
        { start: 5, end: 9, principal: { type: "user", id: member.id } },
        { start: 10, end: 14, principal: { type: "user", id: outsider.id } },
      ],
    });
    expect((await outbox(chat.shortId))[0]?.data.mentions).toEqual([{ type: "user", id: member.id }]);
  });

  test("publication is in the domain transaction and both records roll back", async () => {
    const author = await f.person();
    const chat = await f.fixture(author);
    let id = "";
    await expect(
      sql.begin(async (tx) => {
        await tx`SELECT id FROM chat.conversations WHERE id = ${chat.id}::uuid FOR UPDATE`;
        const allowed = await requireConversation({ ...author.context, conversationId: chat.shortId, required: "write" }, tx);
        if (!allowed.ok) throw new Error(allowed.error.message);
        const row = await appendMessage(tx, allowed.data, author.context, { kind: "text", clientId: "rollback", body: "Private" });
        id = row.short_id;
        expect((await outbox(chat.shortId, tx))[0]?.subject.id).toBe(id);
        expect(await outbox(chat.shortId)).toEqual([]);
        throw new Error("rollback fixture");
      }),
    ).rejects.toThrow("rollback fixture");
    expect(await outbox(chat.shortId)).toEqual([]);
    expect(await sql`SELECT short_id FROM chat.messages WHERE short_id = ${id}`).toHaveLength(0);
  });

  test("edits, deletes, system lines and system-conversation bulk writes emit no posted event", async () => {
    const author = await f.person();
    const chat = await f.fixture(author);
    const message = await send(author, chat.shortId, "mutable");
    const before = await outbox(chat.shortId);
    const edited = await f.request(author.headers, `/${chat.shortId}/messages/${message.id}`, "PATCH", {
      clientId: "edit",
      revision: 0,
      body: "Changed",
    });
    expect(edited.status).toBe(200);
    const deleted = await f.request(author.headers, `/${chat.shortId}/messages/${message.id}`, "DELETE", {
      clientId: "delete",
      revision: 1,
    });
    expect(deleted.status).toBe(200);
    await sql.begin(async (tx) => {
      await tx`SELECT id FROM chat.conversations WHERE id = ${chat.id}::uuid FOR UPDATE`;
      const allowed = await requireConversation({ ...author.context, conversationId: chat.shortId, required: "write" }, tx);
      if (!allowed.ok) throw new Error(allowed.error.message);
      await appendMessage(tx, allowed.data, author.context, { kind: "system", system: { code: "conversation_created", params: {} } });
      await tx`UPDATE chat.conversations SET kind = 'system', resource_type = 'fixture.container', resource_id = 'excluded' WHERE id = ${chat.id}::uuid`;
      for (let i = 0; i < 3; i++)
        await appendMessage(tx, { ...allowed.data, kind: "system" }, author.context, {
          kind: "text",
          clientId: `bulk-${i}`,
          body: "System discussion",
        });
    });
    expect(await outbox(chat.shortId)).toEqual(before);
  });

  test("place and message readers use current grants and expose canonical links", async () => {
    const author = await f.person();
    const member = await f.person();
    const outsider = await f.person();
    const chat = await f.fixture(author, [{ person: member, permission: "read" }]);
    const message = await send(author, chat.shortId, "readable");
    const place = await chatCapabilities.queries["conversation.read"].run({ id: chat.shortId }, context(member));
    expect(place).toMatchObject({
      ok: true,
      data: { data: { view: { permission: "read" } }, links: [{ rel: "open", href: `/app/chat/c/${chat.shortId}/t/general` }] },
    });
    const result = await chatCapabilities.queries["message.read"].run({ id: message.id }, context(member));
    expect(result.ok).toBeTrue();
    if (result.ok)
      expect(MessageReadDataSchema.parse(result.data.data)).toMatchObject({
        ref: { type: "chat.message", id: message.id },
        conversation: { type: "chat.conversation", id: chat.shortId },
        body: "A private message",
      });
    for (const person of [outsider, member]) {
      if (person === member) await sql`DELETE FROM chat.conversation_access WHERE access_id = ${chat.entries.get(member.id)!}::uuid`;
      expect((await chatCapabilities.queries["conversation.read"].run({ id: chat.shortId }, context(person))).ok).toBeFalse();
      expect((await chatCapabilities.queries["message.read"].run({ id: message.id }, context(person))).ok).toBeFalse();
    }
  });
});
