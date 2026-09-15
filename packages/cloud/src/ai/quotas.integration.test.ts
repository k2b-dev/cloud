import { drainQueuedMessages } from "./message-queue";
import { aiConversations } from "./store";
import { beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { sql } from "bun";
import { aiQuotas, quotaWindow } from "./quotas";
import { migrateAiQuotas } from "./quotas-migrate";
import type { AiQuotaRule } from "../shared/ai-quotas";
const url = new URL(process.env.DATABASE_URL || "postgres://localhost/unconfigured");
const suite =
  ["localhost", "127.0.0.1"].includes(url.hostname) && url.pathname.startsWith("/cloud_ai_quota_verify_") ? describe : describe.skip;
const user = crypto.randomUUID(),
  other = crypto.randomUUID(),
  group = crypto.randomUUID(),
  child = crypto.randomUUID(),
  service = crypto.randomUUID(),
  turn = crypto.randomUUID();
const subject = { type: "user" as const, userId: user };
const rule = (scope: string, limit: number | null): AiQuotaRule => ({
  scope,
  hours: 168,
  anchor: "1970-01-01T00:00:00.000Z",
  grants: [{ principal: { type: "authenticated" }, limit }],
});
const save = async (rules: AiQuotaRule[], enabled = true) => aiQuotas.save({ ...(await aiQuotas.config()), rules, enabled }, user);
const charge = async (model: string, input = 60, output = 40) => {
  const id = await aiQuotas.begin(subject, model, turn);
  await aiQuotas.finish(id, { input, output });
  return id;
};
suite("Assistant quota PostgreSQL boundaries", () => {
  beforeAll(async () => {
    await sql`CREATE SCHEMA auth`;
    await sql`CREATE SCHEMA ai`;
    await sql`CREATE TABLE auth.users(id UUID PRIMARY KEY,uid TEXT,display_name TEXT)`;
    await sql`CREATE TABLE auth.groups(id UUID PRIMARY KEY,name TEXT,provider TEXT)`;
    await sql`CREATE TABLE auth.service_accounts(id UUID PRIMARY KEY,name TEXT)`;
    await sql`CREATE TABLE auth.user_groups_v2(user_id UUID,group_id UUID)`;
    await sql`CREATE TABLE auth.group_groups_v2(parent_group_id UUID,child_group_id UUID)`;
    await sql`CREATE TABLE ai.turns(id UUID PRIMARY KEY,status TEXT,attempt INTEGER,lease_expires_at TIMESTAMPTZ,conversation_id UUID,run_config JSONB)`;
    await sql`CREATE TABLE ai.conversations(id UUID PRIMARY KEY,created_by_user_id UUID,archived_at TIMESTAMPTZ)`;
    await sql`CREATE TABLE ai.queued_messages(id UUID PRIMARY KEY,conversation_id UUID,submission JSONB,status TEXT,error TEXT,quota_checked_at TIMESTAMPTZ,position BIGSERIAL)`;
    await sql`INSERT INTO auth.users VALUES(${user}::uuid,'one','One'),(${other}::uuid,'two','Two')`;
    await sql`INSERT INTO auth.service_accounts VALUES(${service}::uuid,'Service')`;
    await sql`INSERT INTO auth.groups VALUES(${group}::uuid,'Parent','local'),(${child}::uuid,'Child','local')`;
    await sql`INSERT INTO auth.user_groups_v2 VALUES(${user}::uuid,${child}::uuid)`;
    await sql`INSERT INTO auth.group_groups_v2 VALUES(${group}::uuid,${child}::uuid)`;
    await sql`INSERT INTO ai.turns(id,status,attempt,lease_expires_at) VALUES(${turn}::uuid,'running',1,now()+interval '1 hour')`;
    await migrateAiQuotas();
  });
  beforeEach(async () => {
    await sql`TRUNCATE ai.quota_calls,ai.quota_resets,ai.quota_changes`;
    await sql`UPDATE ai.quota_config SET enabled=false,revision=0,rules='[]'`;
    await sql`UPDATE ai.turns SET attempt=1,status='running',lease_expires_at=now()+interval '1 hour'`;
  });
  test("default disabled and repeat migration keep ordinary chats unlimited", async () => {
    await migrateAiQuotas();
    expect((await aiQuotas.config()).enabled).toBe(false);
    expect(await aiQuotas.assertAllowed(subject, "a")).toBe(false);
  });
  test("wildcard combines models and max never sums grants", async () => {
    const r = rule("*", 100);
    r.grants.push({ principal: { type: "group", groupId: group }, limit: 200 });
    await save([r]);
    await charge("a");
    await charge("b");
    const b = (await aiQuotas.snapshot(subject)).balances[0]!;
    expect(b.used).toBe(200);
    expect(b.limit).toBe(200);
    expect(b.sources).toEqual(["Parent"]);
    await expect(aiQuotas.assertAllowed(subject, "b")).rejects.toThrow("limit reached");
  });
  test("wildcard unlimited overrides zero model grants and unknown usage", async () => {
    await save([rule("*", null), rule("a", 0)]);
    await aiQuotas.finish(await aiQuotas.begin(subject, "a", turn));
    expect(await aiQuotas.assertAllowed(subject, "a")).toBe(false);
  });
  test("specific unlimited does not override finite wildcard", async () => {
    await save([rule("*", 0), rule("a", null)]);
    await expect(aiQuotas.assertAllowed(subject, "a")).rejects.toThrow("limit reached");
  });
  test("no matching assignment denies only configured scope", async () => {
    await save([{ ...rule("a", 100), grants: [{ principal: { type: "user", userId: other }, limit: 100 }] }]);
    await expect(aiQuotas.assertAllowed(subject, "a")).rejects.toThrow();
    expect(await aiQuotas.assertAllowed(subject, "b")).toBe(false);
  });
  test("duplicate finalization cannot double book or erase usage", async () => {
    await save([rule("a", 200)]);
    const id = await charge("a");
    await aiQuotas.finish(id, { input: 800, output: 900 });
    await aiQuotas.finish(id);
    expect((await aiQuotas.snapshot(subject, "a")).balances[0]!.used).toBe(100);
  });
  test("manual reset leaves historical usage and ignores late old calls", async () => {
    await save([rule("*", 100), rule("a", 200)]);
    const old = await aiQuotas.begin(subject, "a", turn);
    await aiQuotas.reset(subject, "*", crypto.randomUUID(), user);
    await aiQuotas.finish(old, { input: 60, output: 40 });
    const b = (await aiQuotas.snapshot(subject, "a")).balances;
    expect(b.find((x) => x.scope === "*")!.used).toBe(0);
    expect(b.find((x) => x.scope === "a")!.used).toBe(100);
    expect(Number((await sql`SELECT count(*) AS n FROM ai.quota_calls`)[0]!.n)).toBe(1);
  });
  test("reset receipts cannot be reused for another identity", async () => {
    const id = crypto.randomUUID();
    await aiQuotas.reset(subject, "*", id, user);
    await aiQuotas.reset(subject, "*", id, user);
    await expect(aiQuotas.reset({ type: "user", userId: other }, "*", id, user)).rejects.toThrow("another target");
  });
  test("unknown completed call blocks finite but not disabled quota", async () => {
    await save([rule("a", 200)]);
    await aiQuotas.finish(await aiQuotas.begin(subject, "a", turn));
    await expect(aiQuotas.assertAllowed(subject, "a")).rejects.toThrow("could not be measured");
    await save([rule("a", 200)], false);
    expect(await aiQuotas.assertAllowed(subject, "a")).toBe(false);
  });
  test("reclaimed turn cannot disguise unknown usage of prior attempt", async () => {
    await save([rule("a", 200)]);
    await aiQuotas.begin(subject, "a", turn);
    expect(await aiQuotas.assertAllowed(subject, "a")).toBe(true);
    await sql`UPDATE ai.turns SET attempt=2`;
    await expect(aiQuotas.assertAllowed(subject, "a")).rejects.toThrow("could not be measured");
  });
  test("grant/config changes preserve consumed allowance and reject stale saves", async () => {
    const initial = await save([rule("a", 200)]);
    await charge("a");
    await save([rule("a", 100)]);
    await expect(aiQuotas.save(initial, user)).rejects.toThrow("Reload");
    await expect(aiQuotas.assertAllowed(subject, "a")).rejects.toThrow("limit reached");
  });
  test("service accounts have separate personal usage", async () => {
    await save([rule("*", 100)]);
    const s = { type: "service_account" as const, serviceAccountId: service };
    await aiQuotas.finish(await aiQuotas.begin(s, "a", turn), { input: 80, output: 20 });
    await expect(aiQuotas.assertAllowed(s, "a")).rejects.toThrow();
    expect(await aiQuotas.assertAllowed(subject, "a")).toBe(true);
  });
  test("fixed half-open UTC windows have no reset job or DST drift", () => {
    const b = quotaWindow("2026-09-01T00:00:00.000Z", 5, new Date("2026-09-01T05:00:00Z"));
    expect(b.from.toISOString()).toBe("2026-09-01T05:00:00.000Z");
    expect(b.until.toISOString()).toBe("2026-09-01T10:00:00.000Z");
  });
  test("quota-blocked heads rotate so later unrestricted chats can dispatch", async () => {
    await save([{ ...rule("*", 0), grants: [{ principal: { type: "user", userId: other }, limit: null }] }]);
    const ids: string[] = [];
    for (let i = 0; i < 33; i++) {
      const conversation = crypto.randomUUID(),
        id = crypto.randomUUID();
      ids.push(id);
      await sql`INSERT INTO ai.conversations(id,created_by_user_id) VALUES(${conversation}::uuid,${i === 32 ? other : user}::uuid)`;
      const submission = {
        conversationId: conversation,
        modelProfileId: "a",
        runConfig: { assistantChat: true, kind: "chat", actor: { kind: "user", user: { id: i === 32 ? other : user } } },
      };
      await sql`INSERT INTO ai.queued_messages(id,conversation_id,submission,status) VALUES(${id}::uuid,${conversation}::uuid,(${JSON.stringify(submission)}::text)::jsonb,'pending')`;
    }
    let dispatched = 0;
    const spy = spyOn(aiConversations, "submitChatTurn").mockImplementation(async () => {
      dispatched++;
      throw new Error("Queued message is no longer ready.");
    });
    try {
      await drainQueuedMessages(async () => {});
      expect(dispatched).toBe(0);
      await drainQueuedMessages(async () => {});
      expect(dispatched).toBe(1);
      const [head] = await sql`SELECT status,error,submission FROM ai.queued_messages WHERE id=${ids[0]}::uuid`;
      expect(head!.error).toBe("quota_exhausted");
      expect(head!.submission.modelProfileId).toBe("a");
    } finally {
      spy.mockRestore();
    }
  }, 30000);
  test("users with historical direct chat are visible without accounting backfill", async () => {
    const conversation = crypto.randomUUID();
    await sql`INSERT INTO ai.conversations(id,created_by_user_id) VALUES(${conversation}::uuid,${other}::uuid)`;
    await sql`INSERT INTO ai.turns(id,conversation_id,run_config,status) VALUES(${crypto.randomUUID()}::uuid,${conversation}::uuid,'{"assistantChat":true}'::jsonb,'completed')`;
    expect((await aiQuotas.users("", 1)).items.some((u) => u.id === other)).toBe(true);
    expect((await aiQuotas.snapshot({ type: "user", userId: other })).usage).toEqual([]);
  });

  test("estimated interrupted usage counts but does not lock a finite quota", async () => {
    await save([rule("*", 1000)]);
    const id = await aiQuotas.begin(subject, "a", turn);
    await aiQuotas.finish(id, { input: 10, output: 5, estimated: true });
    await aiQuotas.finish(id, undefined);
    expect((await aiQuotas.snapshot(subject)).balances[0]).toMatchObject({ used: 15, unknown: 0, estimated: 1 });
    expect(await aiQuotas.assertAllowed(subject, "a")).toBe(true);
    const users = await aiQuotas.users("One", 1);
    expect(users.items[0]?.lastUsed).toMatch(/T.*Z$/);
  });
  test("retention preserves maximum windows, resets and active calls", async () => {
    const recent = await charge("a"), old = await charge("a"), active = await charge("a");
    await sql`UPDATE ai.quota_calls SET started_at=now()-interval '8761 hours',turn_id=NULL WHERE id=${old}::uuid`;
    await sql`UPDATE ai.quota_calls SET started_at=now()-interval '8761 hours',finished_at=NULL WHERE id=${active}::uuid`;
    await aiQuotas.prune();
    const remaining = (await sql<{id:string}[]>`SELECT id FROM ai.quota_calls`).map(r=>r.id);
    expect(remaining).toContain(recent);
    expect(remaining).toContain(active);
    expect(remaining).not.toContain(old);
    await sql`UPDATE ai.turns SET status='aborted' WHERE id=${turn}::uuid`;
    await aiQuotas.prune();
    expect((await sql`SELECT 1 FROM ai.quota_calls WHERE id=${active}::uuid`).length).toBe(0);
  });

  test("retention deletes at most one bounded batch", async () => {
    await sql`INSERT INTO ai.quota_calls(id,user_id,model_profile_id,started_at,finished_at,input,output)
      SELECT gen_random_uuid(),${user}::uuid,'a',now()-interval '8761 hours',now(),1,1 FROM generate_series(1,1001)`;
    await aiQuotas.prune();
    expect(Number((await sql`SELECT count(*) AS n FROM ai.quota_calls`)[0]!.n)).toBe(1);
  });
});
