import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { aiConversations } from "@k2b/cloud/ai";
import { AUTOMATION_TURN_BUDGET } from "@k2b/cloud/ai/runtime";
import { accounts } from "@k2b/cloud/services";
import { aiModelFixture, beginAiCall, finishAiCall } from "../../../../scripts/fixtures/code-platform";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor, useMigratedDatabase } from "../../../../scripts/fixtures/test-infra";
import { admitCodeChatTurn } from "../ai-chat-budget";
import { codeChatDailyUsage } from "./ai-budget";
import { CodeChatBudgetError, reserveCodeChatTurnBudget, settleCodeChatTurnBudget } from "./chat-turn-budget";
import { codeBundleHash, codeSourceHash } from "./store";

const owner = "5a000000-0000-4000-8000-000000000001";
const profile = aiModelFixture({
  id: "turn-budget",
  // Maximum (192,000 + 32,000) x 3 + 12,000 x 6 = 0.744 USD: one start fits a 1 USD day, two do not.
  pricing: { inputPerMillion: 3, outputPerMillion: 6 },
  maxOutputTokens: 1000,
  contextWindow: 128000,
});
const codeId = "c_budget";
const versionId = "5a000000-0000-4000-8000-000000000002";
const runId = "5a000000-0000-4000-8000-000000000003";
const limits = { code: 1, owner: 1, timeZone: "UTC" };
let sequence = 0;

suiteFor(
  "database",
  "valkey",
  "nats",
)("Code chat whole-turn budget", () => {
  let database: Awaited<ReturnType<typeof useMigratedDatabase>>;
  beforeAll(async () => {
    database = await useMigratedDatabase("code_chat_turn_budget");
    await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${owner}::uuid,'chat-budget-owner','local','user')`;
    const hashes = { source: codeSourceHash({}, "code.ts"), sdk: "a".repeat(64), bundle: codeBundleHash("") };
    const manifest = {
      version: 1,
      entry: "code.ts",
      entrypoints: [],
      ai: true,
      policyRows: ["ai_chat_you"],
      permissions: [{ operation: "core.ai.chat.send", target: { type: "core.ai.chat", id: null }, file: "code.ts", line: 1 }],
      hashes,
    };
    await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title) VALUES(${codeId},'person',${owner}::uuid,'Budget fixture')`;
    await sql`INSERT INTO code.versions(id,code_id,number,source_files,bundle,source_hash,bundle_hash,manifest,source_bytes,bundle_bytes)
      VALUES(${versionId}::uuid,${codeId},1,'{}','',${hashes.source},${hashes.bundle},(${JSON.stringify(manifest)}::text)::jsonb,0,0)`;
    await sql`UPDATE code.codes SET state='active',active_version_id=${versionId}::uuid WHERE id=${codeId}`;
    await sql`INSERT INTO code.version_submissions(version_id,code_id,binding) VALUES(${versionId}::uuid,${codeId},'{}')`;
    await sql`INSERT INTO code.runs(id,code_id,version_id,trigger,entrypoint,state,payload_bytes,calls_limit)
      VALUES(${runId}::uuid,${codeId},${versionId}::uuid,'schedule','fixture','running',1000,10)`;
  });
  afterAll(async () => {
    await database?.drop();
  });

  const turn = async () => {
    const chat = await aiConversations.createConversation({ ownerUserId: owner });
    const { turn } = await aiConversations.submitChatTurn({
      conversationId: chat.id,
      modelId: profile.id,
      userMessage: { role: "user", content: [{ type: "text", text: "Fixture" }] },
      runConfig: { kind: "chat", input: "Fixture", turnTrigger: { kind: "automation", id: "c_budget" } },
    });
    return { turnId: turn.id, conversationId: chat.id };
  };
  const reserve = (turnId: string, codeId: string, nextProfile = profile, nextLimits = limits) =>
    sql.begin(async (db) => {
      await db`SELECT id FROM ai.turns WHERE id=${turnId}::uuid FOR UPDATE`;
      await reserveCodeChatTurnBudget({ turnId, codeId, ownerUserId: owner, profile: nextProfile }, db, nextLimits);
    });
  const call = async (turnId: string, codeId: string, kind: "chat" | "background", cost: string | null) => {
    const id = `5a000000-0000-4000-8001-${String(++sequence).padStart(12, "0")}`;
    await sql`INSERT INTO ai.inference_calls(id,user_id,model_profile_id,turn_id,kind,task,provider_model,code_id,pricing,cost,finished_at,lease_expires_at)
      VALUES(${id}::uuid,${owner}::uuid,${profile.id},${turnId}::uuid,${kind},${kind === "chat" ? "chat" : "chat-compaction"},'fixture',${codeId},
        '{"inputPerMillion":3,"outputPerMillion":6}',${cost}::numeric,'2026-11-15T12:01:00Z','2026-11-15T12:02:00Z')`;
    return id;
  };
  const reset = async () => {
    await sql`UPDATE ai.cost_config SET enabled=false,background=NULL WHERE singleton`;
    await sql`DELETE FROM code.chat_turn_budgets`;
    await sql`DELETE FROM code.ai_daily_budget`;
    await sql`DELETE FROM ai.inference_calls WHERE user_id=${owner}::uuid`;
  };

  test("actual-model admission fences owner, version, state and worker lease; zero price requires ordinary AI approval", async () => {
    await reset();
    const user = await accounts.users.get({ id: owner });
    if (!user) throw new Error("Missing fixture owner");
    const runConfig = {
      kind: "chat" as const,
      input: "Fixture",
      actor: { kind: "user" as const, user },
      turnTrigger: { kind: "automation" as const, id: codeId },
      codeOrigin: { codeId, runId, title: "Budget fixture", requestId: "fixture", label: "Started by Code" },
    };
    const entry = await turn();
    const leaseOwner = "budget-worker";
    const claim = await aiConversations.claimTurn({
      ...entry,
      leaseOwner,
      leaseMs: 30000,
      from: "queue",
      maxAttempts: 5,
      runBudgetMs: 30000,
    });
    expect(claim).not.toBeNull();
    const input = { ...entry, leaseOwner, runConfig, profile };
    await expect(admitCodeChatTurn({ ...input, leaseOwner: "stale-worker" })).rejects.toThrow("lease");
    await expect(
      admitCodeChatTurn({
        ...input,
        runConfig: { ...runConfig, actor: { kind: "user", user: { ...user, id: "5a000000-0000-4000-8000-000000000099" } } },
      }),
    ).rejects.toThrow("authority");
    await expect(
      admitCodeChatTurn({
        ...input,
        runConfig: { ...runConfig, codeOrigin: { ...runConfig.codeOrigin, runId: "5a000000-0000-4000-8000-000000000099" } },
      }),
    ).rejects.toThrow("authority");
    await sql`UPDATE code.codes SET state='paused' WHERE id=${codeId}`;
    await expect(admitCodeChatTurn(input)).rejects.toThrow("authority");
    await sql`UPDATE code.codes SET state='active' WHERE id=${codeId}`;
    await expect(
      admitCodeChatTurn({ ...input, profile: { ...profile, pricing: { inputPerMillion: 0, outputPerMillion: 0 } } }),
    ).rejects.toThrow("code_approval_required");
    await admitCodeChatTurn(input);
    expect(await sql`SELECT 1 FROM code.chat_turn_budgets WHERE turn_id=${entry.turnId}::uuid`).toHaveLength(1);
  });
  test("deleted source turns cannot dispatch additional inference", async () => {
    await reset();
    const entry = await turn();
    await sql`DELETE FROM ai.conversations WHERE id=${entry.conversationId}::uuid`;
    await expect(beginAiCall(profile, { ...entry, kind: "chat", task: "chat" }, 10, 1000)).rejects.toThrow("no longer exists");
    expect(await sql`SELECT id FROM ai.inference_calls WHERE turn_id=${entry.turnId}::uuid`).toHaveLength(0);
  });
  test("turn aggregation has an unfiltered turn index", async () => {
    const [index] = await sql<
      { indexdef: string }[]
    >`SELECT indexdef FROM pg_indexes WHERE schemaname='ai' AND indexname='inference_calls_turn'`;
    expect(index?.indexdef).toContain("(turn_id)");
    expect(index?.indexdef).not.toContain("WHERE");
  });
  test("settlement waits for in-flight provider admission before releasing the daily maximum", async () => {
    await reset();
    const entry = await turn();
    await reserve(entry.turnId, codeId);
    await sql`UPDATE ai.turns SET status='completed',completed_at='2026-11-15T12:03:00Z' WHERE id=${entry.turnId}::uuid`;
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const admission = sql.begin(async (db) => {
      await db`SELECT singleton FROM ai.cost_config WHERE singleton FOR UPDATE`;
      await db`INSERT INTO ai.inference_calls(id,turn_id,kind,task,provider_model,model_profile_id,pricing,lease_expires_at)
        VALUES(${crypto.randomUUID()}::uuid,${entry.turnId}::uuid,'chat','chat','fixture',${profile.id},
          '{"inputPerMillion":3,"outputPerMillion":6}',clock_timestamp()+interval '2 minutes')`;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    let settled = false;
    const settlement = sql
      .begin((db) => settleCodeChatTurnBudget(entry.turnId, db))
      .finally(() => {
        settled = true;
      });
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !settled; attempt++) {
        const [activity] = await sql<{ waiting: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT singleton FROM ai.cost_config%') AS waiting`;
        if (activity?.waiting) {
          waiting = true;
          break;
        }
        await Bun.sleep(5);
      }
      expect(waiting).toBeTrue();
      expect(settled).toBeFalse();
    } finally {
      release.resolve();
      await admission;
      await settlement;
    }
    const [budget] = await sql<
      { settled_at: Date | null }[]
    >`SELECT settled_at FROM code.chat_turn_budgets WHERE turn_id=${entry.turnId}::uuid`;
    expect(budget?.settled_at).toBeNull();
  });
  test("nested model attempts share the turn's model slots, pinned model and explicit output ceiling", async () => {
    await reset();
    const entry = await turn();
    const claim = await aiConversations.claimTurn({
      ...entry,
      leaseOwner: "tool-budget",
      leaseMs: 30000,
      from: "queue",
      maxAttempts: 5,
      runBudgetMs: 30000,
    });
    expect(claim).not.toBeNull();
    await reserve(entry.turnId, "c_nested");
    const meter = await meterSql();
    let ordinary: Awaited<ReturnType<typeof beginAiCall>> | undefined;
    let bounded: Awaited<ReturnType<typeof beginAiCall>> | undefined;
    try {
      expect(
        await meter.during(async () => {
          ordinary = await beginAiCall(profile, { kind: "chat", task: "chat", userId: owner }, 10, 1000);
        }),
      ).toHaveLength(5);
      expect(
        await meter.during(async () => {
          bounded = await beginAiCall(profile, { ...entry, kind: "background", task: "view-image" }, 10, 2000);
        }),
      ).toHaveLength(6);
      expect(bounded?.maxOutputTokens).toBe(1000);
    } finally {
      await meter.close();
    }
    if (!ordinary || !bounded) throw new Error("Missing admitted fixture calls");
    await finishAiCall(ordinary.id, { input: 10, output: 1 }, "ok");
    await finishAiCall(bounded.id, { input: 10, output: 1 }, "ok");
    const context = { ...entry, kind: "background" as const, task: "view-image" };
    await expect(beginAiCall({ ...profile, id: "unreserved-vision" }, context, 10, 2000)).rejects.toThrow("outside");
    for (let i = 0; i < AUTOMATION_TURN_BUDGET.modelCalls - 2; i++) {
      const call = await beginAiCall(profile, context, 10, 2000);
      expect(call.maxOutputTokens).toBe(1000);
      await finishAiCall(call.id, { input: 10, output: 1 }, "ok");
    }
    const final = await Promise.allSettled([beginAiCall(profile, context, 10, 2000), beginAiCall(profile, context, 10, 2000)]);
    expect(final.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of final) if (result.status === "fulfilled") await finishAiCall(result.value.id, { input: 10, output: 1 }, "ok");
    expect(await sql`SELECT 1 FROM ai.inference_calls WHERE turn_id=${entry.turnId}::uuid`).toHaveLength(AUTOMATION_TURN_BUDGET.modelCalls);
    await sql`UPDATE ai.turns SET status='completed',completed_at='2026-11-15T12:03:00Z' WHERE id=${entry.turnId}::uuid`;
    await sql.begin((db) => settleCodeChatTurnBudget(entry.turnId, db));
    expect(
      (await sql<{ cost: string }[]>`SELECT reference_cost::text AS cost FROM code.ai_daily_budget`).map((row) => Number(row.cost)),
    ).toEqual([0.000432, 0.000432]);
  });
  test("the turn's output allowance caps each call by what is left, then stops the turn", async () => {
    await reset();
    const entry = await turn();
    const claim = await aiConversations.claimTurn({
      ...entry,
      leaseOwner: "output-budget",
      leaseMs: 30000,
      from: "queue",
      maxAttempts: 5,
      runBudgetMs: 30000,
    });
    expect(claim).not.toBeNull();
    await reserve(entry.turnId, "c_output");
    const context = { ...entry, kind: "background" as const, task: "view-image" };
    const first = await beginAiCall(profile, context, 10, 2000);
    expect(first.maxOutputTokens).toBe(1000);
    await finishAiCall(first.id, { input: 10, output: AUTOMATION_TURN_BUDGET.outputTokens - 400 }, "ok");
    const last = await beginAiCall(profile, context, 10, 2000);
    expect(last.maxOutputTokens).toBe(400);
    await finishAiCall(last.id, { input: 10, output: 400 }, "ok");
    await expect(beginAiCall(profile, context, 10, 2000)).rejects.toMatchObject({ reason: "output_tokens" });
  });
  test("parallel starts cannot overbook either the Code or the shared owner day", async () => {
    for (const codes of [
      ["c_parallel", "c_parallel"],
      ["c_first", "c_second"],
    ]) {
      await reset();
      const turns = await Promise.all([turn(), turn()]);
      const results = await Promise.allSettled(turns.map((entry, i) => reserve(entry.turnId, codes[i]!)));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected?.status === "rejected" && rejected.reason instanceof CodeChatBudgetError).toBeTrue();
      const counters = await sql<
        { cost: string }[]
      >`SELECT reference_cost::text AS cost FROM code.ai_daily_budget WHERE scope_kind='owner'`;
      expect(counters.map((row) => Number(row.cost))).toEqual([0.744]);
    }
  });
  test("resumption reuses the reservation and rejects a changed price or output ceiling", async () => {
    await reset();
    const entry = await turn();
    await reserve(entry.turnId, "c_resume");
    await reserve(entry.turnId, "c_resume");
    expect((await sql`SELECT 1 FROM code.chat_turn_budgets`).length).toBe(1);
    await expect(reserve(entry.turnId, "c_resume", { ...profile, pricing: { inputPerMillion: 2, outputPerMillion: 2 } })).rejects.toThrow(
      "changed",
    );
    await expect(reserve(entry.turnId, "c_resume", { ...profile, maxOutputTokens: 2000 })).rejects.toThrow("changed");
  });
  test("compaction settles with the turn exactly once, using its original day", async () => {
    await reset();
    const entry = await turn();
    await reserve(entry.turnId, "c_settle");
    await call(entry.turnId, "c_settle", "chat", "0.1");
    await call(entry.turnId, "c_settle", "background", "0.05");
    const [reservation] = await sql<{ day: string }[]>`SELECT day::text FROM code.chat_turn_budgets WHERE turn_id=${entry.turnId}::uuid`;
    const legacy = await codeChatDailyUsage(sql, reservation!.day, "UTC", "code", "c_settle", owner);
    expect(Number(legacy.cost)).toBe(0);
    await sql`UPDATE ai.turns SET status='completed',completed_at='2026-11-15T12:03:00Z' WHERE id=${entry.turnId}::uuid`;
    await sql.begin((db) => settleCodeChatTurnBudget(entry.turnId, db));
    await sql.begin((db) => settleCodeChatTurnBudget(entry.turnId, db));
    expect(
      (await sql<{ cost: string }[]>`SELECT reference_cost::text AS cost FROM code.ai_daily_budget`).map((row) => Number(row.cost)),
    ).toEqual([0.15, 0.15]);
  });
  test("a terminal unknown inference retains its reservation, including after chat deletion", async () => {
    await reset();
    const entry = await turn();
    await reserve(entry.turnId, "c_unknown");
    await call(entry.turnId, "c_unknown", "chat", null);
    await sql`DELETE FROM ai.conversations WHERE id=${entry.conversationId}::uuid`;
    await sql.begin((db) => settleCodeChatTurnBudget(entry.turnId, db));
    expect(
      (await sql<{ cost: string }[]>`SELECT reference_cost::text AS cost FROM code.ai_daily_budget`).map((row) => Number(row.cost)),
    ).toEqual([0.744, 0.744]);
  });
  test("a failed start without inference returns its remainder; a zero limit still disables free inference", async () => {
    await reset();
    const entry = await turn();
    await reserve(entry.turnId, "c_no_call");
    await sql`UPDATE ai.turns SET status='failed',completed_at='2026-11-15T12:03:00Z' WHERE id=${entry.turnId}::uuid`;
    await sql.begin((db) => settleCodeChatTurnBudget(entry.turnId, db));
    expect(
      (await sql<{ cost: string }[]>`SELECT reference_cost::text AS cost FROM code.ai_daily_budget`).map((row) => Number(row.cost)),
    ).toEqual([0, 0]);
    const disabled = await turn();
    await expect(reserve(disabled.turnId, "c_disabled", { ...profile, pricing: undefined }, { ...limits, code: 0 })).rejects.toThrow(
      "daily_budget_limit",
    );
  });
});
