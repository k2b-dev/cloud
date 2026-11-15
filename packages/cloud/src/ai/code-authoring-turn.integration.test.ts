import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ProviderEvent } from "@k2b/nessi";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { databaseSuite, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { sql } from "../runtime/clients";
import { CODE_AUTHORING_TURN_BUDGET, createCodeAuthoringTurnBudget } from "./code-authoring-turn";
import { readAiTurnCallUsage } from "./inference-calls";
import { migrateAiQuotas } from "./quotas-migrate";

const suite = databaseSuite();
const turnId = "00000000-0000-4000-8000-000000003323";

suite("Code authoring usage recovery", () => {
  let fresh: Awaited<ReturnType<typeof useFreshDatabase>>;
  beforeAll(async () => {
    fresh = await useFreshDatabase("authoring_budget");
    await sql`CREATE SCHEMA auth`;
    await sql`CREATE SCHEMA ai`;
    await sql`CREATE TABLE auth.users(id UUID PRIMARY KEY)`;
    await sql`CREATE TABLE auth.service_accounts(id UUID PRIMARY KEY)`;
    await migrateAiQuotas();
  });
  afterAll(async () => {
    await sql.close();
    await fresh?.drop();
  });

  test("restores chat and compaction attempts and estimates successful calls without provider usage", async () => {
    expect(await readAiTurnCallUsage(turnId)).toEqual({ calls: 0, inputTokens: 0, unknownCalls: 0 });
    for (const [index, tokens] of [100_000, 200_000, null].entries()) {
      await sql`INSERT INTO ai.inference_calls(id,model_profile_id,turn_id,turn_attempt,input,output,kind,task,provider_model,
        started_at,lease_expires_at,status)
        VALUES(${`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`}::uuid,'fixture',${turnId}::uuid,${index + 1},
          ${tokens},1,'chat','chat','fixture','2026-11-14T12:00:00Z','2026-11-14T12:02:00Z','ok')`;
    }
    // Memory learning is not authoring inference and must not double-count the turn.
    await sql`INSERT INTO ai.inference_calls(id,model_profile_id,turn_id,input,kind,task,provider_model,lease_expires_at)
      VALUES('00000000-0000-4000-8000-000000000099','fixture',${turnId}::uuid,900000,'background','memory-learn-turn','fixture',
        '2026-11-14T12:02:00Z')`;
    await sql`INSERT INTO ai.inference_calls(id,model_profile_id,turn_id,input,kind,task,provider_model,lease_expires_at)
      VALUES('00000000-0000-4000-8000-000000000098','fixture',${turnId}::uuid,15000,'background','chat-compaction','fixture',
        '2026-11-14T12:02:00Z')`;
    const usageMeter = await meterSql();
    try {
      expect(await usageMeter.during(() => readAiTurnCallUsage(turnId))).toHaveLength(1);
    } finally {
      await usageMeter.close();
    }
    const usage = await readAiTurnCallUsage(turnId);
    expect(usage).toEqual({ calls: 4, inputTokens: 315_000, unknownCalls: 1 });
    let dispatched = false;
    const guard = createCodeAuthoringTurnBudget({
      priorCalls: {
        calls: usage.calls,
        inputTokens: usage.inputTokens + usage.unknownCalls * CODE_AUTHORING_TURN_BUDGET.unknownInputTokens,
      },
      finishedToolCalls: [],
      selected: true,
    });
    const provider = guard.wrap({
      name: "fixture",
      family: "openai-compatible",
      model: "fixture",
      capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: false },
      async *stream() {
        dispatched = true;
      },
    });
    const events: ProviderEvent[] = [];
    const meter = await meterSql();
    try {
      expect(
        await meter.during(async () => {
          for (let i = 0; i < 3; i++) for await (const event of provider.stream({ messages: [] })) events.push(event);
        }),
      ).toEqual([]);
    } finally {
      await meter.close();
    }
    expect(dispatched).toBe(true);
    expect(events).toEqual([]);
  });
  test("automatic recovery includes failed attempts and compaction without SQL on the provider path", async () => {
    const automaticTurnId = "00000000-0000-4000-8000-000000003324";
    await sql`INSERT INTO ai.inference_calls(id,model_profile_id,turn_id,input,kind,task,provider_model,lease_expires_at,status)
      SELECT ('00000000-0000-4000-8001-' || lpad(n::text,12,'0'))::uuid,'fixture',${automaticTurnId}::uuid,1000,
        CASE WHEN n=16 THEN 'background' ELSE 'chat' END,
        CASE WHEN n=16 THEN 'chat-compaction' ELSE 'chat' END,'fixture','2026-11-14T12:02:00Z','failed'
      FROM generate_series(1,16) n`;
    const usage = await readAiTurnCallUsage(automaticTurnId);
    expect(usage).toEqual({ calls: 16, inputTokens: 16000, unknownCalls: 0 });
    const guard = createCodeAuthoringTurnBudget({ priorCalls: usage, selected: false, nonPerson: true, finishedToolCalls: [] });
    const provider = guard.wrap({
      name: "fixture",
      family: "openai-compatible",
      model: "fixture",
      capabilities: { streaming: true, tools: false, images: false, thinking: false, usage: false },
      async *stream() {
        throw new Error("No seventeenth attempt");
      },
    });
    const meter = await meterSql();
    try {
      expect(
        await meter.during(async () => {
          for await (const _ of provider.stream({ messages: [] })) {
            /* drain */
          }
        }),
      ).toEqual([]);
    } finally {
      await meter.close();
    }
    expect(guard.automationStopped()).toEqual({ reason: "model_calls" });
  });
  test("priced Code recovery floors estimated attempts at the authoritative model window", async () => {
    const id = "00000000-0000-4000-8000-000000003326";
    await sql`INSERT INTO ai.inference_calls(id,model_profile_id,turn_id,input,output,estimated,kind,task,provider_model,lease_expires_at,status)
      VALUES('00000000-0000-4000-8000-000000003327','fixture',${id}::uuid,10,1,true,'chat','chat','fixture','2026-11-14T12:02:00Z','failed')`;
    expect(await readAiTurnCallUsage(id, 128000)).toEqual({ calls: 1, inputTokens: 128000, unknownCalls: 0 });
    expect(await readAiTurnCallUsage(id)).toEqual({ calls: 1, inputTokens: 10, unknownCalls: 0 });
  });
});
