import { afterAll, beforeAll, expect } from "bun:test";
import { type AuthContext, createAccess } from "@k2b/cloud/server";
import { accounts, serviceAccountCredentials, toPgUuidArray } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { redis, sql } from "bun";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import "../../../../scripts/fixtures/authorization-preload";
import { migrate } from "../migrate";
import type { ChatContext } from "../service/access";
import { CreateOutcomeSchema } from "../service/contracts";
import chatApi from ".";

export type Person = { id: string; name: string; headers: Record<string, string>; context: ChatContext };
export const messageFixtures = () => {
  const server = new Hono<AuthContext>().route("/api/chat", chatApi);
  const users: string[] = [];
  const accountIds: string[] = [];
  const chats: string[] = [];
  const groups: string[] = [];
  const accessIds: string[] = [];
  const request = (headers: Record<string, string>, path: string, method = "GET", body?: unknown) =>
    server.request(`https://cloud.example.test/api/chat/conversations${path}`, {
      method,
      headers: {
        "x-forwarded-for": uniqueCallerAddress(),
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const person = async (name = "Lea Müller"): Promise<Person> => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, given_name)
      VALUES (${`chat-message-${crypto.randomUUID()}`}, 'local', 'user', ${name}, ${name}) RETURNING id`;
    if (!row) throw new Error("Missing fixture person");
    users.push(row.id);
    const user = await accounts.users.get({ id: row.id });
    if (!user) throw new Error("Missing fixture identity");
    return {
      ...row,
      name,
      headers: { cookie: `session_token=${await createTestSession(row.id)}` },
      context: {
        actor: { kind: "user", user },
        accessSubject: { type: "user", userId: row.id },
        locale: "en",
      },
    };
  };
  const credential = async (delegated?: Person) => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, delegated_user_id)
      VALUES (${`Chat messages ${crypto.randomUUID()}`}, ${delegated ? "user_delegated" : "standalone"}, ${delegated?.id ?? null}::uuid) RETURNING id`;
    if (!row) throw new Error("Missing fixture account");
    accountIds.push(row.id);
    const token = await serviceAccountCredentials.createApiToken({
      serviceAccountId: row.id,
      name: "messages test",
      scopes: ["openid", "read"],
    });
    if (!token.ok) throw new Error(token.error.message);
    return { authorization: `Bearer ${token.data.token}` };
  };
  const grant = async (conversationId: string, member: Person, permission: "read" | "write" | "admin", author: Person) => {
    const result = await createAccess({ principal: { type: "user", userId: member.id }, permission });
    if (!result.ok) throw new Error(result.error.message);
    accessIds.push(result.data.id);
    await sql`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id)
      VALUES (${conversationId}::uuid, ${result.data.id}::uuid, 'member', 'user', ${author.id}::uuid)`;
    await sql`INSERT INTO chat.participants (conversation_id, principal_type, principal_id, origin, joined_seq)
      SELECT id, 'user', ${member.id}::uuid, 'direct', seq_head FROM chat.conversations WHERE id = ${conversationId}::uuid`;
    await sql`UPDATE chat.conversations SET member_count = member_count + 1 WHERE id = ${conversationId}::uuid`;
    return result.data.id;
  };
  const fixture = async (owner: Person, members: { person: Person; permission: "read" | "write" | "admin" }[] = []) => {
    const shortId = testShortId();
    const [row] = await sql<{ id: string }[]>`INSERT INTO chat.conversations (short_id, created_by_type, created_by_id)
      VALUES (${shortId}, 'user', ${owner.id}::uuid) RETURNING id`;
    if (!row) throw new Error("Missing fixture chat");
    chats.push(shortId);
    const entries = new Map([[owner.id, await grant(row.id, owner, "admin", owner)]]);
    for (const member of members) entries.set(member.person.id, await grant(row.id, member.person, member.permission, owner));
    return { id: row.id, shortId, entries };
  };
  const create = async (owner: Person, members: Person[]) => {
    const response = await request(owner.headers, "", "POST", { members: members.map((p) => ({ type: "user", userId: p.id })) });
    expect(response.status).toBe(201);
    const result = CreateOutcomeSchema.parse(await response.json());
    if (result.outcome !== "created") throw new Error("Expected creation");
    chats.push(result.conversation.id);
    const [row] = await sql<{ id: string }[]>`SELECT id FROM chat.conversations WHERE short_id = ${result.conversation.id}`;
    if (!row) throw new Error("Missing created chat");
    return { id: row.id, shortId: result.conversation.id };
  };
  const group = async (members: Person[]) => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.groups (cn, provider, name)
      VALUES (${`chat-test-${crypto.randomUUID()}`}, 'local', ${`Team ${crypto.randomUUID()}`}) RETURNING id`;
    if (!row) throw new Error("Missing fixture group");
    groups.push(row.id);
    if (members.length)
      await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id)
      SELECT id, ${row.id}::uuid FROM auth.users WHERE id = ANY(${toPgUuidArray(members.map((member) => member.id))}::uuid[])`;
    return row.id;
  };
  const trackChat = (shortId: string) => chats.push(shortId);
  const resetSendLimits = async (people: Person[], shortId: string) => {
    const keys = people.flatMap((p) =>
      [
        { id: "chat.message.send", key: `user:${p.id}`, seconds: 60 },
        { id: "chat.message.send.conversation", key: `user:${p.id}:${shortId}`, seconds: 10 },
      ].flatMap((limit) =>
        [-1, 0, 1].map((offset) => `cloud:ratelimit:${limit.id}:${limit.key}:${Math.floor(Date.now() / (limit.seconds * 1000)) + offset}`),
      ),
    );
    if (keys.length) await redis.send("DEL", keys);
  };
  beforeAll(migrate);
  afterAll(async () => {
    for (const shortId of chats) {
      const rows = await sql<
        { access_id: string }[]
      >`SELECT access_id FROM chat.conversation_access ca JOIN chat.conversations c ON c.id = ca.conversation_id WHERE c.short_id = ${shortId}`;
      accessIds.push(...rows.map((row) => row.access_id));
      await sql`DELETE FROM events.outbox WHERE app_id = 'chat' AND ordering_key IN (${"c:" + shortId}, ${"l:" + shortId})`;
      await sql`DELETE FROM audit.events WHERE target_type = 'chat_conversation' AND target_id = ${shortId}`;
      await sql`DELETE FROM chat.conversations WHERE short_id = ${shortId}`;
    }
    if (accessIds.length) await sql`DELETE FROM auth.access WHERE id = ANY(${toPgUuidArray([...new Set(accessIds)])}::uuid[])`;
    if (groups.length) await sql`DELETE FROM auth.groups WHERE id = ANY(${toPgUuidArray(groups)}::uuid[])`;
    for (const id of accountIds) {
      await sql`DELETE FROM audit.events WHERE target_id = ${id} OR actor_uid = ${id} OR metadata->>'serviceAccountId' = ${id}`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
    }
    for (const id of users) {
      await sql`DELETE FROM events.outbox WHERE app_id = 'chat' AND ordering_key = ${"p:" + id}`;
      await sql`DELETE FROM audit.events WHERE actor_user_id = ${id}::uuid OR target_id = ${id}`;
      await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
    }
  });
  return { person, credential, fixture, create, request, resetSendLimits, group, trackChat };
};
