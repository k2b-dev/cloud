import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { type AuthContext, createAccess, type PermissionLevel } from "@k2b/cloud/server";
import { serviceAccountCredentials, toPgTextArray, toPgUuidArray } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import "../../../../scripts/fixtures/authorization-preload";
import { migrate } from "../migrate";
import {
  ChangesPageSchema,
  ChatSnapshotSchema,
  ConversationPageSchema,
  ConversationSchema,
  CreateOutcomeSchema,
  MemberPageSchema,
  MemberPreviewSchema,
  MemberRemovalSchema,
  MessagePageSchema,
  MessageViewSchema,
  PeoplePageSchema,
} from "../service/contracts";
import chatApi from ".";

setDefaultTimeout(30_000);
const suite = suiteFor("database", "nats", "valkey");
const server = new Hono<AuthContext>().route("/api/chat", chatApi);
type Headers = Record<string, string>;
const request = (headers: Headers, path = "", method = "GET", body?: unknown) =>
  server.request(`https://cloud.example.test/api/chat/conversations${path}`, {
    method,
    headers: {
      "x-forwarded-for": uniqueCallerAddress(),
      ...headers,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

suite("chat conversations, people, and directory groups", () => {
  const users: string[] = [];
  const accounts: string[] = [];
  const groups: string[] = [];
  const conversations: string[] = [];
  const accessIds: string[] = [];
  const user = async (profile = "user", expired = false) => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, given_name, account_expires)
      VALUES (${`chat-${crypto.randomUUID()}`}, 'local', ${profile}, 'Lea Example', 'Lea', ${expired ? new Date(0) : null}) RETURNING id`;
    users.push(row!.id);
    return row!.id;
  };
  const group = async (ids: string[] = [], provider = "local", name = `Team ${crypto.randomUUID()}`) => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.groups (cn, provider, name)
      VALUES (${`chat-${crypto.randomUUID()}`}, ${provider}, ${name}) RETURNING id`;
    if (!row) throw new Error("Missing test group");
    groups.push(row.id);
    if (ids.length)
      await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id)
      SELECT id, ${row.id}::uuid FROM auth.users WHERE id = ANY(${toPgUuidArray(ids)}::uuid[])`;
    return row.id;
  };
  const bulkUsers = async (count: number) => {
    const prefix = `chat-bulk-${crypto.randomUUID()}`;
    const rows = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
      SELECT ${prefix} || '-' || i, 'local', 'user', 'Person ' || lpad(i::text, 4, '0') FROM generate_series(1, ${count}) i RETURNING id`;
    users.push(...rows.map((row) => row.id));
    return rows.map((row) => row.id);
  };
  const groupGrant = async (chat: { id: string }, groupId: string, owner: string, permission: PermissionLevel = "write") => {
    const access = await createAccess({ principal: { type: "group", groupId }, permission });
    if (!access.ok) throw new Error(access.error.message);
    accessIds.push(access.data.id);
    await sql`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id)
      VALUES (${chat.id}::uuid, ${access.data.id}::uuid, 'member', 'user', ${owner}::uuid)`;
    return access.data.id;
  };
  const cookie = async (id: string): Promise<Headers> => ({ cookie: `session_token=${await createTestSession(id)}` });
  const credential = async (
    kind: "standalone" | "agent" | "user_delegated",
    delegatedUserId: string | null = null,
    scopes = ["openid", "read"],
  ): Promise<{ id: string; headers: Headers }> => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, delegated_user_id)
      VALUES (${`Chat ${crypto.randomUUID()}`}, ${kind}, ${delegatedUserId}::uuid) RETURNING id`;
    accounts.push(row!.id);
    const result = await serviceAccountCredentials.createApiToken({ serviceAccountId: row!.id, name: "chat test", scopes });
    if (!result.ok) throw new Error(result.error.message);
    return { id: row!.id, headers: { authorization: `Bearer ${result.data.token}` } };
  };
  const grant = async (id: string, userId: string, permission: PermissionLevel, authorId: string, role = "member") => {
    const result = await createAccess({ principal: { type: "user", userId }, permission });
    if (!result.ok) throw new Error(result.error.message);
    accessIds.push(result.data.id);
    await sql`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id)
      VALUES (${id}::uuid, ${result.data.id}::uuid, ${role}, 'user', ${authorId}::uuid)`;
    if (role === "member") {
      await sql`INSERT INTO chat.participants (principal_type, principal_id, conversation_id, origin, joined_seq)
        VALUES ('user', ${userId}::uuid, ${id}::uuid, 'direct', 0)`;
      await sql`UPDATE chat.conversations SET member_count = member_count + 1 WHERE id = ${id}::uuid`;
    }
    return result.data.id;
  };
  const fixture = async (owner: string, members: { id: string; permission: PermissionLevel }[] = []) => {
    const shortId = testShortId();
    const [row] = await sql<{ id: string }[]>`INSERT INTO chat.conversations (short_id, created_by_type, created_by_id)
      VALUES (${shortId}, 'user', ${owner}::uuid) RETURNING id`;
    conversations.push(shortId);
    const ownerAccess = await grant(row!.id, owner, "admin", owner);
    const entries = new Map([[owner, ownerAccess]]);
    for (const member of members) entries.set(member.id, await grant(row!.id, member.id, member.permission, owner));
    return { id: row!.id, shortId, entries, ownerAccess };
  };
  const create = async (headers: Headers, members: string[], other: Record<string, unknown> = {}) => {
    const response = await request(headers, "", "POST", { members: members.map((userId) => ({ type: "user", userId })), ...other });
    expect(response.status).toBe(201);
    const result = CreateOutcomeSchema.parse(await response.json());
    if (result.outcome !== "created") throw new Error("Expected a new chat");
    conversations.push(result.conversation.id);
    return result.conversation;
  };
  beforeAll(async () => {
    await migrate();
  });
  afterAll(async () => {
    // Junctions cascade from the conversation, but platform access entries have their own owner.
    const rows = conversations.length
      ? await sql<{ access_id: string }[]>`SELECT ca.access_id FROM chat.conversation_access ca
      JOIN chat.conversations c ON c.id = ca.conversation_id WHERE c.short_id = ANY(${toPgTextArray(conversations)}::text[])`
      : [];
    // One statement per table: the shared test database keeps audit rows of earlier runs, and a scan per
    // conversation outlasted the hook's budget.
    if (conversations.length) {
      const keys = conversations.flatMap((shortId) => ["c:" + shortId, "l:" + shortId]);
      await sql`DELETE FROM events.outbox WHERE app_id = 'chat' AND ordering_key = ANY(${toPgTextArray(keys)}::text[])`;
      await sql`DELETE FROM audit.events WHERE target_type = 'chat_conversation' AND target_id = ANY(${toPgTextArray(conversations)}::text[])`;
      await sql`DELETE FROM chat.conversations WHERE short_id = ANY(${toPgTextArray(conversations)}::text[])`;
    }
    const allAccess = [...new Set([...accessIds, ...rows.map((row) => row.access_id)])];
    if (allAccess.length) await sql`DELETE FROM auth.access WHERE id = ANY(${toPgUuidArray(allAccess)}::uuid[])`;
    if (groups.length) await sql`DELETE FROM auth.groups WHERE id = ANY(${toPgUuidArray(groups)}::uuid[])`;
    for (const id of accounts) {
      await sql`DELETE FROM audit.events WHERE target_id = ${id} OR actor_uid = ${id} OR metadata->>'serviceAccountId' = ${id}`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
    }
    if (users.length) {
      await sql`DELETE FROM events.outbox WHERE app_id = 'chat' AND ordering_key = ANY(${toPgTextArray(users.map((id) => "p:" + id))}::text[])`;
      await sql`DELETE FROM audit.events WHERE actor_user_id = ANY(${toPgUuidArray(users)}::uuid[]) OR target_id = ANY(${toPgTextArray(users)}::text[])`;
      await sql`DELETE FROM auth.users WHERE id = ANY(${toPgUuidArray(users)}::uuid[])`;
    }
  });

  const operations = ["create", "list", "detail", "update", "members", "add", "permission", "remove", "leave"] as const;
  for (const identity of ["session", "delegated", "group", "nested", "guest"] as const)
    for (const permission of ["none", "read", "write", "admin"] as const)
      for (const operation of operations) {
        test(`${identity}: ${permission} → ${operation}`, async () => {
          const owner = await user();
          const caller = await user(identity === "guest" ? "guest" : "user");
          const target = await user();
          const newcomer = await user();
          const chat = await fixture(owner, [
            { id: target, permission: "write" },
            ...(permission === "none" || identity === "group" || identity === "nested" ? [] : [{ id: caller, permission }]),
          ]);
          // The delegated credential deliberately has read-only scopes: user grants still decide.
          if ((identity === "group" || identity === "nested") && permission !== "none") {
            const child = await group([caller]);
            const parent = identity === "nested" ? await group() : child;
            if (parent !== child)
              await sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${parent}::uuid, ${child}::uuid)`;
            await groupGrant(chat, parent, owner, permission);
          }
          const headers = identity === "delegated" ? (await credential("user_delegated", caller)).headers : await cookie(caller);
          const path = `/${chat.shortId}`;
          const response =
            operation === "create"
              ? await request(headers, "", "POST", { members: [{ type: "user", userId: newcomer }] })
              : operation === "list"
                ? await request(headers)
                : operation === "detail"
                  ? await request(headers, path)
                  : operation === "update"
                    ? await request(headers, path, "PATCH", { name: "Changed" })
                    : operation === "members"
                      ? await request(headers, `${path}/members`)
                      : operation === "add"
                        ? await request(headers, `${path}/members`, "POST", { members: [{ type: "user", userId: newcomer }] })
                        : operation === "permission"
                          ? await request(headers, `${path}/members/${chat.entries.get(target)}`, "PATCH", { permission: "read" })
                          : operation === "remove"
                            ? await request(headers, `${path}/members/${chat.entries.get(target)}`, "DELETE")
                            : await request(headers, `${path}/leave`, "POST", {});
          const expected =
            operation === "create"
              ? identity === "guest"
                ? 400
                : 201
              : operation === "list"
                ? 200
                : permission === "none"
                  ? 404
                  : operation === "update" && permission === "read"
                    ? 403
                    : ["add", "permission", "remove"].includes(operation) && permission !== "admin"
                      ? 403
                      : operation === "leave" && (identity === "group" || identity === "nested")
                        ? 409
                        : operation === "add" && identity === "guest"
                          ? 400
                          : 200;
          expect(response.status).toBe(expected);
          if (expected === 400 && identity === "guest")
            expect((await response.clone().json()).message).toBe("Guests can add only people they already share a chat with.");
          if (expected === 409)
            expect((await response.clone().json()).message).toBe(
              "You belong to this chat through a group, so you cannot leave it. Archive the chat instead.",
            );
          if (operation === "create" && expected === 201) {
            const result = CreateOutcomeSchema.parse(await response.json());
            if (result.outcome !== "created") throw new Error("Expected creation");
            conversations.push(result.conversation.id);
          } else if (operation === "list") {
            const result = ConversationPageSchema.parse(await response.json());
            expect(result.items.some((item) => item.id === chat.shortId)).toBe(permission !== "none");
          } else if (operation === "detail" && expected === 200 && permission !== "none") {
            expect(ConversationSchema.parse(await response.json()).permission).toBe(permission);
          } else if (operation === "members" && expected === 200) {
            const page = MemberPageSchema.parse(await response.json());
            if (identity === "group" || identity === "nested") expect(page.self).toBeNull();
            else {
              const accessId = chat.entries.get(caller);
              if (!accessId || permission === "none") throw new Error("Expected a direct member");
              expect(page.self).toEqual({ accessId, permission, active: true });
            }
          } else if (expected === 403 && ["add", "permission", "remove"].includes(operation)) {
            const [event] = await sql<
              { outcome: string }[]
            >`SELECT outcome FROM audit.events WHERE target_id = ${chat.shortId} ORDER BY id DESC LIMIT 1`;
            expect(event?.outcome).toBe("denied");
          }
        });
      }

  for (const kind of ["standalone", "agent"] as const)
    test(`${kind} accounts get clear creation/member errors and no conversation access`, async () => {
      const owner = await user();
      const target = await user();
      const chat = await fixture(owner, [{ id: target, permission: "write" }]);
      const account = await credential(kind, null, ["openid", "read", "write", "admin"]);
      const response = await request(account.headers, "", "POST", {});
      expect(response.status).toBe(400);
      expect((await response.json()).message).toBe("Only people and groups can be chat members.");
      const ownerHeaders = await cookie(owner);
      for (const path of ["", `/${chat.shortId}/members`]) {
        const rejected = await request(ownerHeaders, path, "POST", { members: [{ type: "user", userId: account.id }] });
        expect(rejected.status).toBe(400);
        expect((await rejected.json()).message).toBe("Only people and groups can be chat members.");
      }
      const path = `/${chat.shortId}`;
      for (const [suffix, method, body] of [
        [path, "GET", undefined],
        [path, "PATCH", { name: "Blocked" }],
        [`${path}/members`, "GET", undefined],
        [`${path}/members`, "POST", { members: [{ type: "user", userId: target }] }],
        [`${path}/members/${chat.ownerAccess}`, "PATCH", { permission: "read" }],
        [`${path}/members/${chat.ownerAccess}`, "DELETE", undefined],
        [`${path}/leave`, "POST", {}],
      ] as const) {
        const denied = await request(account.headers, suffix, method, body);
        expect(denied.status).toBe(404);
        expect((await denied.json()).code).toBe("NOT_FOUND");
      }
      expect(ConversationPageSchema.parse(await (await request(account.headers)).json()).items).toEqual([]);
    });

  test("matches exact direct sets for pairs, groups, and only-you chats; excludes channels", async () => {
    const ids = await Promise.all(Array.from({ length: 4 }, () => user()));
    const owner = ids[0]!;
    const headers = await cookie(owner);
    const pair = await create(headers, [ids[1]!, owner, ids[1]!]);
    const many = await create(headers, ids.slice(1));
    const self = await create(headers, []);
    for (const [members, expected] of [
      [ids.slice(1), many.id],
      [[ids[1]!], pair.id],
      [[], self.id],
    ] as const) {
      const response = await request(headers, "", "POST", { members: [...members].reverse().map((userId) => ({ type: "user", userId })) });
      expect(response.status).toBe(200);
      const result = CreateOutcomeSchema.parse(await response.json());
      expect(result).toMatchObject({ outcome: "existing", matches: [{ id: expected }] });
    }
    const duplicate = await create(headers, [ids[1]!], { allowDuplicate: true });
    const [row] = await sql<{ id: string }[]>`SELECT id FROM chat.conversations WHERE short_id = ${pair.id}`;
    await grant(row!.id, ids[2]!, "read", owner, "discoverable");
    const found = CreateOutcomeSchema.parse(
      await (await request(headers, "", "POST", { members: [{ type: "user", userId: ids[1]! }] })).json(),
    );
    expect(found).toMatchObject({ outcome: "existing", matches: [{ id: duplicate.id }] });
    const otherSelf = await create(await cookie(ids[1]!), []);
    expect(otherSelf.id).not.toBe(self.id);
    await sql`UPDATE chat.participants SET archived_at = now() WHERE conversation_id = (SELECT id FROM chat.conversations WHERE short_id = ${duplicate.id}) AND principal_id = ${owner}::uuid`;
    const archived = CreateOutcomeSchema.parse(
      await (await request(headers, "", "POST", { members: [{ type: "user", userId: ids[1]! }] })).json(),
    );
    expect(archived).toMatchObject({ outcome: "existing", matches: [{ id: duplicate.id, archived: true }] });
  });

  test("concurrent create intents survive a lost response without duplicating allowDuplicate or group chats", async () => {
    const owner = await user();
    const other = await user();
    const headers = await cookie(owner);
    const groupId = await group([other]);
    for (const members of [[{ type: "user", userId: other }], [{ type: "group", groupId }]]) {
      const body = { createKey: crypto.randomUUID(), members, allowDuplicate: members[0]!.type === "user", name: "One intent" };
      const responses = await Promise.all(Array.from({ length: 4 }, () => request(headers, "", "POST", body)));
      const ids = new Set<string>();
      for (const response of responses) {
        expect(response.status).toBe(201);
        const result = CreateOutcomeSchema.parse(await response.json());
        if (result.outcome !== "created") throw new Error("Expected created");
        ids.add(result.conversation.id);
        conversations.push(result.conversation.id);
      }
      expect(ids.size).toBe(1);
      const [effects] = await sql<{ messages: number; audits: number }[]>`SELECT
        (SELECT count(*)::int FROM chat.messages m JOIN chat.conversations c ON c.id = m.conversation_id WHERE c.short_id = ${[...ids][0]!}) AS messages,
        (SELECT count(*)::int FROM audit.events WHERE target_type = 'chat_conversation' AND target_id = ${[...ids][0]!} AND action = 'chat.conversation.create') AS audits`;
      expect(effects).toEqual({ messages: members[0]!.type === "user" ? 1 : 2, audits: 1 });
      // The caller never receives this accepted response; a subsequent HTTP request must reconcile it.
      await request(headers, "", "POST", body);
      const retry = CreateOutcomeSchema.parse(await (await request(headers, "", "POST", body)).json());
      expect(retry).toMatchObject({ outcome: "created", conversation: { id: [...ids][0] } });
      const [count] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM chat.conversations
        WHERE created_by_id = ${owner}::uuid AND name = 'One intent'`;
      expect(count!.count).toBe(members[0]!.type === "user" ? 1 : 2);
    }
  });

  test("failed creation does not reserve a key and normalized retries survive migration replay", async () => {
    const owner = await user();
    const other = await user();
    const headers = await cookie(owner);
    const createKey = crypto.randomUUID();
    expect((await request(headers, "", "POST", { createKey, members: [{ type: "user", userId: crypto.randomUUID() }] })).status).toBe(400);
    const chat = await create(headers, [other], { createKey, name: "  Intent  ", allowDuplicate: true });
    await migrate();
    const replay = await request(headers, "", "POST", {
      createKey: createKey.toUpperCase(),
      members: [
        { type: "user", userId: owner },
        { type: "user", userId: other },
        { type: "user", userId: other },
      ],
      name: "Intent",
      icon: null,
      purpose: "",
      allowDuplicate: true,
    });
    expect(replay.status).toBe(201);
    expect(CreateOutcomeSchema.parse(await replay.json())).toMatchObject({ outcome: "created", conversation: { id: chat.id } });
    const [mapping] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM chat.create_intents WHERE user_id = ${owner}::uuid`;
    expect(mapping!.count).toBe(1);
    const entries = await sql<
      { access_id: string }[]
    >`SELECT access_id FROM chat.conversation_access WHERE conversation_id = (SELECT id FROM chat.conversations WHERE short_id = ${chat.id})`;
    accessIds.push(...entries.map((entry) => entry.access_id));
    await sql`DELETE FROM chat.conversations WHERE short_id = ${chat.id}`;
    const [removed] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM chat.create_intents WHERE user_id = ${owner}::uuid`;
    expect(removed!.count).toBe(0);
  });

  test("create keys reject changed input, isolate subjects, and replay only currently readable chats", async () => {
    const owner = await user();
    const other = await user();
    const headers = await cookie(owner);
    const body = { createKey: crypto.randomUUID(), members: [{ type: "user", userId: other }], allowDuplicate: true };
    const chat = await create(headers, [], body);
    for (const patch of [{ name: "Changed" }, { members: [] }, { allowDuplicate: false }, { icon: "ti ti-star" }, { purpose: "Changed" }]) {
      const response = await request(headers, "", "POST", { ...body, ...patch });
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("CONFLICT");
    }
    const distinct = await create(headers, [], { ...body, createKey: crypto.randomUUID() });
    expect(distinct.id).not.toBe(chat.id);
    const anotherSubject = await create(await cookie(other), [], body);
    expect(anotherSubject.id).not.toBe(chat.id);
    const delegated = await credential("user_delegated", owner);
    expect(CreateOutcomeSchema.parse(await (await request(delegated.headers, "", "POST", body)).json())).toMatchObject({
      outcome: "created",
      conversation: { id: chat.id },
    });
    await sql`UPDATE auth.access SET permission = 'read' WHERE id IN (SELECT ca.access_id FROM chat.conversation_access ca
      JOIN chat.conversations c ON c.id = ca.conversation_id WHERE c.short_id = ${chat.id}) AND user_id = ${owner}::uuid`;
    const replay = CreateOutcomeSchema.parse(await (await request(headers, "", "POST", body)).json());
    expect(replay).toMatchObject({ outcome: "created", conversation: { id: chat.id, permission: "read" } });
    await sql`DELETE FROM auth.access WHERE id IN (SELECT ca.access_id FROM chat.conversation_access ca
      JOIN chat.conversations c ON c.id = ca.conversation_id WHERE c.short_id = ${chat.id}) AND user_id = ${owner}::uuid`;
    expect((await request(headers, "", "POST", body)).status).toBe(404);
    const [count] = await sql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM chat.conversations WHERE created_by_id = ${owner}::uuid`;
    expect(count!.count).toBe(2);
  });

  test("a chat with a group entry is not an exact match for a direct-only set", async () => {
    const owner = await user();
    const other = await user();
    const headers = await cookie(owner);
    const groupId = await group([], "local", "Engineering Team");
    const grouped = await create(headers, [], {
      members: [
        { type: "user", userId: other },
        { type: "group", groupId },
      ],
    });
    expect(grouped.title).toBe("Lea, Engineering Team");
    const direct = await create(headers, [other]);
    expect(direct.id).not.toBe(grouped.id);
  });

  test("discoverable users and service accounts get the no-direct-entry leave message", async () => {
    const owner = await user();
    const reader = await user();
    const chat = await fixture(owner);
    await grant(chat.id, reader, "read", owner, "discoverable");
    const headers = await cookie(reader);
    expect((await request(headers, `/${chat.shortId}`)).status).toBe(200);
    for (const [locale, message] of [
      ["en", "You are not a direct member of this chat."],
      ["de", "Du bist kein direktes Mitglied dieses Chats."],
    ]) {
      const response = await request({ ...headers, "accept-language": locale! }, `/${chat.shortId}/leave`, "POST", {});
      expect(response.status).toBe(409);
      expect((await response.json()).message).toBe(message);
    }
    const account = await credential("standalone");
    const access = await createAccess({ principal: { type: "service_account", serviceAccountId: account.id }, permission: "read" });
    if (!access.ok) throw new Error(access.error.message);
    accessIds.push(access.data.id);
    await sql`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id)
      VALUES (${chat.id}::uuid, ${access.data.id}::uuid, 'discoverable', 'user', ${owner}::uuid)`;
    const response = await request(account.headers, `/${chat.shortId}/leave`, "POST", {});
    expect(response.status).toBe(409);
    expect((await response.json()).message).toBe("You are not a direct member of this chat.");
  });

  test("a deleted account cannot hide an existing chat from the duplicate check", async () => {
    const owner = await user();
    const b = await user();
    const c = await user();
    const headers = await cookie(owner);
    const chat = await create(headers, [b, c]);
    await sql`DELETE FROM auth.users WHERE id = ${c}::uuid`;
    const response = await request(headers, "", "POST", { members: [{ type: "user", userId: b }] });
    const result = CreateOutcomeSchema.parse(await response.json());
    if (result.outcome === "created") conversations.push(result.conversation.id);
    expect(response.status).toBe(200);
    if (result.outcome !== "existing") throw new Error("Expected the existing chat after account deletion");
    expect(result.matches.map((match) => match.id)).toEqual([chat.id]);
  });

  test("parallel creates with the same people make one chat", async () => {
    const owner = await user();
    const other = await user();
    const headers = await cookie(owner);
    const blocker = await sql.reserve();
    const pending: Promise<{ status: number; result: ReturnType<typeof CreateOutcomeSchema.parse> }>[] = [];
    try {
      await blocker`BEGIN`;
      await blocker`SELECT id FROM auth.users WHERE id = ${owner}::uuid FOR UPDATE`;
      const [connection] = await blocker<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      if (!connection) throw new Error("Expected the blocker backend");
      for (let i = 0; i < 4; i++)
        pending.push(
          Promise.resolve(request(headers, "", "POST", { members: [{ type: "user", userId: other }] })).then(async (response) => {
            const result = CreateOutcomeSchema.parse(await response.json());
            if (result.outcome === "created") conversations.push(result.conversation.id);
            return { status: response.status, result };
          }),
        );
      const deadline = Date.now() + 5_000;
      while (true) {
        const [waiting] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE '%auth.users%'
            AND ${connection.pid} = ANY(pg_blocking_pids(pid))`;
        if (waiting && waiting.count >= 4) break;
        if (Date.now() >= deadline) throw new Error("Timed out waiting for all four chat creates to block on the owner row");
        await Bun.sleep(25);
      }
      await blocker`COMMIT`;
      const responses = await Promise.all(pending);
      const created = responses.filter((response) => response.result.outcome === "created");
      expect(created).toHaveLength(1);
      const first = created[0];
      if (!first || first.result.outcome !== "created") throw new Error("Expected exactly one new chat");
      expect(first.status).toBe(201);
      const existing = responses.filter((response) => response.result.outcome === "existing");
      expect(existing).toHaveLength(3);
      for (const response of existing) {
        expect(response.status).toBe(200);
        if (response.result.outcome !== "existing") throw new Error("Expected the existing chat");
        expect(response.result.matches.map((match) => match.id)).toEqual([first.result.conversation.id]);
      }
      const rows = await sql<{ short_id: string; members: string[] }[]>`SELECT c.short_id,
        array_agg(a.user_id::text ORDER BY a.user_id) AS members
        FROM chat.conversations c JOIN chat.conversation_access ca ON ca.conversation_id = c.id
        JOIN auth.access a ON a.id = ca.access_id
        WHERE c.created_by_type = 'user' AND c.created_by_id = ${owner}::uuid AND ca.role = 'member'
        GROUP BY c.id`;
      expect(rows).toEqual([{ short_id: first.result.conversation.id, members: [owner, other].sort() }]);
    } finally {
      try {
        await blocker`ROLLBACK`;
      } finally {
        blocker.release();
        await Promise.allSettled(pending);
      }
    }
  });

  test("keeps the last manager and transfers management atomically on leave", async () => {
    const owner = await user();
    const other = await user();
    const chat = await fixture(owner, [{ id: other, permission: "read" }]);
    const headers = await cookie(owner);
    const path = `/${chat.shortId}`;
    for (const [method, body] of [
      ["PATCH", { permission: "write" }],
      ["DELETE", undefined],
    ] as const) {
      const response = await request(headers, `${path}/members/${chat.ownerAccess}`, method, body);
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("LAST_MANAGER");
    }
    expect((await request(headers, `${path}/leave`, "POST", {})).status).toBe(409);
    expect((await request(headers, `${path}/leave`, "POST", { successor: chat.ownerAccess })).status).toBe(400);
    expect((await request(headers, `${path}/leave`, "POST", { successor: chat.entries.get(other) })).status).toBe(200);
    expect((await request(headers, path)).status).toBe(404);
    const member = ConversationSchema.parse(await (await request(await cookie(other), path)).json());
    expect(member).toMatchObject({ permission: "admin", memberCount: 1 });
    expect((await request(await cookie(other), `${path}/leave`, "POST", {})).status).toBe(409);
    const [counts] = await sql<{ access_count: number; participants: number }[]>`SELECT
      (SELECT COUNT(*)::int FROM chat.conversation_access WHERE conversation_id = ${chat.id}::uuid) AS access_count,
      (SELECT COUNT(*)::int FROM chat.participants WHERE conversation_id = ${chat.id}::uuid) AS participants`;
    expect(counts).toEqual({ access_count: 1, participants: 1 });
  });

  test("keeps an active manager when another member's account has expired", async () => {
    const owner = await user();
    const expired = await user("user", true);
    const chat = await fixture(owner, [{ id: expired, permission: "write" }]);
    const headers = await cookie(owner);
    const path = `/${chat.shortId}`;
    const unavailable = await request({ ...headers, "accept-language": "de-DE" }, `${path}/leave`, "POST", {
      successor: chat.entries.get(expired),
    });
    expect(unavailable.status).toBe(400);
    expect((await unavailable.json()).message).toBe("Ein ausgewähltes Konto existiert nicht oder ist nicht mehr aktiv.");
    const members = MemberPageSchema.parse(await (await request(headers, `${path}/members`)).json());
    expect(members.items.some((member) => member.accessId === chat.ownerAccess && member.permission === "admin")).toBeTrue();
    expect((await request(headers, `${path}/members/${chat.entries.get(expired)}`, "PATCH", { permission: "admin" })).status).toBe(200);
    for (const [method, body] of [
      ["PATCH", { permission: "write" }],
      ["DELETE", undefined],
    ] as const) {
      const response = await request(headers, `${path}/members/${chat.ownerAccess}`, method, body);
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("LAST_MANAGER");
    }
    const leave = await request(headers, `${path}/leave`, "POST", {});
    expect(leave.status).toBe(409);
    expect((await leave.json()).message).toBe("Choose another direct member as successor before leaving as the last manager.");
    const successor = await user();
    expect((await request(headers, `${path}/members`, "POST", { members: [{ type: "user", userId: successor }] })).status).toBe(200);
    const updatedMembers = MemberPageSchema.parse(await (await request(headers, `${path}/members`)).json());
    const successorEntry = updatedMembers.items.find((member) => member.principal.type === "user" && member.principal.userId === successor);
    if (!successorEntry) throw new Error("Expected the active successor's member entry");
    expect((await request(headers, `${path}/leave`, "POST", { successor: successorEntry.accessId })).status).toBe(200);
    const conversation = ConversationSchema.parse(await (await request(await cookie(successor), path)).json());
    expect(conversation.permission).toBe("admin");
  });

  test("rejects unavailable people and groups, permits guests, and checks guest co-members", async () => {
    const owner = await user();
    const headers = await cookie(owner);
    const guest = await user("guest");
    for (const id of [crypto.randomUUID(), await user("user", true)]) {
      const response = await request({ ...headers, "accept-language": "de-DE" }, "", "POST", { members: [{ type: "user", userId: id }] });
      expect(response.status).toBe(400);
      expect((await response.json()).message).toBe("Ein ausgewähltes Konto existiert nicht oder ist nicht mehr aktiv.");
    }
    const missing = await request(headers, "", "POST", { members: [{ type: "group", groupId: crypto.randomUUID() }] });
    expect(missing.status).toBe(400);
    expect((await missing.json()).message).toBe("A selected group does not exist.");
    const guestHeaders = await cookie(guest);
    const rejected = await request(guestHeaders, "", "POST", { members: [{ type: "user", userId: owner }] });
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).message).toBe("Guests can add only people they already share a chat with.");
    const shared = await create(headers, [guest]);
    expect(shared.withGuests).toBeTrue();
    const accepted = await create(guestHeaders, [owner], { allowDuplicate: true });
    expect(accepted.withGuests).toBeTrue();
  });

  test("deduplicates member additions, preserves sequence/read state, and leaves activity unchanged", async () => {
    const owner = await user();
    const other = await user();
    const chat = await fixture(owner);
    const headers = await cookie(owner);
    await sql`UPDATE chat.conversations SET seq_head = 42 WHERE id = ${chat.id}::uuid`;
    const before = ConversationSchema.parse(await (await request(headers, `/${chat.shortId}`)).json());
    expect(
      (
        await request(headers, `/${chat.shortId}/members`, "POST", {
          members: [other, other, owner].map((userId) => ({ type: "user", userId })),
        })
      ).status,
    ).toBe(200);
    const repeated = await request(headers, `/${chat.shortId}/members`, "POST", { members: [{ type: "user", userId: other }] });
    expect(await repeated.json()).toEqual({ added: 0 });
    const [participant] = await sql<
      { joined_seq: bigint; last_read_seq: bigint | null; origin: string }[]
    >`SELECT joined_seq, last_read_seq, origin FROM chat.participants
      WHERE conversation_id = ${chat.id}::uuid AND principal_id = ${other}::uuid`;
    expect(String(participant?.joined_seq)).toBe("42");
    expect(participant?.last_read_seq).toBeNull();
    expect(participant?.origin).toBe("direct");
    const after = ConversationSchema.parse(
      await (await request(headers, `/${chat.shortId}`, "PATCH", { name: "  ", purpose: " secret content " })).json(),
    );
    expect(after).toMatchObject({ name: null, purpose: "secret content", memberCount: 2, lastActivityAt: before.lastActivityAt });
    const members = MemberPageSchema.parse(await (await request(headers, `/${chat.shortId}/members`)).json());
    expect(members.items).toHaveLength(2);
    expect(members.items.every((member) => member.displayName === "Lea Example")).toBeTrue();
  });

  test("serializes concurrent manager demotions so one manager remains", async () => {
    const owner = await user();
    const other = await user();
    const chat = await fixture(owner, [{ id: other, permission: "admin" }]);
    const [ownerHeaders, otherHeaders] = await Promise.all([cookie(owner), cookie(other)]);
    const responses = await Promise.all([
      request(ownerHeaders, `/${chat.shortId}/members/${chat.ownerAccess}`, "PATCH", { permission: "write" }),
      request(otherHeaders, `/${chat.shortId}/members/${chat.entries.get(other)}`, "PATCH", { permission: "write" }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const [count] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM chat.conversation_access ca
      JOIN auth.access a ON a.id = ca.access_id WHERE ca.conversation_id = ${chat.id}::uuid AND a.permission = 'admin'`;
    expect(count?.count).toBe(1);
  });

  test("migration is idempotent and retains existing records", async () => {
    const chat = await fixture(await user());
    const definitions = () =>
      sql<{ definition: string }[]>`SELECT indexdef AS definition FROM pg_indexes WHERE schemaname = 'chat' ORDER BY indexname`;
    const before = await definitions();
    await migrate();
    await migrate();
    expect(await definitions()).toEqual(before);
    const [row] = await sql<{ member_count: number }[]>`SELECT member_count FROM chat.conversations WHERE id = ${chat.id}::uuid`;
    expect(row?.member_count).toBe(1);
    const columns = await sql<
      { column_name: string }[]
    >`SELECT column_name FROM information_schema.columns WHERE table_schema = 'chat' AND table_name = 'participants'`;
    expect(columns.map((row) => row.column_name)).not.toContain("read_at");
    const [prefs] = await sql<{ name: string | null }[]>`SELECT to_regclass('chat.account_prefs')::text AS name`;
    expect(prefs?.name).toBe("chat.account_prefs");
  });

  test("rejects creation atomically, including a failure after access rows have been written", async () => {
    const owner = await user();
    const other = await user();
    const headers = await cookie(owner);
    const counts = () =>
      sql<
        { count: number }[]
      >`SELECT COUNT(*)::int AS count FROM auth.access WHERE user_id = ANY(${toPgUuidArray([owner, other])}::uuid[])`;
    const before = await counts();
    expect((await request(headers, "", "POST", { members: [{ type: "user", userId: crypto.randomUUID() }] })).status).toBe(400);
    expect(await counts()).toEqual(before);
    // This trigger is restricted to the test member, so concurrent suites remain unaffected.
    const triggerName = `test_chat_atomic_${crypto.randomUUID().replaceAll("-", "")}`;
    await sql.unsafe(
      `CREATE FUNCTION chat.${triggerName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test member insert failure'; END $$`,
    );
    try {
      await sql.unsafe(
        `CREATE TRIGGER ${triggerName} BEFORE INSERT ON chat.participants FOR EACH ROW WHEN (NEW.principal_id = '${other}'::uuid) EXECUTE FUNCTION chat.${triggerName}()`,
      );
      const response = await request(headers, "", "POST", { members: [{ type: "user", userId: other }] });
      expect(response.status).toBe(500);
      expect(await counts()).toEqual(before);
      const rows = await sql`SELECT id FROM chat.conversations WHERE created_by_id = ${owner}::uuid`;
      expect(rows).toHaveLength(0);
    } finally {
      await sql.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON chat.participants`);
      await sql.unsafe(`DROP FUNCTION chat.${triggerName}()`);
    }
  });

  test("limits new chats to 30 per acting account, but existing matches do not consume the limit", async () => {
    const owner = await user();
    const headers = await cookie(owner);
    const keyed = { createKey: crypto.randomUUID(), allowDuplicate: true };
    const first = await create(headers, [], keyed);
    for (let i = 1; i < 30; i++) await create(headers, [], { allowDuplicate: true });
    const replay = await request(headers, "", "POST", keyed);
    expect(replay.status).toBe(201);
    expect(CreateOutcomeSchema.parse(await replay.json())).toMatchObject({ outcome: "created", conversation: { id: first.id } });
    const response = await request({ ...headers, "accept-language": "de" }, "", "POST", { allowDuplicate: true });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      code: "RATE_LIMITED",
      message: "Du kannst höchstens 30 neue Chats pro Stunde erstellen. Versuche es später erneut.",
    });
    const existing = await request(headers, "", "POST", {});
    expect(existing.status).toBe(200);
    const matches = CreateOutcomeSchema.parse(await existing.json());
    if (matches.outcome !== "existing") throw new Error("Expected matches");
    expect(matches.matches).toHaveLength(10);
  });

  test("pages conversations without losing sub-millisecond activity ties", async () => {
    const owner = await user();
    const headers = await cookie(owner);
    const chats = [];
    for (let i = 0; i < 52; i++) chats.push(await fixture(owner));
    for (let i = 0; i < chats.length; i++)
      await sql`UPDATE chat.conversations
      SET last_activity_at = '2026-10-09T12:00:00Z'::timestamptz + ${i} * interval '1 microsecond' WHERE id = ${chats[i]!.id}::uuid`;
    const first = ConversationPageSchema.parse(await (await request(headers)).json());
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = ConversationPageSchema.parse(await (await request(headers, `?cursor=${encodeURIComponent(first.nextCursor!)}`)).json());
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((chat) => chat.id)).size).toBe(52);
    expect(first.items[0]?.id).toBe(chats[51]!.shortId);
  });

  test("pages direct members and rejects adding participant 5,001", async () => {
    const owner = await user();
    const headers = await cookie(owner);
    const chat = await fixture(owner);
    const directIds: string[] = [];
    for (let i = 0; i < 101; i++) {
      const id = await user();
      directIds.push(id);
      await grant(chat.id, id, "write", owner);
    }
    const path = `/${chat.shortId}/members`;
    const first = MemberPageSchema.parse(await (await request(headers, path)).json());
    expect(first.items).toHaveLength(100);
    const second = MemberPageSchema.parse(await (await request(headers, `${path}?cursor=${first.nextCursor}`)).json());
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((member) => member.accessId)).size).toBe(102);
    const ids = await bulkUsers(4897);
    const capGroups: string[] = [];
    for (let start = 0; start < ids.length; start += 500) {
      const groupId = await group(ids.slice(start, start + 500));
      capGroups.push(groupId);
      await groupGrant(chat, groupId, owner);
    }
    const last = await user();
    const reached = await request(headers, path, "POST", { members: [{ type: "user", userId: last }] });
    expect(reached.status).toBe(200);
    expect(ConversationSchema.parse(await (await request(headers, `/${chat.shortId}`)).json()).memberCount).toBe(5000);
    const newcomer = await user();
    const before = await sql`SELECT a.id FROM auth.access a WHERE a.user_id = ${newcomer}::uuid`;
    const added = await request(headers, path, "POST", { members: [{ type: "user", userId: newcomer }] });
    expect(added.status).toBe(400);
    expect((await added.json()).message).toBe("A chat can have at most 5,000 members.");
    expect(await sql`SELECT a.id FROM auth.access a WHERE a.user_id = ${newcomer}::uuid`).toEqual(before);
    expect(ConversationSchema.parse(await (await request(headers, `/${chat.shortId}`)).json()).memberCount).toBe(5000);
    const additional = await group([...directIds, last, newcomer]);
    const beforeCreation = await sql`SELECT id FROM chat.conversations WHERE created_by_id = ${owner}::uuid ORDER BY id`;
    const createOverLimit = await request(headers, "", "POST", {
      members: [...capGroups, additional].map((groupId) => ({ type: "group", groupId })),
    });
    // The owner plus 4,897 grouped people and 103 additional people exceeds the cap.
    expect(createOverLimit.status).toBe(400);
    expect((await createOverLimit.json()).message).toBe("A chat can have at most 5,000 members.");
    expect(await sql`SELECT id FROM chat.conversations WHERE created_by_id = ${owner}::uuid ORDER BY id`).toEqual(beforeCreation);
  });

  test("attributes delegated creations to the acting account while granting the person access", async () => {
    const owner = await user();
    const delegated = await credential("user_delegated", owner);
    const chat = await create(delegated.headers, []);
    const [row] = await sql<
      { created_by_type: string; created_by_id: string; added_by_type: string; added_by_id: string; user_id: string }[]
    >`
      SELECT c.created_by_type, c.created_by_id, ca.added_by_type, ca.added_by_id, a.user_id
      FROM chat.conversations c JOIN chat.conversation_access ca ON ca.conversation_id = c.id JOIN auth.access a ON a.id = ca.access_id
      WHERE c.short_id = ${chat.id}`;
    expect(row).toEqual({
      created_by_type: "service_account",
      created_by_id: delegated.id,
      added_by_type: "service_account",
      added_by_id: delegated.id,
      user_id: owner,
    });
    const [event] = await sql<{ actor_uid: string; actor_user_id: string | null }[]>`SELECT actor_uid, actor_user_id FROM audit.events
      WHERE action = 'chat.conversation.create' AND target_id = ${chat.id}`;
    expect(event).toEqual({ actor_uid: delegated.id, actor_user_id: null });
  });

  test("writes every mutation's audit action without conversation content", async () => {
    const owner = await user();
    const other = await user();
    const newcomer = await user();
    const headers = await cookie(owner);
    const chat = await create(headers, [other], { name: "Private title", purpose: "Private purpose", icon: "ti ti-lock" });
    const path = `/${chat.id}`;
    await request(headers, path, "PATCH", { purpose: "Private updated purpose" });
    await request(headers, `${path}/members`, "POST", { members: [{ type: "user", userId: newcomer }] });
    const members = MemberPageSchema.parse(await (await request(headers, `${path}/members`)).json());
    const otherEntry = members.items.find((entry) => entry.principal.type === "user" && entry.principal.userId === other)!;
    const newEntry = members.items.find((entry) => entry.principal.type === "user" && entry.principal.userId === newcomer)!;
    await request(headers, `${path}/members/${otherEntry.accessId}`, "PATCH", { permission: "admin" });
    await request(headers, `${path}/members/${newEntry.accessId}`, "DELETE");
    await request(headers, `${path}/leave`, "POST", {});
    const rows = await sql<
      { action: string; metadata: Record<string, unknown>; target_label: string | null }[]
    >`SELECT action, metadata, target_label FROM audit.events
      WHERE target_type = 'chat_conversation' AND target_id = ${chat.id} ORDER BY id`;
    expect(rows.map((row) => row.action)).toEqual([
      "chat.conversation.create",
      "chat.conversation.update",
      "chat.member.add",
      "chat.member.update",
      "chat.member.remove",
      "chat.member.leave",
    ]);
    expect(JSON.stringify(rows)).not.toContain("Private");
    expect(JSON.stringify(rows)).not.toContain("ti ti-lock");
    expect(rows.every((row) => row.target_label === null)).toBeTrue();
  });
  test("bounds effective group size at 500, expands nested groups, and terminates cycles", async () => {
    const owner = await user();
    const headers = await cookie(owner);
    const ids = await bulkUsers(501);
    const child = await group(ids.slice(0, 500));
    const parent = await group([ids[0]!, ids[500]!]);
    await sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${parent}::uuid, ${child}::uuid), (${child}::uuid, ${parent}::uuid)`;
    for (const [locale, text] of [
      ["en", "A group with more than 500 people cannot be a chat member. Use “Discoverable by” for larger groups."],
      ["de", "Eine Gruppe mit mehr als 500 Personen kann kein Chat-Mitglied sein. Nutze für größere Gruppen „Auffindbar für“."],
    ]) {
      const rejected = await request({ ...headers, "accept-language": locale! }, "", "POST", {
        members: [{ type: "group", groupId: parent }],
      });
      expect(rejected.status).toBe(400);
      expect((await rejected.json()).message).toBe(text);
    }
    await sql`DELETE FROM auth.user_groups_v2 WHERE group_id = ${parent}::uuid AND user_id = ${ids[500]}::uuid`;
    const response = await request(headers, "", "POST", { members: [{ type: "group", groupId: child }] });
    expect(response.status).toBe(201);
    const outcome = CreateOutcomeSchema.parse(await response.json());
    if (outcome.outcome !== "created") throw new Error("Expected group chat");
    conversations.push(outcome.conversation.id);
    expect(outcome.conversation.memberCount).toBe(501);
    for (const people of [[], [{ type: "user", userId: ids[500]! }]]) {
      const repeated = await request(headers, "", "POST", { members: [...people, { type: "group", groupId: child }] });
      expect(repeated.status).toBe(201);
      const result = CreateOutcomeSchema.parse(await repeated.json());
      if (result.outcome !== "created") throw new Error("Group inputs must bypass direct-set matching");
      conversations.push(result.conversation.id);
      const page = MessagePageSchema.parse(await (await request(headers, `/${result.conversation.id}/messages`)).json());
      expect(page.items.map((message) => message.system?.code)).toEqual(["conversation_created", "groups_added"]);
    }
    expect((await request(await cookie(ids[500]!), `/${outcome.conversation.id}`)).status).toBe(404);
    const [count] = await sql<
      { count: number }[]
    >`SELECT COUNT(*)::int AS count FROM chat.participants p JOIN chat.conversations c ON c.id = p.conversation_id WHERE c.short_id = ${outcome.conversation.id}`;
    expect(count?.count).toBe(501);
    const chat = await fixture(owner);
    await sql`INSERT INTO auth.user_groups_v2 (group_id, user_id) VALUES (${parent}::uuid, ${ids[500]}::uuid)`;
    const rejectedAdd = await request(headers, `/${chat.shortId}/members`, "POST", { members: [{ type: "group", groupId: parent }] });
    expect(rejectedAdd.status).toBe(400);
    expect((await rejectedAdd.json()).message).toContain("more than 500");
  });

  test("two groups of 300 people seed all 600 ondemand participants on create and add", async () => {
    const owner = await user();
    const headers = await cookie(owner);
    const ids = await bulkUsers(600);
    const members = [
      { type: "group", groupId: await group(ids.slice(0, 300)) },
      { type: "group", groupId: await group(ids.slice(300)) },
    ];
    const created = await create(headers, [], { members });
    const added = await fixture(owner);
    expect((await request(headers, `/${added.shortId}/members`, "POST", { members })).status).toBe(200);
    for (const shortId of [created.id, added.shortId]) {
      const [count] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM chat.participants p
        JOIN chat.conversations c ON c.id = p.conversation_id WHERE c.short_id = ${shortId} AND p.origin = 'ondemand'
        AND p.principal_type = 'user' AND p.principal_id = ANY(${toPgUuidArray(ids)}::uuid[])`;
      expect(count?.count).toBe(600);
      expect(ConversationSchema.parse(await (await request(headers, `/${shortId}`)).json()).memberCount).toBe(601);
      const [row] = await sql<{ member_count: number }[]>`SELECT member_count FROM chat.conversations WHERE short_id = ${shortId}`;
      expect(row?.member_count).toBe(601);
    }
  });

  test("group adds seed ondemand state, retain it on direct upgrades, and grant future group members access", async () => {
    const owner = await user();
    const direct = await user();
    const grouped = await user();
    const later = await user();
    const groupId = await group([grouped], "local", "");
    const headers = await cookie(owner);
    const chat = await fixture(owner);
    await sql`UPDATE chat.conversations SET seq_head = 42 WHERE id = ${chat.id}::uuid`;
    const path = `/${chat.shortId}`;
    const added = await request(headers, `${path}/members`, "POST", {
      members: [
        { type: "group", groupId },
        { type: "user", userId: direct },
      ],
    });
    expect(added.status).toBe(200);
    expect(await added.json()).toEqual({ added: 2 });
    const participant = () =>
      sql<
        { origin: string; joined_seq: string; last_read_seq: string | null }[]
      >`SELECT origin, joined_seq, last_read_seq FROM chat.participants WHERE conversation_id = ${chat.id}::uuid AND principal_id = ${grouped}::uuid`;
    expect(await participant()).toEqual([{ origin: "ondemand", joined_seq: "42", last_read_seq: null }]);
    await sql`UPDATE chat.participants SET last_read_seq = 7 WHERE conversation_id = ${chat.id}::uuid AND principal_id = ${grouped}::uuid`;
    expect((await request(headers, `${path}/members`, "POST", { members: [{ type: "user", userId: grouped }] })).status).toBe(200);
    expect(await participant()).toEqual([{ origin: "direct", joined_seq: "42", last_read_seq: "7" }]);
    expect(ConversationSchema.parse(await (await request(headers, path)).json()).memberCount).toBe(3);
    await sql`INSERT INTO auth.user_groups_v2 (group_id, user_id) VALUES (${groupId}::uuid, ${later}::uuid)`;
    const laterHeaders = await cookie(later);
    expect(ConversationPageSchema.parse(await (await request(laterHeaders)).json()).items.map((item) => item.id)).toContain(chat.shortId);
    expect((await request(laterHeaders, `${path}/snapshot`)).status).toBe(200);
    const members = MemberPageSchema.parse(await (await request(headers, `${path}/members`)).json());
    expect(members.items.find((entry) => entry.principal.type === "group")).toMatchObject({
      principal: { type: "group", groupId },
      permission: "write",
    });
    const lines = MessagePageSchema.parse(await (await request(headers, `${path}/messages`)).json()).items;
    expect(lines.slice(0, 2).map((message) => message.system?.code)).toEqual(["members_added", "groups_added"]);
    const [g] = await sql<{ cn: string }[]>`SELECT cn FROM auth.groups WHERE id = ${groupId}::uuid`;
    expect(lines[1]?.system).toEqual({ code: "groups_added", params: { groups: [{ id: groupId, name: g!.cn }] } });
    expect((await request(headers, `${path}/members`, "POST", { members: [{ type: "group", groupId }] })).status).toBe(200);
    const left = await request(await cookie(grouped), `${path}/leave`, "POST", {});
    expect(left.status).toBe(200);
    expect(MemberRemovalSchema.parse(await left.json())).toEqual({ success: true, keptThroughGroup: true });
    expect(await participant()).toEqual([{ origin: "ondemand", joined_seq: "42", last_read_seq: "7" }]);
    expect((await request(await cookie(grouped), path)).status).toBe(200);
    const groupEntry = members.items.find((entry) => entry.principal.type === "group")!;
    expect((await request(headers, `${path}/members/${groupEntry.accessId}`, "PATCH", { permission: "admin" })).status).toBe(404);
    expect((await request(await cookie(direct), `${path}/members/${groupEntry.accessId}`, "DELETE")).status).toBe(403);
    const removedGroup = await request(headers, `${path}/members/${groupEntry.accessId}`, "DELETE");
    expect(removedGroup.status).toBe(200);
    expect(MemberRemovalSchema.parse(await removedGroup.json())).toEqual({ success: true, keptThroughGroup: false });
    expect(await participant()).toEqual([]);
    expect(ConversationSchema.parse(await (await request(headers, path)).json()).memberCount).toBe(2);
    expect((await request(await cookie(grouped), path)).status).toBe(404);
    const after = MessagePageSchema.parse(await (await request(headers, `${path}/messages`)).json());
    expect(after.items.at(-1)?.system).toEqual({ code: "group_removed", params: { group: { id: groupId, name: g!.cn } } });
  });

  test("removing direct membership preserves a group reader and deletes an exclusively direct participant", async () => {
    const owner = await user();
    const other = await user();
    const chat = await fixture(owner, [{ id: other, permission: "write" }]);
    const headers = await cookie(owner);
    await groupGrant(chat, await group([other]), owner);
    const removed = await request(headers, `/${chat.shortId}/members/${chat.entries.get(other)}`, "DELETE");
    expect(removed.status).toBe(200);
    expect(MemberRemovalSchema.parse(await removed.json())).toEqual({ success: true, keptThroughGroup: true });
    const [remaining] = await sql<
      { origin: string }[]
    >`SELECT origin FROM chat.participants WHERE conversation_id = ${chat.id}::uuid AND principal_id = ${other}::uuid`;
    expect(remaining?.origin).toBe("ondemand");
    const standalone = await fixture(owner, [{ id: other, permission: "write" }]);
    const left = await request(await cookie(other), `/${standalone.shortId}/leave`, "POST", {});
    expect(left.status).toBe(200);
    expect(MemberRemovalSchema.parse(await left.json())).toEqual({ success: true, keptThroughGroup: false });
    expect(
      await sql`SELECT principal_id FROM chat.participants WHERE conversation_id = ${standalone.id}::uuid AND principal_id = ${other}::uuid`,
    ).toHaveLength(0);
    const directOnly = await fixture(owner, [{ id: other, permission: "write" }]);
    const plainRemoval = await request(headers, `/${directOnly.shortId}/members/${directOnly.entries.get(other)}`, "DELETE");
    expect(plainRemoval.status).toBe(200);
    expect(MemberRemovalSchema.parse(await plainRemoval.json())).toEqual({ success: true, keptThroughGroup: false });
    expect((await request(await cookie(other), `/${directOnly.shortId}`)).status).toBe(404);
  });

  test("guest people pages expose only direct co-members, search literally, and enforce the same rule for delegated guests", async () => {
    const owner = await user();
    const guest = await user("guest");
    const groupOnly = await user();
    const stranger = await user();
    const expired = await user("user", true);
    const ids = await bulkUsers(22);
    const shared = await fixture(owner, [
      { id: guest, permission: "admin" },
      { id: expired, permission: "write" },
    ]);
    for (const id of ids) await grant(shared.id, id, "write", owner);
    await groupGrant(shared, await group([groupOnly]), owner);
    await sql`UPDATE auth.users SET display_name = 'Literal %_ Test' WHERE id = ${ids[0]}::uuid`;
    const headers = await cookie(guest);
    const people = (headers: Headers, query = "") =>
      server.request(`/api/chat/people${query}`, { headers: { ...headers, "x-forwarded-for": uniqueCallerAddress() } });
    const first = PeoplePageSchema.parse(await (await people(headers)).json());
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).not.toBeNull();
    const second = PeoplePageSchema.parse(await (await people(headers, `?cursor=${encodeURIComponent(first.nextCursor!)}`)).json());
    expect(second.items).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    const all = [...first.items, ...second.items].map((person) => person.id);
    expect(new Set(all)).toEqual(new Set([owner, ...ids]));
    const search = PeoplePageSchema.parse(await (await people(headers, "?search=%25_")).json());
    expect(search.items.map((person) => person.id)).toEqual([ids[0]!]);
    // Bulk uids share a prefix ("…-2" also matches "…-20"), so give the searched account a unique uid.
    const uid = `chat-search-${crypto.randomUUID()}`;
    await sql`UPDATE auth.users SET uid = ${uid} WHERE id = ${ids[1]}::uuid`;
    expect(PeoplePageSchema.parse(await (await people(headers, `?search=${uid}`)).json()).items.map((person) => person.id)).toEqual([
      ids[1]!,
    ]);
    for (const guestHeaders of [headers, (await credential("user_delegated", guest)).headers]) {
      for (const suffix of ["", `/${shared.shortId}/members`]) {
        for (const requested of [stranger, groupOnly]) {
          const denied = await request(guestHeaders, suffix, "POST", { members: [{ type: "user", userId: requested }] });
          expect(denied.status).toBe(400);
          expect((await denied.json()).message).toBe("Guests can add only people they already share a chat with.");
        }
        const denied = await request(guestHeaders, suffix, "POST", { members: [{ type: "group", groupId: await group() }] });
        expect(denied.status).toBe(400);
        expect((await denied.json()).message).toBe("Only full accounts can add groups to chats.");
      }
    }
    const own = await create(headers, [], { allowDuplicate: true });
    expect((await request(headers, `/${own.id}/members`, "POST", { members: [{ type: "user", userId: ids[0] }] })).status).toBe(200);
    expect(PeoplePageSchema.parse(await (await people((await credential("standalone")).headers)).json()).items).toEqual([]);
    const directPeer = await user();
    const throughGroup = await fixture(directPeer);
    await groupGrant(throughGroup, await group([guest, groupOnly]), directPeer);
    expect(PeoplePageSchema.parse(await (await people(headers, "?search=Lea")).json()).items.map((person) => person.id)).toContain(
      directPeer,
    );
  });

  test("guest and expired-peer flags agree on list and detail without lowering write access", async () => {
    const owner = await user();
    const guest = await user("guest");
    const headers = await cookie(owner);
    const chat = await create(headers, [guest]);
    await sql`UPDATE auth.users SET account_expires = now() WHERE id = ${guest}::uuid`;
    const detail = ConversationSchema.parse(await (await request(headers, `/${chat.id}`)).json());
    expect(detail).toMatchObject({ withGuests: true, peerDeactivated: true, permission: "admin", title: "Lea Example" });
    expect(ConversationPageSchema.parse(await (await request(headers)).json()).items.find((item) => item.id === chat.id)).toEqual(detail);
    expect((await request(headers, `/${chat.id}/messages`, "POST", { clientId: "still-writable", body: "Hello" })).status).toBe(201);
    const [row] = await sql<{ id: string }[]>`SELECT id FROM chat.conversations WHERE short_id = ${chat.id}`;
    await groupGrant({ id: row!.id }, await group(), owner);
    expect(ConversationSchema.parse(await (await request(headers, `/${chat.id}`)).json()).peerDeactivated).toBeFalse();
  });

  test("deleted people have localized former names in every message projection, params, titles, and sidebar", async () => {
    const owner = await user();
    const other = await user();
    const headers = await cookie(owner);
    const chat = await create(headers, [other]);
    const removed = await user();
    expect((await request(headers, `/${chat.id}/members`, "POST", { members: [{ type: "user", userId: removed }] })).status).toBe(200);
    const beforeRemoval = MemberPageSchema.parse(await (await request(headers, `/${chat.id}/members`)).json());
    const removedEntry = beforeRemoval.items.find((member) => member.principal.type === "user" && member.principal.userId === removed)!;
    expect((await request(headers, `/${chat.id}/members/${removedEntry.accessId}`, "DELETE")).status).toBe(200);
    await sql`DELETE FROM auth.users WHERE id = ${removed}::uuid`;
    const otherHeaders = await cookie(other);
    const sent = MessageViewSchema.parse(
      await (await request(otherHeaders, `/${chat.id}/messages`, "POST", { clientId: "former", body: "Kept" })).json(),
    );
    const members = MemberPageSchema.parse(await (await request(headers, `/${chat.id}/members`)).json());
    const entry = members.items.find((member) => member.principal.type === "user" && member.principal.userId === other)!;
    expect((await request(headers, `/${chat.id}/members/${entry.accessId}`, "PATCH", { permission: "read" })).status).toBe(200);
    await sql`DELETE FROM auth.users WHERE id = ${other}::uuid`;
    for (const [locale, label] of [
      ["en", "Former account"],
      ["de", "Ehemaliges Konto"],
    ]) {
      const localized = { ...headers, "accept-language": locale! };
      const detail = ConversationSchema.parse(await (await request(localized, `/${chat.id}`)).json());
      expect(detail.title).toBe(label!);
      expect(detail.lastMessage?.author.name).toBe(label!);
      const list = ConversationPageSchema.parse(await (await request(localized)).json());
      expect(list.items.find((item) => item.id === chat.id)).toEqual(detail);
      const page = MessagePageSchema.parse(await (await request(localized, `/${chat.id}/messages`)).json());
      expect(page.items.find((message) => message.id === sent.id)?.author.name).toBe(label!);
      for (const message of page.items.filter((message) =>
        ["members_added", "member_removed", "permission_changed"].includes(message.system?.code ?? ""),
      )) {
        expect(JSON.stringify(message.system?.params)).toContain(label!);
        expect(message.systemText).toContain(label!);
      }
      const single = MessageViewSchema.parse(await (await request(localized, `/${chat.id}/messages/${sent.id}`)).json());
      expect(single.author.name).toBe(label!);
      const snapshot = ChatSnapshotSchema.parse(await (await request(localized, `/${chat.id}/snapshot`)).json());
      expect(snapshot.page.items).toEqual(page.items);
      const changes = ChangesPageSchema.parse(await (await request(localized, `/${chat.id}/changes?afterRev=0`)).json());
      expect(changes.messages).toEqual(page.items);
    }
  });

  test("a deleted leave successor is substituted in params and rendered text", async () => {
    const owner = await user();
    const successor = await user();
    const reader = await user();
    const headers = await cookie(owner);
    const chat = await create(headers, [successor, reader]);
    const members = MemberPageSchema.parse(await (await request(headers, `/${chat.id}/members`)).json());
    const entry = members.items.find((member) => member.principal.type === "user" && member.principal.userId === successor)!;
    expect((await request(headers, `/${chat.id}/leave`, "POST", { successor: entry.accessId })).status).toBe(200);
    await sql`DELETE FROM auth.users WHERE id = ${successor}::uuid`;
    const readerHeaders = await cookie(reader);
    for (const [locale, label] of [
      ["en", "Former account"],
      ["de", "Ehemaliges Konto"],
    ]) {
      const page = MessagePageSchema.parse(
        await (await request({ ...readerHeaders, "accept-language": locale! }, `/${chat.id}/messages`)).json(),
      );
      const left = page.items.find((message) => message.system?.code === "member_left");
      expect(left?.system).toEqual({ code: "member_left", params: { successor: { id: successor, name: label! } } });
      expect(left?.systemText).toContain(label!);
    }
  });

  test("group add and removal publish access updates and personal membership hints in the transaction", async () => {
    const owner = await user();
    const ids = await bulkUsers(2);
    const groupId = await group(ids);
    const headers = await cookie(owner);
    const chat = await fixture(owner);
    const keys = [`c:${chat.shortId}`, `l:${chat.shortId}`, ...ids.map((id) => `p:${id}`)];
    for (const operation of ["add", "remove"]) {
      await sql`DELETE FROM events.outbox WHERE app_id = 'chat' AND ordering_key = ANY(${toPgTextArray(keys)}::text[])`;
      if (operation === "add")
        expect((await request(headers, `/${chat.shortId}/members`, "POST", { members: [{ type: "group", groupId }] })).status).toBe(200);
      else {
        const members = MemberPageSchema.parse(await (await request(headers, `/${chat.shortId}/members`)).json());
        const entry = members.items.find((member) => member.principal.type === "group")!;
        expect((await request(headers, `/${chat.shortId}/members/${entry.accessId}`, "DELETE")).status).toBe(200);
      }
      const rows = await sql<
        { ordering_key: string; payload: unknown }[]
      >`SELECT ordering_key, payload FROM events.outbox WHERE app_id = 'chat' AND ordering_key = ANY(${toPgTextArray(keys)}::text[]) ORDER BY seq`;
      for (const key of keys.slice(0, 2))
        expect(rows.find((row) => row.ordering_key === key)?.payload).toMatchObject({ v: 1, k: key, a: true });
      for (const key of keys.slice(2))
        expect(rows.find((row) => row.ordering_key === key)?.payload).toMatchObject({
          v: 1,
          k: key,
          d: { type: "membership", conversationId: chat.shortId },
        });
    }
  });
  test("250 direct members page in name order, including ties, and search pages without gaps", async () => {
    const owner = await user();
    const ids = await bulkUsers(249);
    await sql`UPDATE auth.users SET display_name = 'Manager' WHERE id = ${owner}::uuid`;
    await sql`UPDATE auth.users SET display_name = 'Person 0100' WHERE id = ${ids[100]}::uuid`;
    const chat = await fixture(
      owner,
      ids.map((id) => ({ id, permission: "write" as const })),
    );
    const headers = await cookie(owner);
    const expected = await sql<{ access_id: string; name: string }[]>`
      SELECT ca.access_id, COALESCE(NULLIF(u.display_name, ''), u.uid) AS name FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
      JOIN auth.users u ON u.id = a.user_id WHERE ca.conversation_id = ${chat.id}::uuid
      ORDER BY lower(COALESCE(NULLIF(u.display_name, ''), u.uid)), ca.access_id
    `;
    for (const q of ["", "pErSoN"]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      const matching = expected.filter((row) => !q || row.name.toLowerCase().includes(q.toLowerCase()));
      for (const size of [100, 100, matching.length - 200]) {
        const query = new URLSearchParams({ q, ...(cursor ? { cursor } : {}) });
        const response = await request(headers, `/${chat.shortId}/members?${query}`);
        expect(response.status).toBe(200);
        const page = MemberPageSchema.parse(await response.json());
        expect(page.items).toHaveLength(size);
        expect(page.managers).toBe(1);
        expect(page.self).toEqual({ accessId: chat.ownerAccess, permission: "admin", active: true });
        seen.push(...page.items.map((row) => row.accessId));
        cursor = page.nextCursor;
      }
      expect(cursor).toBeNull();
      expect(new Set(seen).size).toBe(matching.length);
      expect(seen).toEqual(matching.map((row) => row.access_id));
    }
    for (const query of [
      new URLSearchParams({ q: "x".repeat(101) }),
      new URLSearchParams({ cursor: "not-json" }),
      new URLSearchParams({ cursor: "x".repeat(2001) }),
      new URLSearchParams({ cursor: JSON.stringify({ name: "person", id: owner, extra: true }) }),
      new URLSearchParams({ cursor: JSON.stringify({ name: "person", id: "not-a-uuid" }) }),
    ]) {
      const response = await request(headers, `/${chat.shortId}/members?${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "BAD_INPUT" });
    }
  });

  test("member search escapes wildcards and includes group size, guest, expiry and active direct managers", async () => {
    const owner = await user();
    const guest = await user("guest");
    const expired = await user("user", true);
    const reader = await user();
    const discoverer = await user();
    const headers = await cookie(owner);
    const chat = await fixture(owner, [
      { id: guest, permission: "read" },
      { id: expired, permission: "admin" },
      { id: reader, permission: "write" },
    ]);
    await grant(chat.id, discoverer, "admin", owner, "discoverable");
    const groupId = await group([owner, reader], "local", "Support_% Team");
    await groupGrant(chat, groupId, owner, "admin");
    const login = `Needle-${crypto.randomUUID()}`;
    await sql`UPDATE auth.users SET uid = ${login}, display_name = 'Guest_% Name' WHERE id = ${guest}::uuid`;
    const read = async (q = "") =>
      MemberPageSchema.parse(await (await request(headers, `/${chat.shortId}/members?${new URLSearchParams({ q })}`)).json());
    const page = await read();
    expect(page.managers).toBe(1);
    expect(page.self).toEqual({ accessId: chat.ownerAccess, permission: "admin", active: true });
    // Effective admin through the group does not change the caller's direct write entry.
    const readerPage = MemberPageSchema.parse(await (await request(await cookie(reader), `/${chat.shortId}/members?q=Support`)).json());
    expect(readerPage.self).toEqual({ accessId: chat.entries.get(reader)!, permission: "write", active: true });
    const discovererPage = MemberPageSchema.parse(await (await request(await cookie(discoverer), `/${chat.shortId}/members`)).json());
    expect(discovererPage.self).toBeNull();
    expect(page.items.find((entry) => entry.principal.type === "group")).toMatchObject({
      displayName: "Support_% Team",
      groupSize: 2,
      guest: false,
      deactivated: false,
    });
    const guestResponse = await request(await cookie(guest), `/${chat.shortId}/members`);
    expect(guestResponse.status).toBe(200);
    const guestPage = MemberPageSchema.parse(await guestResponse.json());
    expect(guestPage.self).toEqual({ accessId: chat.entries.get(guest)!, permission: "read", active: true });
    expect(guestPage.items.find((entry) => entry.principal.type === "group")).toMatchObject({
      principal: { type: "group", groupId },
      displayName: "Support_% Team",
      groupSize: null,
    });
    expect(page.items.find((entry) => entry.principal.type === "user" && entry.principal.userId === guest)).toMatchObject({
      guest: true,
      deactivated: false,
      groupSize: null,
      avatarHash: null,
    });
    expect(page.items.find((entry) => entry.principal.type === "user" && entry.principal.userId === expired)).toMatchObject({
      guest: false,
      deactivated: true,
      groupSize: null,
    });
    expect((await read("gUeSt_%")).items).toHaveLength(1);
    expect((await read(login.toUpperCase())).items).toHaveLength(1);
    expect((await read("sUpPoRt")).items).toHaveLength(1);
    for (const q of ["%", "_"]) expect((await read(q)).items.map((entry) => entry.displayName)).toEqual(["Guest_% Name", "Support_% Team"]);
    await sql`UPDATE auth.users SET display_name = 'Back\\slash' WHERE id = ${reader}::uuid`;
    expect((await read("\\")).items.map((entry) => entry.displayName)).toEqual(["Back\\slash"]);
    // Group names are unique per provider, so the cn search runs on a named group.
    const [groupRow] = await sql<{ cn: string }[]>`SELECT cn FROM auth.groups WHERE id = ${groupId}::uuid`;
    expect((await read(groupRow!.cn.toUpperCase())).items.map((entry) => entry.principal)).toEqual([{ type: "group", groupId }]);
    const large = await group(await bulkUsers(501));
    await groupGrant(chat, large, owner);
    expect((await read()).items.find((entry) => entry.principal.type === "group" && entry.principal.groupId === large)?.groupSize).toBe(
      501,
    );
  });

  test("standalone accounts with discoverable admin access cannot expand or add groups", async () => {
    const owner = await user();
    const chat = await fixture(owner);
    const listedGroup = await group([owner]);
    await groupGrant(chat, listedGroup, owner);
    const account = await credential("standalone", null, ["openid", "read", "admin"]);
    const access = await createAccess({ principal: { type: "service_account", serviceAccountId: account.id }, permission: "admin" });
    if (!access.ok) throw new Error(access.error.message);
    accessIds.push(access.data.id);
    await sql`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id)
      VALUES (${chat.id}::uuid, ${access.data.id}::uuid, 'discoverable', 'user', ${owner}::uuid)`;
    const path = `/${chat.shortId}`;
    const response = await request(account.headers, `${path}/members`);
    expect(response.status).toBe(200);
    const page = MemberPageSchema.parse(await response.json());
    expect(page.self).toBeNull();
    expect(page.items.find((entry) => entry.principal.type === "group")).toMatchObject({
      principal: { type: "group", groupId: listedGroup },
      groupSize: null,
    });
    const ownerPage = MemberPageSchema.parse(await (await request(await cookie(owner), `${path}/members`)).json());
    expect(ownerPage.items.find((entry) => entry.principal.type === "group")?.groupSize).toBe(1);
    // A direct-user preview proves the account's grant and scopes authorize management.
    const newcomer = await user();
    const preview = await request(account.headers, `${path}/members/preview`, "POST", { members: [{ type: "user", userId: newcomer }] });
    expect(preview.status).toBe(200);
    expect(MemberPreviewSchema.parse(await preview.json())).toEqual({ joining: 1, throughGroups: 0, memberCount: 2 });
    const members = [{ type: "group", groupId: await group([newcomer]) }];
    for (const suffix of ["/members/preview", "/members"]) {
      const rejected = await request(account.headers, path + suffix, "POST", { members });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ code: "BAD_INPUT", message: "Only full accounts can add groups to chats." });
    }
    const after = MemberPageSchema.parse(await (await request(await cookie(owner), `${path}/members`)).json());
    expect(after).toEqual(ownerPage);
  });

  test("member preview authorizes admin, deduplicates joining people and leaves all chat state untouched", async () => {
    const owner = await user();
    const writer = await user();
    const direct = await user();
    const groupOnly = await user();
    const inherited = await user();
    const chat = await fixture(owner, [{ id: writer, permission: "write" }]);
    const headers = await cookie(owner);
    const existingGroup = await group([inherited]);
    expect(
      (await request(headers, `/${chat.shortId}/members`, "POST", { members: [{ type: "group", groupId: existingGroup }] })).status,
    ).toBe(200);
    const nested = await group([groupOnly]);
    const groupId = await group([owner, writer, direct, inherited]);
    await sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${groupId}::uuid, ${nested}::uuid)`;
    const members = [
      { type: "group", groupId },
      { type: "user", userId: direct },
      { type: "user", userId: owner },
    ];
    const state = async () => {
      const [row] = await sql<
        {
          member_count: number;
          seq_head: bigint | string;
          rev: bigint | string;
          entries: bigint | string;
          participants: bigint | string;
          messages: bigint | string;
        }[]
      >`
        SELECT c.member_count, c.seq_head, c.rev,
          (SELECT COUNT(*) FROM chat.conversation_access WHERE conversation_id = c.id) AS entries,
          (SELECT COUNT(*) FROM chat.participants WHERE conversation_id = c.id) AS participants,
          (SELECT COUNT(*) FROM chat.messages WHERE conversation_id = c.id) AS messages
        FROM chat.conversations c WHERE c.id = ${chat.id}::uuid
      `;
      if (!row) throw new Error("Missing chat state");
      return row;
    };
    const before = await state();
    expect((await request(await cookie(writer), `/${chat.shortId}/members/preview`, "POST", { members })).status).toBe(403);
    const response = await request(headers, `/${chat.shortId}/members/preview`, "POST", { members });
    expect(response.status).toBe(200);
    expect(MemberPreviewSchema.parse(await response.json())).toEqual({ joining: 2, throughGroups: 1, memberCount: 5 });
    expect(await state()).toEqual(before);
    expect((await request(headers, `/${chat.shortId}/members`, "POST", { members })).status).toBe(200);
    expect((await state()).member_count).toBe(5);
    const repeated = await request(headers, `/${chat.shortId}/members/preview`, "POST", { members });
    expect(MemberPreviewSchema.parse(await repeated.json())).toEqual({ joining: 0, throughGroups: 0, memberCount: 5 });
  });

  test("member preview counts current people despite a stale cached count at the participant limit", async () => {
    const owner = await user();
    const peer = await user();
    const newcomer = await user();
    const headers = await cookie(owner);
    const chat = await fixture(owner, [{ id: peer, permission: "write" }]);
    for (const staleCount of [4999, 5000]) {
      await sql`UPDATE chat.conversations SET member_count = ${staleCount} WHERE id = ${chat.id}::uuid`;
      const response = await request(headers, `/${chat.shortId}/members/preview`, "POST", {
        members: [{ type: "user", userId: newcomer }],
      });
      expect(response.status).toBe(200);
      expect(MemberPreviewSchema.parse(await response.json())).toEqual({ joining: 1, throughGroups: 0, memberCount: 3 });
    }
  });

  test("preview and add return identical member validation failures", async () => {
    const owner = await user();
    const headers = await cookie(owner);
    const chat = await fixture(owner);
    const large = await group(await bulkUsers(501));
    const expired = await user("user", true);
    for (const members of [
      [{ type: "group", groupId: large }],
      [{ type: "user", userId: crypto.randomUUID() }],
      [{ type: "user", userId: expired }],
    ]) {
      const preview = await request(headers, `/${chat.shortId}/members/preview`, "POST", { members });
      const add = await request(headers, `/${chat.shortId}/members`, "POST", { members });
      expect(preview.status).toBe(400);
      expect(add.status).toBe(400);
      expect(await preview.json()).toEqual(await add.json());
    }
    const guest = await user("guest");
    const guestChat = await fixture(guest);
    const guestHeaders = await cookie(guest);
    for (const members of [[{ type: "group", groupId: large }], [{ type: "user", userId: owner }]]) {
      const preview = await request(guestHeaders, `/${guestChat.shortId}/members/preview`, "POST", { members });
      const add = await request(guestHeaders, `/${guestChat.shortId}/members`, "POST", { members });
      expect(preview.status).toBe(400);
      expect(await preview.json()).toEqual(await add.json());
    }
  });
});
