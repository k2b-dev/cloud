import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { type AuthContext, createAccess, type PermissionLevel } from "@k2b/cloud/server";
import { serviceAccountCredentials, toPgTextArray, toPgUuidArray } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { migrate } from "../migrate";
import { ConversationPageSchema, ConversationSchema, CreateOutcomeSchema, MemberPageSchema } from "../service/contracts";
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

suite("chat conversations and direct members", () => {
  const users: string[] = [];
  const accounts: string[] = [];
  const conversations: string[] = [];
  const accessIds: string[] = [];
  const user = async (profile = "user", expired = false) => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, given_name, account_expires)
      VALUES (${`chat-${crypto.randomUUID()}`}, 'local', ${profile}, 'Lea Example', 'Lea', ${expired ? new Date(0) : null}) RETURNING id`;
    users.push(row!.id);
    return row!.id;
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
    const shortId = crypto.randomUUID().replaceAll("-", "").slice(0, 6);
    const [row] = await sql<{ id: string }[]>`INSERT INTO chat.conversations (short_id, created_by_type, created_by_id)
      VALUES (${shortId}, 'user', ${owner}::uuid) RETURNING id`;
    conversations.push(shortId);
    const ownerAccess = await grant(row!.id, owner, "admin", owner);
    const entries = new Map([[owner, ownerAccess]]);
    for (const member of members) entries.set(member.id, await grant(row!.id, member.id, member.permission, owner));
    return { id: row!.id, shortId, entries, ownerAccess };
  };
  const create = async (headers: Headers, members: string[], other: Record<string, unknown> = {}) => {
    const response = await request(headers, "", "POST", { members, ...other });
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
    for (const shortId of conversations) {
      await sql`DELETE FROM events.outbox WHERE app_id = 'chat' AND ordering_key IN (${"c:" + shortId}, ${"l:" + shortId})`;
      await sql`DELETE FROM audit.events WHERE target_type = 'chat_conversation' AND target_id = ${shortId}`;
      await sql`DELETE FROM chat.conversations WHERE short_id = ${shortId}`;
    }
    const allAccess = [...new Set([...accessIds, ...rows.map((row) => row.access_id)])];
    if (allAccess.length) await sql`DELETE FROM auth.access WHERE id = ANY(${toPgUuidArray(allAccess)}::uuid[])`;
    for (const id of accounts) {
      await sql`DELETE FROM audit.events WHERE target_id = ${id} OR actor_uid = ${id} OR metadata->>'serviceAccountId' = ${id}`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
    }
    for (const id of users) {
      await sql`DELETE FROM audit.events WHERE actor_user_id = ${id}::uuid OR target_id = ${id}`;
      await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
    }
  });

  const operations = ["create", "list", "detail", "update", "members", "add", "permission", "remove", "leave"] as const;
  for (const delegated of [false, true])
    for (const permission of ["none", "read", "write", "admin"] as const)
      for (const operation of operations) {
        test(`${delegated ? "delegated person" : "session"}: ${permission} → ${operation}`, async () => {
          const owner = await user();
          const caller = await user();
          const target = await user();
          const newcomer = await user();
          const chat = await fixture(owner, [
            { id: target, permission: "write" },
            ...(permission === "none" ? [] : [{ id: caller, permission }]),
          ]);
          // The delegated credential deliberately has read-only scopes: user grants still decide.
          const headers = delegated ? (await credential("user_delegated", caller)).headers : await cookie(caller);
          const path = `/${chat.shortId}`;
          const response =
            operation === "create"
              ? await request(headers, "", "POST", { members: [newcomer] })
              : operation === "list"
                ? await request(headers)
                : operation === "detail"
                  ? await request(headers, path)
                  : operation === "update"
                    ? await request(headers, path, "PATCH", { name: "Changed" })
                    : operation === "members"
                      ? await request(headers, `${path}/members`)
                      : operation === "add"
                        ? await request(headers, `${path}/members`, "POST", { members: [newcomer] })
                        : operation === "permission"
                          ? await request(headers, `${path}/members/${chat.entries.get(target)}`, "PATCH", { permission: "read" })
                          : operation === "remove"
                            ? await request(headers, `${path}/members/${chat.entries.get(target)}`, "DELETE")
                            : await request(headers, `${path}/leave`, "POST", {});
          const expected =
            operation === "create"
              ? 201
              : operation === "list"
                ? 200
                : permission === "none"
                  ? 404
                  : operation === "update" && permission === "read"
                    ? 403
                    : ["add", "permission", "remove"].includes(operation) && permission !== "admin"
                      ? 403
                      : 200;
          expect(response.status).toBe(expected);
          if (operation === "create") {
            const result = CreateOutcomeSchema.parse(await response.json());
            if (result.outcome !== "created") throw new Error("Expected creation");
            conversations.push(result.conversation.id);
          } else if (operation === "list") {
            const result = ConversationPageSchema.parse(await response.json());
            expect(result.items.some((item) => item.id === chat.shortId)).toBe(permission !== "none");
          } else if (operation === "detail" && expected === 200 && permission !== "none") {
            expect(ConversationSchema.parse(await response.json()).permission).toBe(permission);
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
      expect((await response.json()).message).toBe("Only people can be chat members for now.");
      const ownerHeaders = await cookie(owner);
      for (const path of ["", `/${chat.shortId}/members`]) {
        const rejected = await request(ownerHeaders, path, "POST", { members: [account.id] });
        expect(rejected.status).toBe(400);
        expect((await rejected.json()).message).toBe("Only people can be chat members for now.");
      }
      const path = `/${chat.shortId}`;
      for (const [suffix, method, body] of [
        [path, "GET", undefined],
        [path, "PATCH", { name: "Blocked" }],
        [`${path}/members`, "GET", undefined],
        [`${path}/members`, "POST", { members: [target] }],
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
      const response = await request(headers, "", "POST", { members: [...members].reverse() });
      expect(response.status).toBe(200);
      const result = CreateOutcomeSchema.parse(await response.json());
      expect(result).toMatchObject({ outcome: "existing", matches: [{ id: expected }] });
    }
    const duplicate = await create(headers, [ids[1]!], { allowDuplicate: true });
    const [row] = await sql<{ id: string }[]>`SELECT id FROM chat.conversations WHERE short_id = ${pair.id}`;
    await grant(row!.id, ids[2]!, "read", owner, "discoverable");
    const found = CreateOutcomeSchema.parse(await (await request(headers, "", "POST", { members: [ids[1]!] })).json());
    expect(found).toMatchObject({ outcome: "existing", matches: [{ id: duplicate.id }] });
    const otherSelf = await create(await cookie(ids[1]!), []);
    expect(otherSelf.id).not.toBe(self.id);
    await sql`UPDATE chat.participants SET archived_at = now() WHERE conversation_id = (SELECT id FROM chat.conversations WHERE short_id = ${duplicate.id}) AND principal_id = ${owner}::uuid`;
    const archived = CreateOutcomeSchema.parse(await (await request(headers, "", "POST", { members: [ids[1]!] })).json());
    expect(archived).toMatchObject({ outcome: "existing", matches: [{ id: duplicate.id, archived: true }] });
  });

  test("a deleted account cannot hide an existing chat from the duplicate check", async () => {
    const owner = await user();
    const b = await user();
    const c = await user();
    const headers = await cookie(owner);
    const chat = await create(headers, [b, c]);
    await sql`DELETE FROM auth.users WHERE id = ${c}::uuid`;
    const response = await request(headers, "", "POST", { members: [b] });
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
          Promise.resolve(request(headers, "", "POST", { members: [other] })).then(async (response) => {
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
    expect((await request(headers, `${path}/members`, "POST", { members: [successor] })).status).toBe(200);
    const updatedMembers = MemberPageSchema.parse(await (await request(headers, `${path}/members`)).json());
    const successorEntry = updatedMembers.items.find((member) => member.principal.userId === successor);
    if (!successorEntry) throw new Error("Expected the active successor's member entry");
    expect((await request(headers, `${path}/leave`, "POST", { successor: successorEntry.accessId })).status).toBe(200);
    const conversation = ConversationSchema.parse(await (await request(await cookie(successor), path)).json());
    expect(conversation.permission).toBe("admin");
  });

  test("rejects unknown, expired, guest, and group members with localized errors; guests create only for themselves", async () => {
    const owner = await user();
    const headers = await cookie(owner);
    const guest = await user("guest");
    const expired = await user("user", true);
    const groupId = crypto.randomUUID();
    await sql`INSERT INTO auth.groups (id, cn, provider, name) VALUES (${groupId}::uuid, ${`chat-${groupId}`}, 'local', ${`chat-${groupId}`})`;
    try {
      for (const [id, message] of [
        [crypto.randomUUID(), "Ein ausgewähltes Konto existiert nicht oder ist nicht mehr aktiv."],
        [expired, "Ein ausgewähltes Konto existiert nicht oder ist nicht mehr aktiv."],
        [guest, "Gastkonten können noch nicht zu Chats hinzugefügt werden."],
        [groupId, "Gruppen können noch keine Chat-Mitglieder sein."],
      ] as const) {
        const response = await request({ ...headers, "accept-language": "de-DE" }, "", "POST", { members: [id] });
        expect(response.status).toBe(400);
        expect((await response.json()).message).toBe(message);
      }
      const guestHeaders = await cookie(guest);
      expect((await request(guestHeaders, "", "POST", { members: [owner] })).status).toBe(400);
      const guestChat = await create(guestHeaders, [guest]);
      expect(guestChat.title).toBe("You");
      const invite = await request(guestHeaders, `/${guestChat.id}/members`, "POST", { members: [owner] });
      expect(invite.status).toBe(400);
      expect((await invite.json()).message).toBe("Guests cannot add other people to chats yet.");
    } finally {
      await sql`DELETE FROM auth.groups WHERE id = ${groupId}::uuid`;
    }
  });

  test("deduplicates member additions, preserves sequence/read state, and leaves activity unchanged", async () => {
    const owner = await user();
    const other = await user();
    const chat = await fixture(owner);
    const headers = await cookie(owner);
    await sql`UPDATE chat.conversations SET seq_head = 42 WHERE id = ${chat.id}::uuid`;
    const before = ConversationSchema.parse(await (await request(headers, `/${chat.shortId}`)).json());
    expect((await request(headers, `/${chat.shortId}/members`, "POST", { members: [other, other, owner] })).status).toBe(200);
    const repeated = await request(headers, `/${chat.shortId}/members`, "POST", { members: [other] });
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
    expect((await request(headers, "", "POST", { members: [crypto.randomUUID()] })).status).toBe(400);
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
      const response = await request(headers, "", "POST", { members: [other] });
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
    for (let i = 0; i < 30; i++) await create(headers, [], { allowDuplicate: true });
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
    for (let i = 0; i < 101; i++) await grant(chat.id, await user(), "write", owner);
    const path = `/${chat.shortId}/members`;
    const first = MemberPageSchema.parse(await (await request(headers, path)).json());
    expect(first.items).toHaveLength(100);
    const second = MemberPageSchema.parse(await (await request(headers, `${path}?cursor=${first.nextCursor}`)).json());
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((member) => member.accessId)).size).toBe(102);
    // Participant principals intentionally have no FK to Accounts; fill the operational budget without creating directory accounts.
    await sql`INSERT INTO chat.participants (principal_type, principal_id, conversation_id, origin, joined_seq)
      SELECT 'user', gen_random_uuid(), ${chat.id}::uuid, 'ondemand', 0 FROM generate_series(1, 4898)`;
    const added = await request(headers, path, "POST", { members: [await user()] });
    expect(added.status).toBe(400);
    expect((await added.json()).message).toBe("A chat can have at most 5,000 members.");
    const detail = ConversationSchema.parse(await (await request(headers, `/${chat.shortId}`)).json());
    expect(detail.memberCount).toBe(102);
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
    await request(headers, `${path}/members`, "POST", { members: [newcomer] });
    const members = MemberPageSchema.parse(await (await request(headers, `${path}/members`)).json());
    const otherEntry = members.items.find((entry) => entry.principal.userId === other)!;
    const newEntry = members.items.find((entry) => entry.principal.userId === newcomer)!;
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
});
