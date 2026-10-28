import { afterEach, expect, spyOn, test } from "bun:test";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { createAccess } from "@k2b/cloud/server";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { redis, sql } from "bun";
import { z } from "zod";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import { chatCapabilities } from "../capabilities";
import {
  ChatLiveEventSchema,
  ConversationPageSchema,
  ConversationSchema,
  NotificationsSchema,
  ThreadListSchema,
  ThreadSchema,
} from "../service/contracts";
import { defaultNotificationLevelSql, effectiveNotificationLevelSql, resolveNotifications } from "../service/notification-levels";
import { accessKey, resourceReaderDependencies } from "../service/resource-access";
import { messageFixtures, type Person } from "./messages.test-fixture";

suiteFor(
  "database",
  "nats",
  "valkey",
)("chat notification preferences", () => {
  const f = messageFixtures();
  const get = async (person: Person, chat: string) => ConversationSchema.parse(await (await f.request(person.headers, `/${chat}`)).json());
  const set = (person: Person, chat: string, input: unknown) => f.request(person.headers, `/${chat}/notifications`, "PUT", input);
  const preferences = async (person: Person, chat: string) =>
    NotificationsSchema.parse(await (await f.request(person.headers, `/${chat}/notifications`)).json());
  const keys = new Set<string>();
  let reader: ReturnType<typeof spyOn> | undefined;
  afterEach(async () => {
    reader?.mockRestore();
    reader = undefined;
    if (keys.size) await redis.send("DEL", [...keys]);
    keys.clear();
  });
  const system = async (person: Person) => {
    const container = testShortId(),
      item = testShortId();
    reader = spyOn(resourceReaderDependencies, "invoke").mockImplementation(async (_app, capability, input) => {
      if (capability === "space.read" && input.id === container)
        return {
          data: { id: container, name: "Project", permission: "write" },
          links: [{ rel: "open", href: `/app/spaces/${container}` }],
        };
      if (capability === "item.read" && input.id === item)
        return {
          data: { id: item, title: "Plinth for hall 2", kind: "task", spaceId: container },
          links: [{ rel: "open", href: `/app/spaces/${container}/${item}` }],
        };
      return null;
    });
    for (const [type, id] of [
      ["spaces.space", container],
      ["spaces.item", item],
    ])
      keys.add(accessKey(`user:${person.id}`, { type: type!, id: id! }));
    const chat = await f.fixture(person);
    await sql`UPDATE chat.conversations SET kind = 'system', resource_type = 'spaces.space', resource_id = ${container} WHERE id = ${chat.id}::uuid`;
    const response = await f.request(person.headers, `/${chat.shortId}/threads/for-resource`, "POST", {
      ref: { type: "spaces.item", id: item },
    });
    expect(response.status).toBe(200);
    return { chat, thread: ThreadSchema.parse(await response.json()) };
  };

  test("SQL and pure resolver agree across all kinds, roles, sizes, choices and expiry states", async () => {
    const now = new Date("2026-10-28T12:00:00Z");
    for (const kind of ["chat", "system"] as const)
      for (const channel of [false, true])
        for (const permission of ["read", "write", "admin"] as const)
          for (const memberCount of [20, 21])
            for (const notify of ["default", "all", "mentions", "none"] as const) {
              for (const notifyUntil of notify === "none"
                ? [null, new Date("2026-10-28T11:00:00Z"), now, new Date("2026-10-28T13:00:00Z")]
                : [null]) {
                const context = { kind, channel, permission, memberCount, notify, notifyUntil };
                const fragments = {
                  kind: sql`${kind}::text`,
                  channel: sql`${channel}::boolean`,
                  permission: sql`${permission}::text`,
                  memberCount: sql`${memberCount}::int`,
                  notify: sql`${notify}::text`,
                  notifyUntil: sql`${notifyUntil}::timestamptz`,
                  now: sql`${now}::timestamptz`,
                };
                const [row] = await sql<
                  { level: string; default_level: string }[]
                >`SELECT ${effectiveNotificationLevelSql(sql, fragments)} AS level, ${defaultNotificationLevelSql(sql, fragments)} AS default_level`;
                const expected = resolveNotifications(context, now);
                expect(row).toEqual({ level: expected.level, default_level: expected.defaultLevel });
              }
            }
  });

  test("round trips choices through detail and list; exact 20/21 boundary and explicit choice survives growth", async () => {
    const owner = await f.person();
    const chat = await f.fixture(owner);
    await sql`UPDATE chat.conversations SET member_count = 20 WHERE id = ${chat.id}::uuid`;
    expect((await get(owner, chat.shortId)).notifications).toEqual({
      level: "all",
      choice: null,
      until: null,
      defaultLevel: "all",
      following: null,
    });
    await sql`UPDATE chat.conversations SET member_count = 21 WHERE id = ${chat.id}::uuid`;
    expect((await get(owner, chat.shortId)).notifications?.level).toBe("mentions");
    expect((await set(owner, chat.shortId, { level: "all" })).status).toBe(200);
    await sql`UPDATE chat.conversations SET member_count = 500 WHERE id = ${chat.id}::uuid`;
    expect((await get(owner, chat.shortId)).notifications).toMatchObject({ level: "all", choice: "all", defaultLevel: "mentions" });
    const list = ConversationPageSchema.parse(await (await f.request(owner.headers, "")).json());
    expect(list.items.find((c) => c.id === chat.shortId)?.notifications).toEqual(await preferences(owner, chat.shortId));
    expect((await set(owner, chat.shortId, { level: "default" })).status).toBe(200);
    expect((await preferences(owner, chat.shortId)).choice).toBeNull();
  });

  test("read-only channel subscribers default to all; writers use member count; discovery has no preference row", async () => {
    const owner = await f.person(),
      reader = await f.person(),
      writer = await f.person(),
      outsider = await f.person();
    const chat = await f.fixture(owner, [
      { person: reader, permission: "read" },
      { person: writer, permission: "write" },
    ]);
    const grant = await createAccess({ principal: { type: "authenticated" }, permission: "read" });
    if (!grant.ok) throw new Error(grant.error.message);
    await sql`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id) VALUES (${chat.id}::uuid, ${grant.data.id}::uuid, 'discoverable', 'user', ${owner.id}::uuid)`;
    await sql`UPDATE chat.conversations SET member_count = 21 WHERE id = ${chat.id}::uuid`;
    expect((await get(reader, chat.shortId)).notifications?.defaultLevel).toBe("all");
    expect((await get(writer, chat.shortId)).notifications?.defaultLevel).toBe("mentions");
    expect((await get(outsider, chat.shortId)).notifications).toBeNull();
    expect((await set(outsider, chat.shortId, { level: "none", for: "forever" })).status).toBe(403);
    const hidden = await f.fixture(owner);
    expect((await set(outsider, hidden.shortId, { level: "all" })).status).toBe(404);
  });

  test("capabilities read and set the same subject-owned state", async () => {
    const owner = await f.person(),
      outsider = await f.person(),
      chat = await f.fixture(owner);
    const actor = owner.context.actor;
    if (actor.kind !== "user") throw new Error("Expected user fixture");
    const context: CapabilityExecutionContext = {
      actor,
      accessSubject: owner.context.accessSubject,
      user: actor.user,
      locale: "en",
      requestId: "notification-capability-fixture",
      origin: "http",
      signal: new AbortController().signal,
    };
    const changed = await chatCapabilities.actions["notifications.set"].run(
      { conversation: chat.shortId, notifications: { level: "mentions" } },
      context,
    );
    expect(changed).toMatchObject({ ok: true, data: { data: { level: "mentions", choice: "mentions" } } });
    expect(await chatCapabilities.queries["notifications.read"].run({ conversation: chat.shortId }, context)).toEqual({
      ok: true,
      data: { data: await preferences(owner, chat.shortId) },
    });
    const denied = await chatCapabilities.queries["notifications.read"].run(
      { conversation: chat.shortId },
      { ...context, actor: outsider.context.actor, accessSubject: outsider.context.accessSubject },
    );
    expect(denied).toMatchObject({ ok: false, error: { status: 404 } });
  });

  test("standalone and agent principals store choices with write scope, while read credentials cannot mutate", async () => {
    const owner = await f.person(),
      chat = await f.fixture(owner);
    for (const kind of ["standalone", "agent"] as const) {
      const [account] = await sql<
        { id: string }[]
      >`INSERT INTO auth.service_accounts (name, kind) VALUES (${`Chat preferences ${crypto.randomUUID()}`}, ${kind}) RETURNING id`;
      if (!account) throw new Error("Missing service account fixture");
      try {
        const access = await createAccess({ principal: { type: "service_account", serviceAccountId: account.id }, permission: "read" });
        if (!access.ok) throw new Error(access.error.message);
        await sql`INSERT INTO chat.conversation_access (conversation_id, access_id, role, added_by_type, added_by_id) VALUES (${chat.id}::uuid, ${access.data.id}::uuid, 'member', 'user', ${owner.id}::uuid)`;
        await sql`INSERT INTO chat.participants (principal_type, principal_id, conversation_id, origin, joined_seq) VALUES ('service_account', ${account.id}::uuid, ${chat.id}::uuid, 'direct', 0)`;
        for (const scopes of [
          ["openid", "read"],
          ["openid", "read", "write"],
        ]) {
          const token = await serviceAccountCredentials.createApiToken({
            serviceAccountId: account.id,
            name: "notification fixture",
            scopes,
          });
          if (!token.ok) throw new Error(token.error.message);
          const response = await f.request({ authorization: `Bearer ${token.data.token}` }, `/${chat.shortId}/notifications`, "PUT", {
            level: "mentions",
          });
          expect(response.status).toBe(scopes.includes("write") ? 200 : 403);
        }
        const [stored] = await sql<
          { notify: string }[]
        >`SELECT notify FROM chat.participants WHERE principal_id = ${account.id}::uuid AND conversation_id = ${chat.id}::uuid`;
        expect(stored!.notify).toBe("mentions");
      } finally {
        await sql`DELETE FROM events.outbox WHERE app_id = 'chat' AND ordering_key = ${`p:service_account:${account.id}`}`;
        await sql`DELETE FROM audit.events WHERE actor_uid = ${account.id} OR target_id = ${account.id}`;
        await sql`DELETE FROM auth.service_accounts WHERE id = ${account.id}::uuid`;
      }
    }
  });

  test("server computes durations; expired mutes reset without a cron and next preference write clears expiry", async () => {
    const owner = await f.person(),
      chat = await f.fixture(owner);
    for (const [duration, seconds] of [
      ["1h", 3600],
      ["8h", 28800],
      ["1w", 604800],
      ["forever", null],
    ] as const) {
      const [before] = await sql<{ now: Date }[]>`SELECT now() AS now`;
      expect((await set(owner, chat.shortId, { level: "none", for: duration })).status).toBe(200);
      const [stored] = await sql<
        { notify_until: Date | null; now: Date }[]
      >`SELECT notify_until, now() AS now FROM chat.participants WHERE conversation_id = ${chat.id}::uuid AND principal_id = ${owner.id}::uuid`;
      if (seconds === null) expect(stored!.notify_until).toBeNull();
      else {
        expect(stored!.notify_until!.getTime()).toBeGreaterThanOrEqual(before!.now.getTime() + seconds * 1000);
        expect(stored!.notify_until!.getTime()).toBeLessThanOrEqual(stored!.now.getTime() + seconds * 1000);
      }
    }
    await sql`UPDATE chat.participants SET notify_until = '2000-01-01T00:00:00Z'::timestamptz WHERE conversation_id = ${chat.id}::uuid`;
    expect(await preferences(owner, chat.shortId)).toMatchObject({ level: "all", choice: null, until: null });
    expect((await set(owner, chat.shortId, { level: "mentions" })).status).toBe(200);
    const [stored] = await sql<
      { notify_until: Date | null }[]
    >`SELECT notify_until FROM chat.participants WHERE conversation_id = ${chat.id}::uuid`;
    expect(stored!.notify_until).toBeNull();
    for (const input of [
      { level: "all", for: "1h" },
      { level: "none" },
      { level: "none", for: "2h" },
      { level: "none", for: "1h", until: "2030-01-01" },
    ])
      expect((await set(owner, chat.shortId, input)).status).toBe(400);
    await expect(sql`UPDATE chat.participants SET notify_until = now() WHERE conversation_id = ${chat.id}::uuid`).rejects.toThrow();
  });

  test("mentionsUnread deduplicates a mention plus reply, tracks reads, and remains visible when muted", async () => {
    const owner = await f.person("Owner"),
      other = await f.person("Other");
    const chat = await f.fixture(owner, [{ person: other, permission: "write" }]);
    const original = await f.request(owner.headers, `/${chat.shortId}/messages`, "POST", { clientId: "original", body: "Question" });
    const originalBody = z.object({ id: z.string() }).parse(await original.json());
    expect(
      (
        await f.request(other.headers, `/${chat.shortId}/messages`, "POST", {
          clientId: "reply",
          body: "Owner",
          replyTo: originalBody.id,
          mentions: [{ principal: { type: "user", id: owner.id }, start: 0, end: 5 }],
        })
      ).status,
    ).toBe(201);
    expect((await get(owner, chat.shortId)).mentionsUnread).toBe(1);
    await set(owner, chat.shortId, { level: "none", for: "forever" });
    expect((await get(owner, chat.shortId)).mentionsUnread).toBe(1);
    expect((await f.request(owner.headers, `/${chat.shortId}/read`, "POST", { seq: 2 })).status).toBe(200);
    expect((await get(owner, chat.shortId)).mentionsUnread).toBe(0);
  });

  test("mention counts stop at the shared display cap", async () => {
    const owner = await f.person("Owner"),
      other = await f.person("Other"),
      chat = await f.fixture(owner, [{ person: other, permission: "write" }]);
    const prefix = testShortId();
    await sql`INSERT INTO chat.messages (short_id, conversation_id, seq, rev, kind, author_type, author_id, author_name, client_id, body_md, created_at)
      SELECT ${prefix} || lpad(n::text, 4, '0'), ${chat.id}::uuid, n, n, 'text', 'user', ${other.id}::uuid, 'Other', n::text, 'Owner', '2026-10-28T12:00:00Z'::timestamptz FROM generate_series(1, 110) n`;
    await sql`INSERT INTO chat.message_mentions (message_id, principal_type, principal_id, start_offset, end_offset, created_at)
      SELECT id, 'user', ${owner.id}::uuid, 0, 5, created_at FROM chat.messages WHERE conversation_id = ${chat.id}::uuid`;
    await sql`UPDATE chat.conversations SET seq_head = 110, rev = 110, changed_rev = 110, last_activity_at = '2026-10-28T12:00:00Z'::timestamptz WHERE id = ${chat.id}::uuid`;
    expect((await get(owner, chat.shortId)).mentionsUnread).toBe(99);
  });

  test("posting follows system item discussions; idempotent follow/unfollow, authorized summary, and participant cascade", async () => {
    const owner = await f.person();
    const { chat, thread } = await system(owner);
    expect(thread.following).toBeFalse();
    expect(await preferences(owner, chat.shortId)).toMatchObject({ defaultLevel: "mentions", following: { count: 0, first: null } });
    const path = `/${chat.shortId}/threads/${thread.id}/follow`;
    await sql`DELETE FROM chat.participants WHERE conversation_id = ${chat.id}::uuid AND principal_id = ${owner.id}::uuid`;
    expect(
      (
        await f.request(owner.headers, `/${chat.shortId}/messages`, "POST", {
          clientId: "item-message",
          body: "Question",
          thread: thread.id,
        })
      ).status,
    ).toBe(201);
    const list = ThreadListSchema.parse(await (await f.request(owner.headers, `/${chat.shortId}/threads`)).json());
    expect(list.items.find((t) => t.id === thread.id)?.following).toBeTrue();
    expect((await preferences(owner, chat.shortId)).following).toEqual({ count: 1, first: { id: thread.id, name: "Plinth for hall 2" } });
    for (const method of ["DELETE", "DELETE", "PUT", "PUT"] as const) {
      const response = await f.request(owner.headers, path, method);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ following: method === "PUT" });
    }
    await f.request(owner.headers, path, "DELETE");
    // Retrying a stored message does not silently undo an explicit unfollow.
    expect(
      (
        await f.request(owner.headers, `/${chat.shortId}/messages`, "POST", {
          clientId: "item-message",
          body: "Question",
          thread: thread.id,
        })
      ).status,
    ).toBe(200);
    expect((await preferences(owner, chat.shortId)).following?.count).toBe(0);
    await f.request(owner.headers, path, "PUT");
    await sql`DELETE FROM chat.participants WHERE conversation_id = ${chat.id}::uuid AND principal_id = ${owner.id}::uuid`;
    const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM chat.thread_follows WHERE conversation_id = ${chat.id}::uuid`;
    expect(count!.n).toBe(0);
    expect((await f.request(owner.headers, path, "PUT")).status).toBe(403);
  });

  test("following summaries never disclose an unreadable item and ordinary threads cannot be followed", async () => {
    const owner = await f.person();
    const { chat, thread } = await system(owner);
    expect((await f.request(owner.headers, `/${chat.shortId}/threads/${thread.id}/follow`, "PUT")).status).toBe(200);
    await redis.send("DEL", [accessKey(`user:${owner.id}`, thread.resource!.ref)]);
    reader?.mockImplementation(async () => null);
    expect((await preferences(owner, chat.shortId)).following).toEqual({ count: 1, first: null });
    expect((await f.request(owner.headers, `/${chat.shortId}/threads/${thread.id}/follow`, "PUT")).status).toBe(404);
    const ordinary = await f.fixture(owner);
    const response = await f.request(owner.headers, `/${ordinary.shortId}/threads`, "POST", { name: "Discussion" });
    const manual = ThreadSchema.parse(await response.json());
    expect((await f.request(owner.headers, `/${ordinary.shortId}/threads/${manual.id}/follow`, "PUT")).status).toBe(404);
  });

  test("preference and follow writes enqueue only a content-free personal hint", async () => {
    const owner = await f.person();
    const { chat, thread } = await system(owner);
    await set(owner, chat.shortId, { level: "none", for: "1h" });
    await f.request(owner.headers, `/${chat.shortId}/threads/${thread.id}/follow`, "PUT");
    const rows = await sql<
      { payload: unknown }[]
    >`SELECT payload FROM events.outbox WHERE app_id = 'chat' AND ordering_key = ${"p:" + owner.id} AND payload->'d'->>'type' = 'notifications'`;
    expect(rows.length).toBe(2);
    for (const row of rows) expect(z.object({ d: ChatLiveEventSchema }).parse(row.payload).d).toEqual({ type: "notifications" });
  });
});
