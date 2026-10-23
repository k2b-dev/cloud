import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { type AuthContext, createAccess, respond } from "@k2b/cloud/server";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { sql } from "bun";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import chatApi from "../api";
import { messageFixtures } from "../api/messages.test-fixture";
import { countAudience } from "./channels";
import { DiscoveryPreviewSchema, MemberPageSchema } from "./contracts";
import { chatLiveChannels } from "./live-channels";

setDefaultTimeout(30_000);
const suite = suiteFor("database", "nats", "valkey");
suite("channel authorization, publication and audience bounds", () => {
  const f = messageFixtures();
  const server = new Hono<AuthContext>().route("/api/chat", chatApi);
  const accountIds: string[] = [];
  const credential = async (kind: "standalone" | "agent") => {
    const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind)
      VALUES ('Channel regression', ${kind}) RETURNING id`;
    if (!account) throw new Error("Missing fixture account");
    accountIds.push(account.id);
    return account.id;
  };
  const token = async (serviceAccountId: string, scope: "read" | "write" | "admin") => {
    const result = await serviceAccountCredentials.createApiToken({
      serviceAccountId,
      name: `Channel ${scope} test`,
      scopes: scope === "read" ? ["openid", "read"] : ["openid", "read", scope],
    });
    if (!result.ok) throw new Error(result.error.message);
    return { authorization: `Bearer ${result.data.token}` };
  };
  const preview = (headers: Record<string, string>, input: unknown) =>
    server.request("https://cloud.example.test/api/chat/channels/preview", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "x-forwarded-for": uniqueCallerAddress() },
      body: JSON.stringify(input),
    });
  afterAll(async () => {
    for (const id of accountIds) {
      await sql`DELETE FROM events.outbox WHERE app_id = 'chat' AND ordering_key = ${"p:service_account:" + id}`;
      await sql`DELETE FROM audit.events WHERE target_id = ${id} OR actor_uid = ${id} OR metadata->>'serviceAccountId' = ${id}`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
    }
  });

  for (const kind of ["standalone", "agent"] as const) {
    test(`${kind} succession requires an admin token and refused transfers preserve grants and membership`, async () => {
      const successor = await f.person("Successor");
      const chat = await f.fixture(successor);
      const accountId = await credential(kind);
      const access = await createAccess({ principal: { type: "service_account", serviceAccountId: accountId }, permission: "admin" });
      if (!access.ok) throw new Error(access.error.message);
      await sql`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id)
        VALUES (${chat.id}::uuid, ${access.data.id}::uuid, 'member', 'user', ${successor.id}::uuid)`;
      await sql`INSERT INTO chat.participants (conversation_id, principal_type, principal_id, origin, joined_seq)
        VALUES (${chat.id}::uuid, 'service_account', ${accountId}::uuid, 'direct', 0)`;
      await sql`UPDATE chat.conversations SET member_count = 2 WHERE id = ${chat.id}::uuid`;
      const successorId = chat.entries.get(successor.id)!;
      await sql`UPDATE auth.access SET permission = 'write' WHERE id = ${successorId}::uuid`;
      const state = async () => {
        const [row] = await sql<{ state: unknown }[]>`SELECT jsonb_build_object(
          'conversation', to_jsonb(c),
          'grants', (SELECT jsonb_agg(jsonb_build_object('access', to_jsonb(a), 'link', to_jsonb(ca)) ORDER BY a.id)
            FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id WHERE ca.conversation_id = c.id),
          'participants', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.principal_id) FROM chat.participants p WHERE p.conversation_id = c.id)
        ) AS state FROM chat.conversations c WHERE c.id = ${chat.id}::uuid`;
        return row!.state;
      };
      const before = await state();
      for (const scope of ["read", "write"] as const) {
        const response = await f.request(await token(accountId, scope), `/${chat.shortId}/leave`, "POST", { successor: successorId });
        expect(response.status).toBe(403);
        expect(await state()).toEqual(before);
      }
      expect((await f.request(await token(accountId, "admin"), `/${chat.shortId}/leave`, "POST", { successor: successorId })).status).toBe(
        200,
      );
      const members = MemberPageSchema.parse(await (await f.request(successor.headers, `/${chat.shortId}/members`)).json());
      expect(members.items).toHaveLength(1);
      expect(members.items[0]).toMatchObject({ accessId: successorId, permission: "admin" });
      expect(await sql`SELECT 1 FROM auth.access WHERE id = ${access.data.id}::uuid`).toHaveLength(0);
      expect(
        await sql`SELECT 1 FROM chat.participants WHERE conversation_id = ${chat.id}::uuid AND principal_id = ${accountId}::uuid`,
      ).toHaveLength(0);
    });

    test(`${kind} preview refuses existing and missing groups exactly like creation`, async () => {
      const member = await f.person("Directory member");
      const groupId = await f.group([member]);
      const headers = await token(await credential(kind), "admin");
      let refusal: unknown;
      for (const id of [groupId, crypto.randomUUID()]) {
        const entries = [{ principal: { type: "group", groupId: id }, permission: "read" }];
        const creation = await f.request(headers, "", "POST", { name: "Channel", purpose: "Updates", discovery: entries });
        const result = await preview(headers, entries);
        expect(creation.status).toBe(400);
        expect(result.status).toBe(creation.status);
        const body = await result.json();
        expect(body).toEqual(await creation.json());
        expect(body).not.toHaveProperty("audienceCount");
        if (refusal) expect(body).toEqual(refusal);
        refusal = body;
      }
    });
  }

  test("guest preview still refuses group audiences without revealing whether a group exists", async () => {
    const guest = await f.person("Guest");
    await sql`UPDATE auth.users SET profile = 'guest' WHERE id = ${guest.id}::uuid`;
    const group = await f.group([guest]);
    const bodies: unknown[] = [];
    for (const groupId of [group, crypto.randomUUID()]) {
      const response = await preview(guest.headers, [{ principal: { type: "group", groupId }, permission: "read" }]);
      expect(response.status).toBe(400);
      bodies.push(await response.json());
    }
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]).not.toHaveProperty("audienceCount");
  });

  test("leaving tells whether the channel's audience still lets the person subscribe again", async () => {
    const owner = await f.person("Owner");
    const reader = await f.person("Group reader");
    const outsider = await f.person("Added directly");
    const chat = await f.fixture(owner, [{ person: outsider, permission: "read" }]);
    const groupId = await f.group([reader]);
    const audience = [{ principal: { type: "group", groupId }, permission: "read" }];
    expect(
      (await f.request(owner.headers, `/${chat.shortId}/discovery`, "PUT", { entries: audience, name: "News", purpose: "Updates" })).status,
    ).toBe(200);
    expect((await f.request(reader.headers, `/${chat.shortId}/join`, "POST")).status).toBe(200);
    const left = async (person: typeof reader) =>
      (await (await f.request(person.headers, `/${chat.shortId}/leave`, "POST", {})).json()) as { canRejoin: boolean };
    expect((await left(reader)).canRejoin).toBe(true);
    // Outside the audience, only a manager can add them again.
    expect((await left(outsider)).canRejoin).toBe(false);
    expect((await f.request(outsider.headers, `/${chat.shortId}/join`, "POST")).status).toBe(404);
  });

  test("a change based on an older audience is refused and leaves the newer one in place", async () => {
    const owner = await f.person("Owner");
    const reader = await f.person("Reader");
    const chat = await f.fixture(owner);
    const groupId = await f.group([reader]);
    const audience = [{ principal: { type: "group", groupId }, permission: "read" }];
    const put = (body: object) => f.request(owner.headers, `/${chat.shortId}/discovery`, "PUT", body);
    expect((await put({ entries: audience, name: "News", purpose: "Updates" })).status).toBe(200);
    const read = async () =>
      (await (await f.request(owner.headers, `/${chat.shortId}/discovery`, "GET")).json()) as { revision: string; entries: unknown[] };
    const opened = await read();
    expect(opened.revision).toMatch(/^[0-9a-f]{64}$/);
    // One admin removes the audience; a dialog opened before tries to save it again.
    expect((await put({ entries: [], revision: opened.revision })).status).toBe(200);
    const stale = await put({ entries: audience, purpose: "New purpose", revision: opened.revision });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe("DISCOVERY_CHANGED");
    const now = await read();
    expect(now.entries).toEqual([]);
    expect(now.revision).not.toBe(opened.revision);
    expect((await put({ entries: audience, purpose: "New purpose", revision: now.revision })).status).toBe(200);
  });

  test("combined discovery and details updates enqueue both access hints before any data", async () => {
    const owner = await f.person("Owner");
    const reader = await f.person("Removed reader");
    const chat = await f.fixture(owner);
    const groupId = await f.group([reader]);
    expect(
      (
        await f.request(owner.headers, `/${chat.shortId}/discovery`, "PUT", {
          entries: [{ principal: { type: "group", groupId }, permission: "read" }],
          name: "Public details",
          purpose: "Updates",
        })
      ).status,
    ).toBe(200);
    const viewer = { id: `user:${reader.id}`, ...reader.context, scopes: [] };
    expect(await chatLiveChannels.conversation.authorize(`c:${chat.shortId}`, [viewer])).toEqual(new Set([viewer.id]));
    await sql`DELETE FROM events.outbox WHERE app_id = 'chat' AND ordering_key IN (${"c:" + chat.shortId}, ${"l:" + chat.shortId})`;
    expect(
      (
        await f.request(owner.headers, `/${chat.shortId}/discovery`, "PUT", {
          entries: [],
          name: "Private details",
          purpose: "Private purpose",
        })
      ).status,
    ).toBe(200);
    const rows = await sql<
      { ordering_key: string; payload: { a?: boolean; d?: { type: string; message?: { system?: { code: string } } } } }[]
    >`
      SELECT ordering_key, payload FROM events.outbox WHERE app_id = 'chat'
      AND ordering_key IN (${"c:" + chat.shortId}, ${"l:" + chat.shortId}) ORDER BY seq`;
    const firstData = rows.findIndex((row) => row.payload.d !== undefined);
    expect(firstData).toBeGreaterThanOrEqual(2);
    for (const key of [`c:${chat.shortId}`, `l:${chat.shortId}`]) {
      const access = rows.findIndex((row) => row.ordering_key === key && row.payload.a === true);
      expect(access).toBeGreaterThanOrEqual(0);
      expect(access).toBeLessThan(firstData);
    }
    expect(rows.some((row) => row.payload.d?.message?.system?.code === "details_changed")).toBe(true);
    expect(rows.some((row) => row.ordering_key === `l:${chat.shortId}` && row.payload.d?.type === "summary")).toBe(true);
    expect(await chatLiveChannels.conversation.authorize(`c:${chat.shortId}`, [viewer])).toEqual(new Set());
    expect(await chatLiveChannels.list.authorize(`l:${chat.shortId}`, [viewer])).toEqual(new Set());
  });

  test("audience counts deduplicate overlapping groups and terminate on cycles", async () => {
    const owner = await f.person("Owner");
    const first = await f.person("First");
    const shared = await f.person("Shared");
    const last = await f.person("Last");
    const parent = await f.group([first, shared]);
    const sibling = await f.group([shared]);
    const child = await f.group([shared, last]);
    await sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES
      (${parent}::uuid, ${child}::uuid), (${sibling}::uuid, ${child}::uuid), (${child}::uuid, ${parent}::uuid)`;
    const entries = [parent, sibling, child].map((groupId) => ({
      principal: { type: "group" as const, groupId },
      permission: "read" as const,
    }));
    const response = await preview(owner.headers, entries);
    expect(response.status).toBe(200);
    expect(DiscoveryPreviewSchema.parse(await response.json())).toEqual({ audienceCount: 3, includesAuthenticated: false });
    await sql.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '9s'`;
      expect(await countAudience(tx, entries, owner.context)).toMatchObject({ ok: true, data: { audienceCount: 3 } });
      expect((await tx<{ timeout: string }[]>`SELECT current_setting('statement_timeout') AS timeout`)[0]?.timeout).toBe("9s");
    });
  });

  test("audience timeout returns a visible 503 without a partial count and leaves the transaction usable", async () => {
    const owner = await f.person("Owner");
    const groupId = await f.group([owner]);
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    // Hold a conflicting lock so the real count reliably exceeds the tiny test
    // budget, independent of machine speed and fixture size.
    const blocker = sql.begin(async (tx) => {
      await tx`LOCK TABLE auth.group_groups_v2 IN ACCESS EXCLUSIVE MODE`;
      locked.resolve();
      await release.promise;
    });
    try {
      await Promise.race([locked.promise, blocker]);
      await sql.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout = '9s'`;
        const result = await countAudience(
          tx,
          [{ principal: { type: "group", groupId }, permission: "read" }],
          owner.context,
          undefined,
          1,
        );
        expect(result).toMatchObject({ ok: false, code: "AUDIENCE_UNAVAILABLE", status: 503, error: expect.any(String) });
        expect(result).not.toHaveProperty("data");
        const response = await new Hono().get("/", (c) => respond(c, result)).request("/");
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ code: "AUDIENCE_UNAVAILABLE", message: expect.any(String) });
        expect((await tx<{ timeout: string }[]>`SELECT current_setting('statement_timeout') AS timeout`)[0]?.timeout).toBe("9s");
        expect(await tx<{ usable: number }[]>`SELECT 1 AS usable`).toEqual([{ usable: 1 }]);
      });
    } finally {
      release.resolve();
      await blocker;
    }
  });
});
