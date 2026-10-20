import { expect, test } from "bun:test";
import { lazySync } from "@k2b/cloud";
import { toPgTextArray, toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import { messageFixtures } from "../api/messages.test-fixture";
import { ConversationSchema, CreateOutcomeSchema, MessagePageSchema } from "./contracts";
import { maintenanceLifecycle, reconcile } from "./maintenance";

const suite = suiteFor("database", "nats", "valkey");
suite("chat membership maintenance", () => {
  const f = messageFixtures();
  const run = () => reconcile({ signal: new AbortController().signal, heartbeat: () => {} });
  const state = async (id: string) => {
    const [row] = await sql<{ state: unknown }[]>`SELECT jsonb_build_object(
      'conversation', to_jsonb(c),
      'participants', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.principal_id) FROM chat.participants p WHERE p.conversation_id = c.id),
      'access', (SELECT jsonb_agg(jsonb_build_object('entry', to_jsonb(a), 'link', to_jsonb(ca)) ORDER BY a.id)
        FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id WHERE ca.conversation_id = c.id),
      'messages', (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.seq) FROM chat.messages m WHERE m.conversation_id = c.id)
    ) AS state FROM chat.conversations c WHERE c.id = ${id}::uuid`;
    return row?.state;
  };

  test("removes former group participants, keeps deleted direct markers, repairs counts without events, and is idempotent", async () => {
    const owner = await f.person("Owner");
    const leaving = await f.person("Leaving");
    const remaining = await f.person("Remaining");
    const deleted = await f.person("Deleted");
    const chat = await f.fixture(owner, [{ person: deleted, permission: "write" }]);
    const groupId = await f.group([leaving, remaining]);
    expect((await f.request(owner.headers, `/${chat.shortId}/members`, "POST", { members: [{ type: "group", groupId }] })).status).toBe(
      200,
    );
    await sql`DELETE FROM auth.user_groups_v2 WHERE group_id = ${groupId}::uuid AND user_id = ${leaving.id}::uuid`;
    await sql`DELETE FROM auth.users WHERE id = ${deleted.id}::uuid`;
    const [before] = await sql<{ rev: string }[]>`SELECT rev FROM chat.conversations WHERE id = ${chat.id}::uuid`;
    const outbox = () =>
      sql`SELECT seq, payload FROM events.outbox WHERE app_id = 'chat' AND ordering_key IN (${"c:" + chat.shortId}, ${"l:" + chat.shortId}) ORDER BY seq`;
    const events = await outbox();
    await run();
    const participants = await sql<
      { principal_id: string; origin: string }[]
    >`SELECT principal_id, origin FROM chat.participants WHERE conversation_id = ${chat.id}::uuid ORDER BY principal_id`;
    expect(new Set(participants.map((row) => row.principal_id))).toEqual(new Set([owner.id, remaining.id, deleted.id]));
    expect(participants.find((row) => row.principal_id === deleted.id)?.origin).toBe("direct");
    const [head] = await sql<
      { member_count: number; rev: string }[]
    >`SELECT member_count, rev FROM chat.conversations WHERE id = ${chat.id}::uuid`;
    expect(head).toEqual({ member_count: 2, rev: before!.rev });
    expect(await outbox()).toEqual(events);
    const stable = await state(chat.id);
    await run();
    expect(await state(chat.id)).toEqual(stable);
  });

  for (const throughGroup of [false, true])
    test(`last-manager succession to ${throughGroup ? "group-only" : "direct"} member is atomic and publishes a hint`, async () => {
      const owner = await f.person("Old manager");
      const successor = await f.person("Successor");
      const newer = await f.person("Newer");
      const expired = await f.person("Expired");
      const chat = await f.fixture(owner, throughGroup ? [] : [{ person: successor, permission: "read" }]);
      const groupId = await f.group([successor, newer, expired]);
      expect((await f.request(owner.headers, `/${chat.shortId}/members`, "POST", { members: [{ type: "group", groupId }] })).status).toBe(
        200,
      );
      await sql`UPDATE chat.participants SET joined_seq = CASE WHEN principal_id = ${expired.id}::uuid THEN 0 WHEN principal_id = ${successor.id}::uuid THEN 1 ELSE 2 END WHERE conversation_id = ${chat.id}::uuid`;
      await sql`UPDATE auth.users SET account_expires = now() WHERE id = ${expired.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${owner.id}::uuid`;
      await sql`DELETE FROM events.outbox WHERE app_id = 'chat' AND ordering_key IN (${"c:" + chat.shortId}, ${"l:" + chat.shortId}, ${"p:" + successor.id})`;
      await run();
      const access = await sql<
        { permission: string }[]
      >`SELECT a.permission FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
      WHERE ca.conversation_id = ${chat.id}::uuid AND ca.role = 'member' AND a.user_id = ${successor.id}::uuid`;
      expect(access).toEqual([{ permission: "admin" }]);
      const [participant] = await sql<
        { origin: string; joined_seq: string }[]
      >`SELECT origin, joined_seq FROM chat.participants WHERE conversation_id = ${chat.id}::uuid AND principal_id = ${successor.id}::uuid`;
      expect(participant).toEqual({ origin: "direct", joined_seq: "1" });
      const detail = ConversationSchema.parse(await (await f.request(successor.headers, `/${chat.shortId}`)).json());
      expect(detail).toMatchObject({ permission: "admin", memberCount: 3 });
      const page = MessagePageSchema.parse(await (await f.request(successor.headers, `/${chat.shortId}/messages`)).json());
      expect(page.items.at(-1)).toMatchObject({
        author: { id: successor.id },
        system: { code: "manager_assigned", params: { member: { id: successor.id, name: successor.name } } },
      });
      const rows = await sql<
        { ordering_key: string; payload: unknown }[]
      >`SELECT ordering_key, payload FROM events.outbox WHERE app_id = 'chat'
      AND ordering_key IN (${"c:" + chat.shortId}, ${"l:" + chat.shortId}, ${"p:" + successor.id}) ORDER BY seq`;
      for (const key of [`c:${chat.shortId}`, `l:${chat.shortId}`])
        expect(rows.find((row) => row.ordering_key === key)?.payload).toMatchObject({ a: true });
      expect(rows.find((row) => row.ordering_key === `p:${successor.id}`)?.payload).toMatchObject({
        d: { type: "membership", conversationId: chat.shortId },
      });
      const [audit] = await sql<
        { actor_uid: string; outcome: string }[]
      >`SELECT actor_uid, outcome FROM audit.events WHERE action = 'chat.member.succession' AND target_id = ${chat.shortId}`;
      expect(audit).toEqual({ actor_uid: "chat-maintenance", outcome: "allowed" });
      const stable = await state(chat.id);
      await Promise.all([run(), run()]);
      expect(await state(chat.id)).toEqual(stable);
      await sql`DELETE FROM auth.users WHERE id = ${successor.id}::uuid`;
      await run();
      for (const [locale, label] of [
        ["en", "Former account"],
        ["de", "Ehemaliges Konto"],
      ]) {
        const former = MessagePageSchema.parse(
          await (await f.request({ ...newer.headers, "accept-language": locale! }, `/${chat.shortId}/messages`)).json(),
        ).items.find((message) => message.system?.code === "manager_assigned" && message.author.id === successor.id);
        expect(former?.author.name).toBe(label!);
        expect(former?.system).toEqual({ code: "manager_assigned", params: { member: { id: successor.id, name: label! } } });
        expect(former?.systemText).toContain(label!);
      }
    });

  test("directory members without participant rows succeed the manager in user-id order", async () => {
    const owner = await f.person("Old manager");
    const c = await f.person("C");
    const d = await f.person("D");
    const groupId = await f.group([]);
    const response = await f.request(owner.headers, "", "POST", { members: [{ type: "group", groupId }] });
    expect(response.status).toBe(201);
    const outcome = CreateOutcomeSchema.parse(await response.json());
    if (outcome.outcome !== "created") throw new Error("Expected group chat");
    f.trackChat(outcome.conversation.id);
    const [chat] = await sql<
      { id: string; seq_head: string }[]
    >`SELECT id, seq_head FROM chat.conversations WHERE short_id = ${outcome.conversation.id}`;
    if (!chat) throw new Error("Missing created chat");
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${c.id}::uuid, ${groupId}::uuid), (${d.id}::uuid, ${groupId}::uuid)`;
    expect(
      await sql`SELECT principal_id FROM chat.participants WHERE conversation_id = ${chat.id}::uuid
      AND principal_id = ANY(${toPgUuidArray([c.id, d.id])}::uuid[])`,
    ).toHaveLength(0);
    await sql`DELETE FROM auth.users WHERE id = ${owner.id}::uuid`;
    await run();
    const successor = c.id < d.id ? c : d;
    const access = await sql<{ user_id: string; permission: string }[]>`SELECT a.user_id, a.permission
      FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id
      WHERE ca.conversation_id = ${chat.id}::uuid AND ca.role = 'member' AND a.user_id IS NOT NULL`;
    expect(access).toEqual([{ user_id: successor.id, permission: "admin" }]);
    const participant = await sql<
      { origin: string; joined_seq: string }[]
    >`SELECT origin, joined_seq FROM chat.participants WHERE conversation_id = ${chat.id}::uuid
      AND principal_type = 'user' AND principal_id = ${successor.id}::uuid`;
    expect(participant).toEqual([{ origin: "direct", joined_seq: chat.seq_head }]);
    const page = MessagePageSchema.parse(await (await f.request(successor.headers, `/${outcome.conversation.id}/messages`)).json());
    expect(page.items.at(-1)?.system).toEqual({ code: "manager_assigned", params: { member: { id: successor.id, name: successor.name } } });
  });

  test("a chat without an eligible successor remains managerless without messages", async () => {
    const owner = await f.person();
    const expired = await f.person();
    const chat = await f.fixture(owner, [{ person: expired, permission: "write" }]);
    await sql`UPDATE auth.users SET account_expires = now() WHERE id = ${expired.id}::uuid`;
    await sql`DELETE FROM auth.users WHERE id = ${owner.id}::uuid`;
    await run();
    expect(
      await sql`SELECT a.id FROM chat.conversation_access ca JOIN auth.access a ON a.id = ca.access_id WHERE ca.conversation_id = ${chat.id}::uuid AND a.permission = 'admin'`,
    ).toHaveLength(0);
    expect(await sql`SELECT short_id FROM chat.messages WHERE conversation_id = ${chat.id}::uuid`).toHaveLength(0);
    const stable = await state(chat.id);
    await run();
    expect(await state(chat.id)).toEqual(stable);
  });

  test("a failed conversation rolls back and does not stop later conversations or heartbeats", async () => {
    const owner = await f.person();
    const chats = [await f.fixture(owner), await f.fixture(owner)].sort((a, b) => a.id.localeCompare(b.id));
    const failed = chats[0]!;
    const later = chats[1]!;
    await sql`UPDATE chat.conversations SET member_count = 99 WHERE id = ANY(${toPgUuidArray(chats.map((chat) => chat.id))}::uuid[])`;
    const before = await state(failed.id);
    const triggerName = `test_chat_reconcile_${crypto.randomUUID().replaceAll("-", "")}`;
    await sql.unsafe(
      `CREATE FUNCTION chat.${triggerName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test reconcile failure'; END $$`,
    );
    try {
      await sql.unsafe(
        `CREATE TRIGGER ${triggerName} BEFORE UPDATE ON chat.conversations FOR EACH ROW WHEN (NEW.id = '${failed.id}'::uuid) EXECUTE FUNCTION chat.${triggerName}()`,
      );
      let heartbeats = 0;
      const result = await reconcile({
        signal: new AbortController().signal,
        heartbeat: () => {
          heartbeats++;
        },
      });
      expect(result).toMatchObject({ failed: 1, countsFixed: 1 });
      expect(heartbeats).toBe(result.conversations + result.failed);
      expect(await state(failed.id)).toEqual(before);
      const [row] = await sql<{ member_count: number }[]>`SELECT member_count FROM chat.conversations WHERE id = ${later.id}::uuid`;
      expect(row?.member_count).toBe(1);
    } finally {
      await sql.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON chat.conversations`);
      await sql.unsafe(`DROP FUNCTION chat.${triggerName}()`);
    }
    await run();
  });

  test("aborting after a conversation leaves later conversations untouched", async () => {
    const owner = await f.person();
    const shortIds = Array.from({ length: 101 }, () => testShortId());
    const rows = await sql<
      { id: string; short_id: string }[]
    >`INSERT INTO chat.conversations (short_id, created_by_type, created_by_id, member_count)
      SELECT short_id, 'user', ${owner.id}::uuid, 1 FROM unnest(${toPgTextArray(shortIds)}::text[]) AS fixture(short_id) RETURNING id, short_id`;
    for (const row of rows) f.trackChat(row.short_id);
    const [first] = await sql<{ id: string }[]>`SELECT id FROM chat.conversations ORDER BY id LIMIT 1`;
    const controller = new AbortController();
    let heartbeats = 0;
    await reconcile({
      signal: controller.signal,
      heartbeat: () => {
        heartbeats++;
        controller.abort();
      },
    });
    expect(heartbeats).toBe(1);
    const after = await sql<
      { id: string; member_count: number }[]
    >`SELECT id, member_count FROM chat.conversations WHERE id = ANY(${toPgUuidArray(rows.map((row) => row.id))}::uuid[])`;
    for (const row of after) expect(row.member_count).toBe(row.id === first?.id ? 0 : 1);
    expect(after.some((row) => row.member_count === 1)).toBeTrue();
    const stable = await Promise.all(rows.map((row) => state(row.id)));
    await reconcile({
      signal: controller.signal,
      heartbeat: () => {
        throw new Error("Aborted run must not heartbeat");
      },
    });
    expect(await Promise.all(rows.map((row) => state(row.id)))).toEqual(stable);
  });

  test("lifecycle registers the UTC 15-minute schedule and drains its worker", async () => {
    const scheduler = lazySync((sync) =>
      sync.scheduler({ id: "chat-maintenance", delivery: { ackWaitMs: 60_000, maxAttempts: 3, backoffMs: [5_000, 15_000] } }),
    );
    try {
      await maintenanceLifecycle.start();
      await maintenanceLifecycle.start();
      expect((await scheduler().list()).find((schedule) => schedule.id === "chat-maintenance")).toMatchObject({
        cron: "*/15 * * * *",
        timezone: "UTC",
        misfire: "latest",
      });
    } finally {
      await maintenanceLifecycle.stop();
      await scheduler().delete({ id: "chat-maintenance" });
    }
  });
});
