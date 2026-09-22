import { beforeAll, expect, test } from "bun:test";
import { nessi, type Provider } from "@k2b/nessi";
import { sql } from "bun";
import { z } from "zod";
import { databaseSuite, testInfra } from "../../../../scripts/fixtures/test-infra";
import { type AiCallContext, beginAiCall, finishAiCall } from "./inference-calls";
import { migrateCloudAi } from "./migrate";
import { inferenceProvider } from "./quota-provider";
import { createAiShortId } from "./short-id";
import { aiConversations } from "./store";
import { recordAiStructuredRun } from "./structured-runs";
import type { AiModelProfile } from "./types";
import { aiUsage } from "./usage";

const suite = databaseSuite();
beforeAll(async () => {
  if (!testInfra.database) return;
  await migrateCloudAi();
});

const fixture = async () => {
  const prefix = `usage-${crypto.randomUUID()}`;
  const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name)
    VALUES(${prefix},'local','user',${prefix}) RETURNING id`;
  const model: AiModelProfile = {
    id: prefix,
    label: prefix,
    provider: "openai",
    model: "provider/usage",
    enabled: true,
    dataBoundary: "hosted",
    capabilities: ["streaming"],
    pricing: { inputPerMillion: 1000, outputPerMillion: 2000 },
  };
  const conversations: string[] = [];
  const workflows: string[] = [];
  const conversation = async () => {
    const value = await aiConversations.createConversation({ ownerUserId: user!.id, launchedByAppId: "usage-test" });
    conversations.push(value.id);
    return value;
  };
  const call = async (input: number | undefined, output: number | undefined, context: Partial<AiCallContext> = {}, profile = model) => {
    const value = await beginAiCall(
      profile,
      { kind: "background", task: prefix, userId: user!.id, appId: "usage-test", ...context },
      input ?? 0,
      output,
    );
    await finishAiCall(value.id, input === undefined || output === undefined ? undefined : { input, output }, "ok");
    return value.id;
  };
  const report = (options: Parameters<typeof aiUsage.report>[1] = {}) => aiUsage.report("24h", { modelProfileId: prefix, ...options });
  return {
    prefix,
    userId: user!.id,
    model,
    conversation,
    call,
    report,
    workflows,
    cleanup: async () => {
      await sql`DELETE FROM ai.inference_calls WHERE model_profile_id=${prefix}`;
      await sql`DELETE FROM ai.structured_runs WHERE model_profile_id=${prefix}`;
      for (const id of conversations) await sql`DELETE FROM ai.conversations WHERE id=${id}::uuid`;
      for (const id of workflows) await sql`DELETE FROM workflows.workflow WHERE id=${id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${user!.id}::uuid`;
    },
  };
};

suite("AI usage inference accounting", () => {
  test("records each real structured repair call once, not the terminal aggregate or replayed result", async () => {
    const f = await fixture();
    try {
      let requests = 0;
      const provider: Provider = {
        name: "fixture",
        family: "openai-compatible",
        model: f.model.model,
        capabilities: { streaming: false, tools: false, images: false, thinking: false, usage: true, structuredOutput: true },
        async complete() {
          requests++;
          const text = requests === 1 ? "not JSON" : '{"answer":42}';
          const usage = { input: 100 * requests, output: 10 * requests, total: 110 * requests };
          return { message: { role: "assistant", content: [{ type: "text", text }], usage }, usage, finishReason: "stop" };
        },
        async *stream() {
          throw new Error("Structured repair must use complete()");
        },
      };
      const result = await nessi.structured({
        agentId: "usage-test",
        input: "Return an answer",
        output: z.object({ answer: z.number() }),
        provider: inferenceProvider(provider, f.model, { kind: "background", task: f.prefix, userId: f.userId }),
      });
      expect(result.output).toEqual({ answer: 42 });
      expect(requests).toBe(2);
      expect(result.structuredMeta.attempts).toBe(2);
      await recordAiStructuredRun({
        task: f.prefix,
        modelProfileId: f.prefix,
        status: "ok",
        durationMs: 1,
        usage: result.usage,
        attempts: 2,
        attribution: { userId: f.userId },
      });
      let report = await f.report();
      expect(report.overview).toMatchObject({ runs: 2, tokens: 330, costCoverage: 1 });
      expect(report.overview.cost).toBeCloseTo(0.36, 12);
      // Replaying a stored workflow result or diagnostic write does not execute a provider.
      await recordAiStructuredRun({ task: f.prefix, modelProfileId: f.prefix, status: "ok", durationMs: 1, usage: result.usage });
      const rows = await sql<{ id: string }[]>`SELECT id FROM ai.inference_calls WHERE model_profile_id=${f.prefix}`;
      await finishAiCall(rows[0]!.id, { input: 99999, output: 99999 }, "ok");
      report = await f.report();
      expect(report.overview).toMatchObject({ runs: 2, tokens: 330 });
      expect(report.overview.cost).toBeCloseTo(0.36, 12);
      expect(report.runs.items.every((row) => row.attempts === 1)).toBeTrue();
    } finally {
      await f.cleanup();
    }
  });

  test("message copies, edits, chat deletion and repeat migration neither erase nor create charges", async () => {
    const f = await fixture();
    try {
      const conversation = await f.conversation();
      const turn = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: f.prefix,
        runConfig: { kind: "chat", input: "Hello", toolSource: { kind: "none" } },
        userMessage: { role: "user", content: [{ type: "text", text: "Hello" }] },
      });
      const store = aiConversations.createSessionStore({ conversationId: conversation.id, turnId: turn.turn.id, modelProfileId: f.prefix });
      await store.append({
        role: "assistant",
        content: [{ type: "text", text: "Response" }],
        usage: { input: 900, output: 100, total: 1000 },
      });
      const id = await f.call(100, 20, { kind: "chat", task: "chat", turnId: turn.turn.id, conversationId: conversation.id });
      const fork = await f.conversation();
      await aiConversations.copyMessages({ sourceConversationId: conversation.id, targetConversationId: fork.id, throughSeq: 2 });
      expect((await f.report()).overview).toMatchObject({ runs: 1, tokens: 120 });
      await aiConversations.truncateMessagesFrom({ conversationId: conversation.id, fromSeq: 1 });
      await sql`DELETE FROM ai.conversations WHERE id=${conversation.id}::uuid`;
      await migrateCloudAi();
      expect((await f.report()).overview).toMatchObject({ runs: 1, tokens: 120 });
      expect(await aiUsage.detail("chat", id)).toMatchObject({ id, conversationId: conversation.id, turnId: turn.turn.id, tokens: 120 });
      expect((await f.report()).overview.cost).toBeCloseTo(0.14, 12);
    } finally {
      await f.cleanup();
    }
  });

  test("counts feedback once per turn with multiple calls and never counts a background call as an assistant message", async () => {
    const f = await fixture();
    try {
      const conversation = await f.conversation();
      const [turn] = await sql<{ id: string }[]>`INSERT INTO ai.turns(short_id,conversation_id,status,model_profile_id,run_config)
        VALUES(${createAiShortId()},${conversation.id}::uuid,'completed',${f.prefix},'{"kind":"chat"}') RETURNING id`;
      await sql`INSERT INTO ai.messages(short_id,conversation_id,seq,kind,role,message,loop_id,feedback_rating,feedback_reasons,feedback_comment,feedback_updated_at)
        VALUES(${createAiShortId()},${conversation.id}::uuid,1,'message','assistant','{"role":"assistant","content":[]}',${turn!.id},-1,ARRAY['incorrect'],'Needs correction',now())`;
      const ctx = { kind: "chat" as const, task: "chat", turnId: turn!.id, conversationId: conversation.id };
      await f.call(100, 20, ctx);
      await f.call(200, 30, ctx);
      await f.call(50, 10, { ...ctx, kind: "background", task: "chat-compaction" });
      const report = await f.report();
      expect(report.overview).toMatchObject({ runs: 3, tokens: 410, assistantMessages: 1, negative: 1, rated: 1 });
      expect(report.chat).toMatchObject({ runs: 2, assistantMessages: 1, negative: 1 });
      expect(report.background).toMatchObject({ runs: 1, assistantMessages: 0, negative: 0, rated: 0 });
      expect(report.feedback.items).toHaveLength(1);
      expect(report.feedback.items[0]).toMatchObject({ comment: "Needs correction", reasons: ["incorrect"] });
      expect((await f.report({ rating: "up" })).overview.rated).toBe(1);
      expect((await f.report({ rating: "up" })).feedback.total).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  test("keeps redacted call errors, cancellation and request milestones on the run detail", async () => {
    const f = await fixture();
    try {
      const failed = await beginAiCall(f.model, { kind: "background", task: "timings", userId: f.userId }, 10, 2);
      const requestStartedAt = Date.now() - 1_500;
      await finishAiCall(failed.id, undefined, "failed", {
        error: `SSE stream first byte timeout after 60000ms.\n${"x".repeat(1_000)}`,
        requestStartedAt,
        headersMs: 120.4,
        firstByteMs: 800,
      });
      const aborted = await beginAiCall(f.model, { kind: "background", task: "timings", userId: f.userId }, 10, 2);
      await finishAiCall(aborted.id, { input: 10, output: 1, estimated: true }, "aborted", {
        cancelled: true,
        requestStartedAt,
        firstBlockMs: 900,
      });
      const detail = await aiUsage.detail("background", failed.id);
      expect(detail).toMatchObject({
        status: "failed",
        errorCode: "ai_provider_call_failed",
        cancelled: false,
        headersMs: 120,
        firstByteMs: 800,
        firstBlockMs: null,
      });
      expect(detail?.error).toStartWith("SSE stream first byte timeout after 60000ms. xxx");
      expect(detail?.error).toHaveLength(500);
      expect(detail?.generationMs).toBeGreaterThanOrEqual(1_400);
      expect(Math.abs(new Date(detail!.requestStartedAt!).getTime() - requestStartedAt)).toBeLessThan(1_000);
      expect(await aiUsage.detail("background", aborted.id)).toMatchObject({
        status: "aborted",
        error: null,
        errorCode: null,
        cancelled: true,
        firstBlockMs: 900,
      });
      const report = await f.report();
      expect(report.tasks.items.find((row) => row.id === "timings")).toMatchObject({ runs: 2, failed: 1 });
    } finally {
      await f.cleanup();
    }
  });

  test("separates missing prices, missing tokens, estimates and known free calls without repricing history", async () => {
    const f = await fixture();
    try {
      await f.call(100, 20, { task: "mixed" });
      await f.call(100, 20, { task: "mixed" }, { ...f.model, pricing: undefined });
      const unknown = await f.call(undefined, undefined, { task: "unknown" });
      await f.call(undefined, undefined, { task: "free" }, { ...f.model, pricing: { inputPerMillion: 0, outputPerMillion: 0 } });
      const estimate = await beginAiCall(f.model, { kind: "background", task: "estimate", userId: f.userId }, 10, 2);
      await finishAiCall(estimate.id, { input: 10, output: 2, estimated: true }, "failed");
      f.model.pricing = { inputPerMillion: 2000, outputPerMillion: 4000 };
      await f.call(100, 20, { task: "mixed" });
      const report = await f.report();
      const mixed = report.tasks.items.find((row) => row.id === "mixed")!;
      expect(mixed).toMatchObject({ runs: 3, tokens: 360, costCoverage: 2 / 3, tokenCoverage: 1 });
      expect(mixed.cost).toBeCloseTo(0.42, 12);
      expect(report.tasks.items.find((row) => row.id === "unknown")).toMatchObject({ cost: null, tokens: null, costCoverage: 0 });
      expect(report.tasks.items.find((row) => row.id === "free")).toMatchObject({ cost: 0, costCoverage: 1, tokenCoverage: 0 });
      expect(await aiUsage.detail("background", estimate.id)).toMatchObject({ estimated: true, status: "failed", tokens: 12, cost: 0.014 });
      expect(await aiUsage.detail("background", unknown)).toMatchObject({ cost: null, tokens: null });
      expect(report.overview.costCoverage).toBe(4 / 6);
    } finally {
      await f.cleanup();
    }
  });

  test("groups workflow costs by stable definition across renames and keeps trusted metadata after deletion", async () => {
    const f = await fixture();
    try {
      const [workflow] = await sql<{ id: string }[]>`INSERT INTO workflows.workflow(app_id,scope_id,key,name,created_by_kind)
        VALUES('usage-workflow-app',${f.prefix},'summarize','Original name','system') RETURNING id`;
      f.workflows.push(workflow!.id);
      const [version] = await sql<
        { id: string }[]
      >`INSERT INTO workflows.version(workflow_id,revision,source,source_hash,plan,language_id,language_version,manifest_hash,created_by_kind)
        VALUES(${workflow!.id}::uuid,1,'source',${"a".repeat(64)},'{}','test',1,${"b".repeat(64)},'system') RETURNING id`;
      const [run] = await sql<
        { id: string }[]
      >`INSERT INTO workflows.run(app_id,scope_id,workflow_id,workflow_version_id,mode,authorization_snapshot,idempotency_key,occurred_at)
        VALUES('usage-workflow-app',${f.prefix},${workflow!.id}::uuid,${version!.id}::uuid,'execute','{}','usage-run',now()) RETURNING id`;
      const first = await f.call(100, 20, { workflowRunId: run!.id, stepKey: "classify", appId: "caller-supplied-app" });
      await sql`UPDATE workflows.workflow SET name='Renamed workflow' WHERE id=${workflow!.id}::uuid`;
      const second = await f.call(200, 30, { workflowRunId: run!.id, stepKey: "extract", appId: "caller-supplied-app" });
      const [snapshot] = await sql`SELECT workflow_version,step_key FROM ai.inference_calls WHERE id=${second}::uuid`;
      expect(snapshot).toMatchObject({ workflow_version: 1, step_key: "extract" });
      expect(await aiUsage.detail("background", first)).toMatchObject({
        workflowId: workflow!.id,
        workflowName: "Original name",
        appId: "usage-workflow-app",
      });
      let report = await f.report({ workflowId: workflow!.id });
      expect(report.workflows.total).toBe(1);
      expect(report.workflows.items[0]).toMatchObject({ id: workflow!.id, label: "Renamed workflow", runs: 2, tokens: 350 });
      expect(report.workflows.items[0]?.cost).toBeCloseTo(0.4, 12);
      await sql`DELETE FROM workflows.workflow WHERE id=${workflow!.id}::uuid`;
      report = await f.report({ workflowId: workflow!.id });
      expect(report.overview).toMatchObject({ runs: 2, tokens: 350 });
      expect(report.workflows.total).toBe(1);
      expect(await aiUsage.detail("background", second)).toMatchObject({
        workflowRunId: run!.id,
        workflowId: workflow!.id,
        workflowName: "Renamed workflow",
      });
    } finally {
      await f.cleanup();
    }
  });

  test("filters call details and fixes the page time boundary while paginating more than 100 groups", async () => {
    const f = await fixture();
    try {
      await sql`INSERT INTO ai.inference_calls(id,user_id,model_profile_id,provider_model,kind,task,app_id,started_at,finished_at,lease_expires_at,input,output,pricing,cost,status)
        SELECT gen_random_uuid(),${f.userId}::uuid,${f.prefix},'provider/pages','background',${f.prefix}||'-'||n,'usage-test',now()-interval '1 minute',now(),now(),8,2,'{"inputPerMillion":1000,"outputPerMillion":2000}',0.012,'ok' FROM generate_series(1,105) n`;
      const first = await f.report({ perPage: 100 });
      const second = await f.report({ ...first.query, page: 2 });
      const beyond = await f.report({ ...first.query, page: 999 });
      expect(first.tasks).toMatchObject({ page: 1, perPage: 100, total: 105 });
      expect(second.tasks.items).toHaveLength(5);
      expect(beyond.tasks).toEqual(second.tasks);
      expect(second.until).toBe(first.until);
      expect(new Set([...first.tasks.items, ...second.tasks.items].map((row) => row.id)).size).toBe(105);
      const [failure] = await sql<{ id: string }[]>`UPDATE ai.inference_calls SET status='failed',error_code='provider_rejected'
        WHERE model_profile_id=${f.prefix} AND task=${`${f.prefix}-1`} RETURNING id`;
      const filtered = await f.report({ kind: "background", status: "failed", errorCode: "provider_rejected", search: "rejected" });
      expect(filtered.runs.total).toBe(1);
      expect(filtered.runs.items[0]?.id).toBe(failure!.id);
      expect(await aiUsage.detail("background", failure!.id)).toEqual(filtered.runs.items[0]!);
      expect((await aiUsage.facets("userId", f.userId, { range: "24h" })).map((row) => row.id)).toEqual([f.userId]);
    } finally {
      await f.cleanup();
    }
  });

  test("fills inactive UTC buckets with zero while preserving unknown cost in occupied buckets", async () => {
    const f = await fixture();
    try {
      await f.call(100, 20, {}, { ...f.model, pricing: undefined });
      for (const range of ["24h", "7d", "30d", "90d"] as const) {
        const report = await aiUsage.report(range, { modelProfileId: f.prefix });
        const step = range === "24h" ? 3_600_000 : 86_400_000;
        expect(report.timeline.length).toBeGreaterThanOrEqual(range === "24h" ? 24 : Number.parseInt(range));
        for (let index = 1; index < report.timeline.length; index++)
          expect(Date.parse(report.timeline[index]!.bucket) - Date.parse(report.timeline[index - 1]!.bucket)).toBe(step);
        expect(report.timeline.some((point) => point.turns === 0 && point.tokens === 0 && point.cost === 0)).toBeTrue();
        expect(report.timeline.find((point) => point.turns === 1)).toMatchObject({ tokens: 120, cost: null });
      }
    } finally {
      await f.cleanup();
    }
  });
});
