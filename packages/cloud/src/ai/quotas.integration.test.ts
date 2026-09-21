import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import type { AiQuotaRule } from "../shared/ai-quotas";
import { backgroundCostState, beginAiCall, finishAiCall, releaseBackgroundCostStop } from "./inference-calls";
import { drainQueuedMessages } from "./message-queue";
import { quotaReport } from "./quota-report";
import { aiQuotas, quotaWindow } from "./quotas";
import { migrateAiQuotas } from "./quotas-migrate";
import * as modelSettings from "./settings";
import { aiConversations } from "./store";
import type { AiModelProfile } from "./types";

const suite = databaseSuite();
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
const pricedModel = (id = "a"): AiModelProfile => ({
  id,
  label: id,
  provider: "openai",
  model: id,
  capabilities: ["streaming"],
  enabled: true,
  dataBoundary: "hosted",
  pricing: { inputPerMillion: 1_000_000, outputPerMillion: 1_000_000 },
});
const fixtureCalls = {
  async begin(
    who: { type: "user"; userId: string } | { type: "service_account"; serviceAccountId: string },
    model: string,
    turnId: string,
  ) {
    const id = crypto.randomUUID();
    await sql`INSERT INTO ai.inference_calls(id,user_id,service_account_id,model_profile_id,provider_model,kind,task,turn_id,turn_attempt,pricing,lease_expires_at)
      VALUES(${id}::uuid,${who.type === "user" ? who.userId : null}::uuid,${who.type === "service_account" ? who.serviceAccountId : null}::uuid,
      ${model},${model},'chat','chat',${turnId}::uuid,(SELECT attempt FROM ai.turns WHERE id=${turnId}::uuid),'{"inputPerMillion":1000000,"outputPerMillion":1000000}',now()+interval '2 minutes')`;
    return id;
  },
  finish: (id: string, usage?: { input: number; output: number; estimated?: boolean }) => finishAiCall(id, usage, "ok"),
};
const charge = async (model: string, input = 60, output = 40) => {
  const id = await fixtureCalls.begin(subject, model, turn);
  await fixtureCalls.finish(id, { input, output });
  return id;
};
suite("Assistant quota PostgreSQL boundaries", () => {
  let fresh: Awaited<ReturnType<typeof useFreshDatabase>>;
  afterAll(async () => {
    await sql.close();
    await fresh?.drop();
  });
  beforeAll(async () => {
    fresh = await useFreshDatabase("ai_quotas");
    await sql`CREATE SCHEMA auth`;
    await sql`CREATE SCHEMA ai`;
    await sql`CREATE TABLE auth.users(id UUID PRIMARY KEY,uid TEXT,display_name TEXT)`;
    await sql`CREATE TABLE auth.groups(id UUID PRIMARY KEY,name TEXT,provider TEXT)`;
    await sql`CREATE TABLE auth.service_accounts(id UUID PRIMARY KEY,name TEXT)`;
    await sql`CREATE TABLE auth.user_groups_v2(user_id UUID,group_id UUID)`;
    await sql`CREATE TABLE auth.group_groups_v2(parent_group_id UUID,child_group_id UUID)`;
    await sql`CREATE TABLE ai.turns(id UUID PRIMARY KEY,status TEXT,attempt INTEGER,lease_expires_at TIMESTAMPTZ,conversation_id UUID,run_config JSONB)`;
    await sql`CREATE TABLE ai.conversations(id UUID PRIMARY KEY,created_by_user_id UUID,launched_by_app_id TEXT,archived_at TIMESTAMPTZ)`;
    await sql`CREATE TABLE ai.queued_messages(id UUID PRIMARY KEY,conversation_id UUID,submission JSONB,status TEXT,error TEXT,quota_checked_at TIMESTAMPTZ,position BIGSERIAL)`;
    await sql`INSERT INTO auth.users VALUES(${user}::uuid,'one','One'),(${other}::uuid,'two','Two')`;
    await sql`INSERT INTO auth.service_accounts VALUES(${service}::uuid,'Service')`;
    await sql`INSERT INTO auth.groups VALUES(${group}::uuid,'Parent','local'),(${child}::uuid,'Child','local')`;
    await sql`INSERT INTO auth.user_groups_v2 VALUES(${user}::uuid,${child}::uuid)`;
    await sql`INSERT INTO auth.group_groups_v2 VALUES(${group}::uuid,${child}::uuid)`;
    await sql`INSERT INTO ai.turns(id,status,attempt,lease_expires_at) VALUES(${turn}::uuid,'running',1,now()+interval '1 hour')`;
    await migrateAiQuotas();
    spyOn(modelSettings, "readAiSettingsState").mockResolvedValue({
      ok: true,
      enabled: true,
      defaultModelId: "a",
      globalInstructions: "",
      compactionInstructions: "",
      maxToolResultChars: 1000,
      firecrawlConfigured: false,
      profiles: [pricedModel("a"), pricedModel("b")],
    });
  });
  beforeEach(async () => {
    await sql`TRUNCATE ai.cost_alerts,ai.inference_calls,ai.cost_resets,ai.cost_changes`;
    await sql`UPDATE ai.cost_config SET enabled=false,revision=0,rules='[]',unit='EUR',background=NULL,background_stopped_at=NULL,background_warned=false`;
    await sql`UPDATE ai.turns SET attempt=1,status='running',lease_expires_at=now()+interval '1 hour'`;
  });
  test("report matches canonical nested grants, model constraints and wildcard bypass", async () => {
    const all = rule("*", 50);
    all.grants.push({ principal: { type: "group", groupId: group }, limit: 200 });
    await save([all, rule("a", 50)]);
    await charge("a");
    const r = await quotaReport({ search: user, model: "a" });
    const snapshot = await aiQuotas.snapshot(subject, "a");
    expect(snapshot.balances.map((b) => b.limit)).toEqual([200, 50]);
    expect(r.items[0]?.status).toBe("exhausted");
    expect(r.items[0]?.exhausted).toBe(1);
    expect(r.items[0]?.scopes).toBe(2);
    expect(r.items[0]?.balances).toEqual(
      snapshot.balances.map(({ scope, limit, used, unknown, bypassed }) => ({ scope, limit, used, unknown, bypassed })),
    );
    expect(snapshot.balances[0]?.sourceDetails).toEqual([{ principal: { type: "group", groupId: group }, displayName: "Parent" }]);
    expect(r.overview.input).toBe(60);
    expect(r.overview.output).toBe(40);
    expect(r.timeline[0]?.calls).toBe(1);
    await save([rule("*", null), rule("a", 0)]);
    const bypass = await quotaReport({ search: user, model: "a" });
    expect(bypass.items[0]?.status).toBe("unlimited");
    expect(bypass.items[0]?.exhausted).toBe(0);
    expect(bypass.items[0]?.balances.find((b) => b.scope === "a")?.bypassed).toBe(true);
  });
  test("report separates reset balances, historical period and unknown accounting", async () => {
    await save([rule("a", 100)]);
    await charge("a");
    await aiQuotas.reset(subject, "a", crypto.randomUUID(), user);
    let r = await quotaReport({ search: user });
    expect(r.items[0]?.status).toBe("available");
    expect(r.items[0]?.balances[0]?.used).toBe(0);
    expect(r.overview.input + r.overview.output).toBe(100);
    await fixtureCalls.finish(await fixtureCalls.begin(subject, "a", turn));
    r = await quotaReport({ search: user });
    expect(r.items[0]?.status).toBe("unknown");
    expect(r.overview.unknown).toBe(1);
    expect(r.overview.measured).toBe(1);
    const historical = await quotaReport({ search: user, until: new Date(Date.now() - 86400000).toISOString() });
    expect(historical.overview.calls).toBe(0);
    expect(historical.items[0]?.status).toBe("unknown");
    await save([rule("a", 100)], false);
    expect((await quotaReport({ search: user })).items[0]?.status).toBe("disabled");
  });
  test("report filters globally, clamps pages and includes unused searched identities", async () => {
    await save([{ ...rule("a", 100), grants: [{ principal: { type: "user", userId: user }, limit: 100 }] }]);
    await charge("a", 10, 20);
    const limited = await quotaReport({ search: "o", model: "a", status: "exhausted", page: 999 });
    expect(limited.items.map((r) => r.id)).toEqual([other]);
    expect(limited.page).toBe(1);
    expect(limited.total).toBe(1);
    expect(limited.overview.calls).toBe(0);
    const svc = { type: "service_account" as const, serviceAccountId: service };
    await fixtureCalls.finish(await fixtureCalls.begin(svc, "a", turn), { input: 5, output: 2, estimated: true });
    const serviceReport = await quotaReport({ search: service, identity: service, identityType: "service_account" });
    expect(serviceReport.selected?.label).toBe("Service");
    expect(serviceReport.overview.estimated).toBe(1);
    expect(serviceReport.items[0]?.status).toBe("exhausted");
  });
  test("report sorts and filters a multi-page cohort before pagination", async () => {
    const now = new Date("2026-09-20T12:00:00.000Z");
    // Keep all calls inside the report window: PostgreSQL's clock_timestamp()
    // has finer precision than JavaScript's millisecond report cutoff.
    const startedAt = new Date(now.getTime() - 1000);
    const users = Array.from({ length: 30 }, (_, i) => ({ id: crypto.randomUUID(), uid: `report-${i}`, display_name: `Report ${i}` }));
    await sql`INSERT INTO auth.users ${sql(users, "id", "uid", "display_name")}`;
    try {
      await save([rule("a", 15)]);
      await sql`INSERT INTO ai.inference_calls ${sql(users.map((u, i) => ({ id: crypto.randomUUID(), user_id: u.id, model_profile_id: "a", input: i, output: 0, kind: "chat", task: "chat", provider_model: "a", started_at: startedAt, lease_expires_at: now, cost: i })))}`;
      const first = await quotaReport({ search: "Report", sort: "cost", direction: "desc" }, now);
      const second = await quotaReport({ ...first.query, page: 2 }, now);
      expect(first.total).toBe(30);
      expect(first.items).toHaveLength(25);
      expect(second.items).toHaveLength(5);
      expect(first.items.map((item) => item.input)).toEqual(Array.from({ length: 25 }, (_, i) => 29 - i));
      expect(second.items.map((item) => item.input)).toEqual([4, 3, 2, 1, 0]);
      expect(new Set([...first.items, ...second.items].map((r) => r.id)).size).toBe(30);
      const blocked = await quotaReport({ search: "Report", status: "exhausted", page: 2 }, now);
      expect(blocked.total).toBe(15);
      expect(blocked.page).toBe(1);
      expect(blocked.items.every((r) => r.input >= 15)).toBe(true);
    } finally {
      await sql`DELETE FROM auth.users WHERE id IN ${sql(users.map((u) => u.id))}`;
    }
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
    await fixtureCalls.finish(await fixtureCalls.begin(subject, "a", turn));
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
    await fixtureCalls.finish(id, { input: 800, output: 900 });
    await fixtureCalls.finish(id);
    expect((await aiQuotas.snapshot(subject, "a")).balances[0]!.used).toBe(100);
  });
  test("manual reset leaves historical usage and ignores late old calls", async () => {
    await save([rule("*", 100), rule("a", 200)]);
    const old = await fixtureCalls.begin(subject, "a", turn);
    await aiQuotas.reset(subject, "*", crypto.randomUUID(), user);
    await fixtureCalls.finish(old, { input: 60, output: 40 });
    const b = (await aiQuotas.snapshot(subject, "a")).balances;
    expect(b.find((x) => x.scope === "*")!.used).toBe(0);
    expect(b.find((x) => x.scope === "a")!.used).toBe(100);
    expect(Number((await sql`SELECT count(*) AS n FROM ai.inference_calls`)[0]!.n)).toBe(1);
  });
  test("reset receipts cannot be reused for another identity", async () => {
    const id = crypto.randomUUID();
    await aiQuotas.reset(subject, "*", id, user);
    await aiQuotas.reset(subject, "*", id, user);
    await expect(aiQuotas.reset({ type: "user", userId: other }, "*", id, user)).rejects.toThrow("another target");
  });
  test("unknown completed call blocks finite but not disabled quota", async () => {
    await save([rule("a", 200)]);
    await fixtureCalls.finish(await fixtureCalls.begin(subject, "a", turn));
    await expect(aiQuotas.assertAllowed(subject, "a")).rejects.toThrow("could not be measured");
    await save([rule("a", 200)], false);
    expect(await aiQuotas.assertAllowed(subject, "a")).toBe(false);
  });
  test("reclaimed turn cannot disguise unknown usage of prior attempt", async () => {
    await save([rule("a", 200)]);
    await fixtureCalls.begin(subject, "a", turn);
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
    await fixtureCalls.finish(await fixtureCalls.begin(s, "a", turn), { input: 80, output: 20 });
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
    const id = await fixtureCalls.begin(subject, "a", turn);
    await fixtureCalls.finish(id, { input: 10, output: 5, estimated: true });
    await fixtureCalls.finish(id, undefined);
    expect((await aiQuotas.snapshot(subject)).balances[0]).toMatchObject({ used: 15, unknown: 0, estimated: 1 });
    expect(await aiQuotas.assertAllowed(subject, "a")).toBe(true);
    const users = await aiQuotas.users("One", 1);
    expect(users.items[0]?.lastUsed).toMatch(/T.*Z$/);
  });
  test("retention preserves maximum windows, resets and active calls", async () => {
    const recent = await charge("a"),
      old = await charge("a"),
      active = await charge("a");
    await sql`UPDATE ai.inference_calls SET started_at=now()-interval '8761 hours',turn_id=NULL WHERE id=${old}::uuid`;
    await sql`UPDATE ai.inference_calls SET started_at=now()-interval '8761 hours',finished_at=NULL WHERE id=${active}::uuid`;
    await aiQuotas.prune();
    const remaining = (await sql<{ id: string }[]>`SELECT id FROM ai.inference_calls`).map((r) => r.id);
    expect(remaining).toContain(recent);
    expect(remaining).toContain(active);
    expect(remaining).not.toContain(old);
    await sql`UPDATE ai.turns SET status='aborted' WHERE id=${turn}::uuid`;
    await aiQuotas.prune();
    expect((await sql`SELECT 1 FROM ai.inference_calls WHERE id=${active}::uuid`).length).toBe(0);
  });

  test("retention deletes at most one bounded batch", async () => {
    await sql`INSERT INTO ai.inference_calls(id,user_id,model_profile_id,started_at,finished_at,input,output,kind,task,provider_model,lease_expires_at,cost)
      SELECT gen_random_uuid(),${user}::uuid,'a',now()-interval '8761 hours',now(),1,1,'chat','chat','a',now(),2 FROM generate_series(1,1001)`;
    await aiQuotas.prune();
    expect(Number((await sql`SELECT count(*) AS n FROM ai.inference_calls`)[0]!.n)).toBe(1);
  });
  test("concurrent cost admissions reserve the same wildcard pool atomically", async () => {
    await save([rule("*", 2)]);
    const results = await Promise.allSettled(
      [1, 2].map(() => beginAiCall(pricedModel(), { kind: "chat", task: "chat", subject, turnId: turn }, 1, 1)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const accepted = results.find((result) => result.status === "fulfilled");
    if (accepted?.status !== "fulfilled") throw new Error("No admission");
    await finishAiCall(accepted.value.id, { input: 1, output: 1 }, "ok");
    expect((await aiQuotas.snapshot(subject)).balances[0]!.used).toBe(2);
  });
  test("decimal affordability does not lose a token to floating point", async () => {
    await save([rule("*", 0.3)]);
    const call = await beginAiCall(
      { ...pricedModel(), pricing: { inputPerMillion: 100000, outputPerMillion: 100000 } },
      { kind: "chat", task: "chat", subject, turnId: turn },
      1,
      10,
    );
    expect(call.maxOutputTokens).toBe(2);
    await finishAiCall(call.id, { input: 1, output: 2 }, "ok");
    expect((await aiQuotas.snapshot(subject)).balances[0]!.used).toBe(0.3);
  });
  test("price snapshots survive model price changes and duplicate finalization", async () => {
    const model = pricedModel();
    const call = await beginAiCall(model, { kind: "chat", task: "chat", subject, turnId: turn }, 1, 1);
    model.pricing = { inputPerMillion: 0, outputPerMillion: 0 };
    await finishAiCall(call.id, { input: 2, output: 3 }, "ok");
    await finishAiCall(call.id, { input: 100, output: 100 }, "ok");
    const [row] = await sql`SELECT cost::text FROM ai.inference_calls WHERE id=${call.id}::uuid`;
    expect(Number(row.cost)).toBe(5);
  });
  test("unpriced calls bypass finite chat budgets and a latched background brake", async () => {
    await save([rule("*", 0)]);
    await aiQuotas.save({ ...(await aiQuotas.config()), background: { enabled: true, warnAt: null, stopAt: 1 } }, user);
    await sql`UPDATE ai.cost_config SET background_stopped_at=now()`;
    for (const kind of ["chat", "background"] as const) {
      const call = await beginAiCall({ ...pricedModel(), pricing: undefined }, { kind, task: kind, subject, turnId: turn }, 100, 100);
      await finishAiCall(call.id, { input: 100, output: 100 }, "ok");
      const [row] = await sql`SELECT cost FROM ai.inference_calls WHERE id=${call.id}::uuid`;
      expect(row.cost).toBeNull();
    }
  });
  test("explicit free pricing records zero even when tokens are unknown", async () => {
    await aiQuotas.save({ ...(await aiQuotas.config()), background: { enabled: true, warnAt: null, stopAt: 1 } }, user);
    const call = await beginAiCall(
      { ...pricedModel(), pricing: { inputPerMillion: 0, outputPerMillion: 0 } },
      { kind: "background", task: "free" },
      1,
      1,
    );
    await finishAiCall(call.id, undefined, "ok");
    expect(await backgroundCostState()).toMatchObject({ used: 0, unknown: 0, stoppedAt: null });
  });
  test("free models stay usable after a wildcard budget and background stop are exhausted", async () => {
    await save([rule("*", 1)]);
    await charge("a", 2, 0);
    await sql`UPDATE ai.cost_config SET background='{"enabled":true,"warnAt":null,"stopAt":1}',background_stopped_at=now()`;
    const free = { ...pricedModel(), pricing: { inputPerMillion: 0, outputPerMillion: 0 } };
    for (const kind of ["chat", "background"] as const) {
      const call = await beginAiCall(free, { kind, task: "free", subject }, 10);
      expect(call.maxOutputTokens).toBeUndefined();
      await sql`UPDATE ai.inference_calls SET lease_expires_at=now()-interval '1 minute' WHERE id=${call.id}::uuid`;
      expect((await backgroundCostState()).unknown).toBe(0);
      expect((await aiQuotas.snapshot(subject)).balances[0]?.unknown).toBe(0);
      await finishAiCall(call.id, undefined, "ok");
    }
  });
  test("no-budget admission preserves provider default output maximum", async () => {
    const call = await beginAiCall(pricedModel(), { kind: "background", task: "unrestricted" }, 20, undefined, 200_000);
    expect(call.maxOutputTokens).toBeUndefined();
  });
  test("temporary reservations do not latch the stop and release capacity on settlement", async () => {
    await aiQuotas.save({ ...(await aiQuotas.config()), background: { enabled: true, warnAt: null, stopAt: 10 } }, user);
    const first = await beginAiCall(pricedModel(), { kind: "background", task: "first" }, 1, 9);
    await expect(beginAiCall(pricedModel(), { kind: "background", task: "waiting" }, 1, 1)).rejects.toMatchObject({
      code: "ai_background_budget_reserved",
      retryable: true,
    });
    // Too-large input cannot become affordable even when pending calls release their reservations.
    await expect(beginAiCall(pricedModel(), { kind: "background", task: "too-large" }, 10, 1)).rejects.toMatchObject({
      code: "ai_background_budget_insufficient",
      retryable: false,
    });
    expect(await backgroundCostState()).toMatchObject({ stoppedAt: null, reserved: 10, used: 0 });
    expect((await sql`SELECT * FROM ai.cost_alerts`).length).toBe(0);
    await finishAiCall(first.id, { input: 1, output: 1 }, "ok");
    await expect(beginAiCall(pricedModel(), { kind: "background", task: "next" }, 1, 1)).resolves.toBeDefined();
    expect(await backgroundCostState()).toMatchObject({ stoppedAt: null, used: 2 });
  });
  test("background warning and stop are durable, deduplicated, and separate from chat budgets", async () => {
    await save([rule("*", 100)]);
    await aiQuotas.save({ ...(await aiQuotas.config()), background: { enabled: true, warnAt: 1, stopAt: 2 } }, user);
    const call = await beginAiCall(pricedModel(), { kind: "background", task: "workflow-test", subject }, 1, 1);
    await finishAiCall(call.id, { input: 1, output: 1 }, "ok");
    await finishAiCall(call.id, { input: 1, output: 1 }, "ok");
    expect((await aiQuotas.snapshot(subject)).balances[0]!.used).toBe(0);
    expect((await backgroundCostState()).stoppedAt).not.toBeNull();
    expect((await sql<{ kind: string }[]>`SELECT kind FROM ai.cost_alerts ORDER BY kind`).map((row) => row.kind)).toEqual([
      "stop",
      "warning",
    ]);
    await expect(beginAiCall(pricedModel(), { kind: "background", task: "blocked" }, 1, 1)).rejects.toThrow("Background AI");
    await expect(releaseBackgroundCostStop(user)).rejects.toThrow("Background AI");
    await aiQuotas.save({ ...(await aiQuotas.config()), background: { enabled: true, warnAt: 5, stopAt: 10 } }, user);
    expect((await backgroundCostState()).stoppedAt).not.toBeNull();
    await releaseBackgroundCostStop(user);
    expect((await backgroundCostState()).stoppedAt).toBeNull();
  });
  test("background costs use a rolling window but a triggered brake stays latched", async () => {
    await aiQuotas.save({ ...(await aiQuotas.config()), background: { enabled: true, warnAt: null, stopAt: 1 } }, user);
    const call = await beginAiCall(pricedModel(), { kind: "background", task: "old" }, 0, 1);
    await finishAiCall(call.id, { input: 0, output: 1 }, "ok");
    await sql`UPDATE ai.inference_calls SET started_at=now()-interval '25 hours' WHERE id=${call.id}::uuid`;
    expect(await backgroundCostState()).toMatchObject({ used: 0 });
    await expect(beginAiCall(pricedModel(), { kind: "background", task: "still-blocked" }, 0, 1)).rejects.toThrow("Background AI");
    await releaseBackgroundCostStop(user);
    await expect(beginAiCall(pricedModel(), { kind: "background", task: "released" }, 0, 1)).resolves.toBeDefined();
  });
});
