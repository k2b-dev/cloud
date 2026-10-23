import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { createAccess } from "@k2b/cloud/server";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import { chatService } from "../service";
import {
  ChangesPageSchema,
  ChatSnapshotSchema,
  MessagePageSchema,
  MessageViewSchema,
  ReactionsSchema,
  ThreadSchema,
} from "../service/contracts";
import { messageFixtures, type Person } from "./messages.test-fixture";

setDefaultTimeout(30_000);
suiteFor(
  "database",
  "nats",
  "valkey",
)("chat message reactions", () => {
  const f = messageFixtures();
  const accounts: string[] = [];
  afterAll(async () => {
    for (const id of accounts) {
      await sql`DELETE FROM events.outbox WHERE app_id = 'chat' AND ordering_key = ${`p:service_account:${id}`}`;
      await sql`DELETE FROM audit.events WHERE target_id = ${id} OR actor_uid = ${id} OR metadata->>'serviceAccountId' = ${id}`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
    }
  });
  const send = async (person: Person, chat: string, extra = {}) => {
    const response = await f.request(person.headers, `/${chat}/messages`, "POST", {
      clientId: crypto.randomUUID(),
      body: "Hello",
      ...extra,
    });
    expect(response.status).toBe(201);
    return MessageViewSchema.parse(await response.json());
  };
  const path = (chat: string, message: string, emoji?: string) =>
    `/${chat}/messages/${message}/reactions${emoji === undefined ? "" : `/${encodeURIComponent(emoji)}`}`;
  const list = async (person: Person, chat: string, message: string) => {
    const response = await f.request(person.headers, path(chat, message));
    expect(response.status).toBe(200);
    return ReactionsSchema.parse(await response.json());
  };
  const set = (person: Person, chat: string, message: string, emoji = "👍", on = true) =>
    f.request(person.headers, path(chat, message, emoji), on ? "PUT" : "DELETE");

  test("read members add/remove idempotently; revisions, live hints and viewer-specific reads agree", async () => {
    const owner = await f.person("Ana"),
      reader = await f.person("Lea");
    const chat = await f.fixture(owner, [{ person: reader, permission: "read" }]);
    const sent = await send(owner, chat.shortId);
    expect(sent.reactions).toEqual([]);
    const before = await chatService.conversations.get({ ...owner.context, conversationId: chat.shortId });
    const participants = await sql`SELECT * FROM chat.participants WHERE conversation_id = ${chat.id}::uuid ORDER BY principal_id`;
    const outbox = () => sql<{ ordering_key: string; payload: unknown; seq: string }[]>`SELECT ordering_key, payload, seq FROM events.outbox
      WHERE app_id = 'chat' AND ordering_key IN (${"c:" + chat.shortId}, ${"l:" + chat.shortId}, ${"p:" + reader.id}) ORDER BY seq`;
    const initial = await outbox();
    expect((await set(reader, chat.shortId, sent.id)).status).toBe(204);
    const read = async (person: Person) =>
      MessageViewSchema.parse(await (await f.request(person.headers, `/${chat.shortId}/messages/${sent.id}`)).json());
    const reacted = await read(reader);
    expect(reacted.rev).toBe(sent.rev + 1);
    expect(reacted.reactions).toEqual([{ emoji: "👍", count: 1, own: true }]);
    expect((await read(owner)).reactions).toEqual([{ emoji: "👍", count: 1, own: false }]);
    expect(await list(reader, chat.shortId, sent.id)).toEqual({ items: [{ emoji: "👍", count: 1, own: true, people: ["Lea"] }] });
    const rows = await outbox();
    expect(rows.slice(initial.length).map(({ ordering_key, payload }) => ({ ordering_key, payload }))).toEqual([
      {
        ordering_key: `c:${chat.shortId}`,
        payload: {
          v: 1,
          k: `c:${chat.shortId}`,
          d: { type: "reactions", conversationId: chat.shortId, messageId: sent.id, rev: reacted.rev },
        },
      },
    ]);
    expect((await set(reader, chat.shortId, sent.id)).status).toBe(204);
    expect(await outbox()).toEqual(rows);
    expect((await read(reader)).rev).toBe(reacted.rev);
    for (const person of [owner, reader]) {
      const expected = [{ emoji: "👍", count: 1, own: person === reader }];
      expect(
        MessagePageSchema.parse(await (await f.request(person.headers, `/${chat.shortId}/messages`)).json()).items[0]!.reactions,
      ).toEqual(expected);
      expect(
        ChatSnapshotSchema.parse(await (await f.request(person.headers, `/${chat.shortId}/snapshot`)).json()).page.items[0]!.reactions,
      ).toEqual(expected);
      expect(
        ChangesPageSchema.parse(await (await f.request(person.headers, `/${chat.shortId}/changes?afterRev=${sent.rev}`)).json())
          .messages[0]!.reactions,
      ).toEqual(expected);
    }
    const retry = await f.request(owner.headers, `/${chat.shortId}/messages`, "POST", {
      clientId: (await sql<{ client_id: string }[]>`SELECT client_id FROM chat.messages WHERE short_id = ${sent.id}`)[0]!.client_id,
      body: "ignored",
    });
    expect(MessageViewSchema.parse(await retry.json()).reactions).toEqual([{ emoji: "👍", count: 1, own: false }]);
    const after = await chatService.conversations.get({ ...owner.context, conversationId: chat.shortId });
    expect(before.ok && after.ok && { ...after.data, rev: before.data.rev }).toEqual(before.ok && before.data);
    expect(await sql`SELECT * FROM chat.participants WHERE conversation_id = ${chat.id}::uuid ORDER BY principal_id`).toEqual(participants);
    expect((await set(reader, chat.shortId, sent.id, "👍", false)).status).toBe(204);
    const removed = await outbox();
    expect((await set(reader, chat.shortId, sent.id, "👍", false)).status).toBe(204);
    expect(await outbox()).toEqual(removed);
    expect((await read(reader)).rev).toBe(reacted.rev + 1);
    expect(await list(reader, chat.shortId, sent.id)).toEqual({ items: [] });
  });

  test("rejects invalid emoji and system/deleted targets, hides foreign conversations and removed membership", async () => {
    const owner = await f.person(),
      reader = await f.person(),
      stranger = await f.person();
    const chat = await f.fixture(owner, [{ person: reader, permission: "read" }]);
    const other = await f.fixture(owner);
    const message = await send(owner, chat.shortId);
    for (const emoji of ["letters", "😀😀", "👨🏿‍👩🏿‍👧🏿‍👦🏿"])
      expect((await set(owner, chat.shortId, message.id, emoji)).status).toBe(400);
    expect((await set(stranger, chat.shortId, message.id)).status).toBe(404);
    expect((await set(owner, other.shortId, message.id)).status).toBe(404);
    await sql`DELETE FROM auth.access WHERE id = ${chat.entries.get(reader.id)!}::uuid`;
    expect((await set(reader, chat.shortId, message.id)).status).toBe(404);
    expect((await f.request(reader.headers, path(chat.shortId, message.id))).status).toBe(404);
    const systemOwner = await f.person();
    const created = await f.create(systemOwner, []);
    const [system] = await sql<
      { short_id: string }[]
    >`SELECT short_id FROM chat.messages WHERE conversation_id = ${created.id}::uuid AND kind = 'system'`;
    for (const method of ["PUT", "DELETE", "GET"]) {
      expect(
        (await f.request(systemOwner.headers, path(created.shortId, system!.short_id, method === "GET" ? undefined : "👍"), method)).status,
      ).toBe(404);
    }
    expect((await set(owner, chat.shortId, message.id)).status).toBe(204);
    const [target] = await sql<{ id: string }[]>`SELECT id FROM chat.messages WHERE short_id = ${message.id}`;
    await sql`DELETE FROM chat.messages WHERE short_id = ${message.id}`;
    expect(
      (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM chat.message_reactions WHERE message_id = ${target!.id}::uuid`)[0]!.n,
    ).toBe(0);
    expect((await set(owner, chat.shortId, message.id)).status).toBe(404);
  });

  test("channel audience readers and guests react without joining or writing messages", async () => {
    const owner = await f.person(),
      reader = await f.person(),
      guest = await f.person();
    await sql`UPDATE auth.users SET profile = 'guest' WHERE id = ${guest.id}::uuid`;
    const created = await f.request(owner.headers, "", "POST", {
      name: "Reactions",
      purpose: "News to react to",
      discovery: [{ principal: { type: "authenticated" }, permission: "read" }],
    });
    expect(created.status).toBe(201);
    const outcome = await created.json();
    const chat = outcome.conversation.id as string;
    f.trackChat(chat);
    const message = await send(owner, chat);
    for (const person of [reader, guest]) {
      expect((await set(person, chat, message.id)).status).toBe(204);
      expect((await f.request(person.headers, `/${chat}/messages`, "POST", { clientId: "no-write", body: "No" })).status).toBe(403);
    }
    expect((await list(owner, chat, message.id)).items[0]!.count).toBe(2);
    const participants = await sql`SELECT p.* FROM chat.participants p JOIN chat.conversations c ON c.id = p.conversation_id
      WHERE c.short_id = ${chat} AND p.principal_id IN (${reader.id}::uuid, ${guest.id}::uuid)`;
    expect(participants).toEqual([]);
  });

  test("service and agent credentials require write scope but only a read grant; delegated read tokens cannot react", async () => {
    const owner = await f.person();
    const chat = await f.fixture(owner);
    const message = await send(owner, chat.shortId);
    for (const kind of ["standalone", "agent"]) {
      const [account] = await sql<
        { id: string }[]
      >`INSERT INTO auth.service_accounts (name, kind) VALUES (${`Reaction agent ${crypto.randomUUID()}`}, ${kind}) RETURNING id`;
      accounts.push(account!.id);
      const access = await createAccess({ principal: { type: "service_account", serviceAccountId: account!.id }, permission: "read" });
      if (!access.ok) throw new Error(access.error.message);
      await sql`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id)
        VALUES (${chat.id}::uuid, ${access.data.id}::uuid, 'member', 'user', ${owner.id}::uuid)`;
      for (const scope of ["read", "write"]) {
        const token = await serviceAccountCredentials.createApiToken({
          serviceAccountId: account!.id,
          name: "reaction",
          scopes: ["openid", "read", scope],
        });
        if (!token.ok) throw new Error(token.error.message);
        const headers = { authorization: `Bearer ${token.data.token}` };
        expect((await f.request(headers, path(chat.shortId, message.id, "👍"), "PUT")).status).toBe(scope === "read" ? 403 : 204);
        expect((await f.request(headers, path(chat.shortId, message.id))).status).toBe(200);
      }
    }
    expect((await f.request(await f.credential(owner), path(chat.shortId, message.id, "👍"), "PUT")).status).toBe(403);
  });

  test("a reactor whose account was deleted is named a former account and still counts", async () => {
    const owner = await f.person("Owner"),
      reader = await f.person("Kept name");
    const chat = await f.fixture(owner, [{ person: reader, permission: "read" }]);
    const message = await send(owner, chat.shortId);
    expect((await set(reader, chat.shortId, message.id)).status).toBe(204);
    await sql`DELETE FROM auth.users WHERE id = ${reader.id}::uuid`;
    const response = await list(owner, chat.shortId, message.id);
    expect(response.items).toEqual([{ emoji: "👍", count: 1, own: false, people: ["Former account"] }]);
    expect(JSON.stringify(response)).not.toContain("Kept name");
  });

  test("uses principal labels when a reactor has no display name", async () => {
    const owner = await f.person(),
      reader = await f.person();
    const chat = await f.fixture(owner, [{ person: reader, permission: "read" }]);
    const message = await send(owner, chat.shortId);
    await sql`UPDATE auth.users SET display_name = '' WHERE id = ${reader.id}::uuid`;
    expect((await set(reader, chat.shortId, message.id)).status).toBe(204);
    const response = await list(owner, chat.shortId, message.id);
    expect(response.items[0]!.people).toEqual(["Unknown person"]);
    expect(JSON.stringify(response)).not.toContain(reader.id);
  });

  test("person and message budgets return stable 409 codes and stay correct under concurrency", async () => {
    const people = await Promise.all(Array.from({ length: 4 }, (_, i) => f.person(`Reactor ${i}`)));
    const owner = people[0]!;
    const chat = await f.fixture(
      owner,
      people.slice(1).map((person) => ({ person, permission: "read" as const })),
    );
    const message = await send(owner, chat.shortId);
    const emojis = Array.from({ length: 51 }, (_, i) => String.fromCodePoint(0x1f600 + i));
    for (let i = 0; i < 50; i++) {
      const person = people[Math.floor(i / 20)]!;
      await f.resetSendLimits([person], chat.shortId);
      expect((await set(person, chat.shortId, message.id, emojis[i]!)).status).toBe(204);
    }
    await f.resetSendLimits(people, chat.shortId);
    const personal = await set(owner, chat.shortId, message.id, emojis[20]!);
    expect(personal.status).toBe(409);
    expect(await personal.json()).toMatchObject({ code: "REACTION_PERSON_LIMIT" });
    const total = await set(people[3]!, chat.shortId, message.id, emojis[50]!);
    expect(total.status).toBe(409);
    expect(await total.json()).toMatchObject({ code: "REACTION_MESSAGE_LIMIT" });
    expect((await set(people[3]!, chat.shortId, message.id, emojis[0]!)).status).toBe(204);
    expect((await set(owner, chat.shortId, message.id, emojis[0]!)).status).toBe(204);
    expect((await list(owner, chat.shortId, message.id)).items).toHaveLength(50);
    expect((await set(people[2]!, chat.shortId, message.id, emojis[49]!, false)).status).toBe(204);
    await f.resetSendLimits(people, chat.shortId);
    const results = await Promise.all([
      set(people[2]!, chat.shortId, message.id, emojis[49]!),
      set(people[3]!, chat.shortId, message.id, emojis[50]!),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([204, 409]);
    expect((await list(owner, chat.shortId, message.id)).items).toHaveLength(50);
  });

  test("inherits named/archived thread visibility and keeps reactions after leaving; migration is repeatable", async () => {
    const owner = await f.person("Ana"),
      reader = await f.person("Lea");
    const chat = await f.fixture(owner, [{ person: reader, permission: "read" }]);
    const thread = ThreadSchema.parse(await (await f.request(owner.headers, `/${chat.shortId}/threads`, "POST", { name: "Work" })).json());
    const message = await send(owner, chat.shortId, { thread: thread.id });
    expect((await set(reader, chat.shortId, message.id)).status).toBe(204);
    expect((await f.request(owner.headers, `/${chat.shortId}/threads/${thread.id}`, "PATCH", { archived: true })).status).toBe(200);
    expect((await set(owner, chat.shortId, message.id, "❤️")).status).toBe(204);
    expect((await f.request(reader.headers, `/${chat.shortId}/leave`, "POST", {})).status).toBe(200);
    expect((await set(reader, chat.shortId, message.id)).status).toBe(404);
    await migrate();
    expect(await list(owner, chat.shortId, message.id)).toEqual({
      items: [
        { emoji: "👍", count: 1, own: false, people: ["Lea"] },
        { emoji: "❤️", count: 1, own: true, people: ["Ana"] },
      ],
    });
  });

  test("people are newest first, capped at ten names, and reaction writes share send rate limits", async () => {
    const owner = await f.person("Ana");
    const chat = await f.fixture(owner);
    const message = await send(owner, chat.shortId);
    for (let i = 0; i < 12; i++) {
      const person = await f.person(`Person ${i}`);
      const access = await createAccess({ principal: { type: "user", userId: person.id }, permission: "read" });
      if (!access.ok) throw new Error(access.error.message);
      await sql`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id)
        VALUES (${chat.id}::uuid, ${access.data.id}::uuid, 'member', 'user', ${owner.id}::uuid)`;
      expect((await set(person, chat.shortId, message.id)).status).toBe(204);
    }
    expect((await list(owner, chat.shortId, message.id)).items).toEqual([
      { emoji: "👍", count: 12, own: false, people: Array.from({ length: 10 }, (_, i) => `Person ${11 - i}`) },
    ]);
    await f.resetSendLimits([owner], chat.shortId);
    for (let i = 0; i < 10; i++) expect((await set(owner, chat.shortId, message.id, "👍", i % 2 === 0)).status).toBe(204);
    const limited = await set(owner, chat.shortId, message.id);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).not.toBeNull();
  });
});
