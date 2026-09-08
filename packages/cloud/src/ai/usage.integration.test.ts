import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { migrateCloudAi } from "./migrate";
import { createAiShortId } from "./short-id";
import { aiConversations } from "./store";
import { recordAiStructuredRun } from "./structured-runs";
import { aiUsage } from "./usage";

// This suite migrates and writes data. It must never use a shared developer database.
const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgres://localhost/unconfigured");
const isolated =
  ["127.0.0.1", "localhost"].includes(databaseUrl.hostname) &&
  /^\/cloud_ai_usage_verify_(?!upgrade(?:_|$))[a-z0-9_]+$/.test(databaseUrl.pathname);
if (isolated) await migrateCloudAi();
const suite = isolated ? describe : describe.skip;

suite("AI usage integration", () => {
  test("aggregates interactive, capability, launch, feedback, switch, and background facts", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const uid = `ai-usage-${suffix}`;
    const modelA = `usage-fast-${suffix}`;
    const modelB = `usage-quality-${suffix}`;
    const task = `usage-test-${suffix}`;
    const capability = `usage-${suffix}.lookup`;
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${uid}, 'local', 'user', ${uid}, ${`${uid}@example.test`}, 'Usage', 'Test') RETURNING id
    `;
    const conversationIds: string[] = [];
    try {
      const conversation = await aiConversations.createConversation({ ownerUserId: user!.id, launchedByAppId: "mail" });
      conversationIds.push(conversation.id);
      const [firstTurn] = await sql<{ id: string }[]>`
        INSERT INTO ai.turns (short_id, conversation_id, status, model_profile_id, run_config, completed_at)
        VALUES (${createAiShortId()}, ${conversation.id}::uuid, 'completed', ${modelA}, '{"kind":"chat"}'::jsonb, now()) RETURNING id
      `;
      const [secondTurn] = await sql<{ id: string }[]>`
        INSERT INTO ai.turns (short_id, conversation_id, status, model_profile_id, run_config, completed_at)
        VALUES (${createAiShortId()}, ${conversation.id}::uuid, 'completed', ${modelB}, '{"kind":"chat"}'::jsonb, now()) RETURNING id
      `;
      await sql`
        INSERT INTO ai.messages (short_id, conversation_id, seq, kind, role, message, model_profile_id, provider_model, usage, loop_id, loop_aggregate, loop_done_reason)
        VALUES
          (${createAiShortId()}, ${conversation.id}::uuid, 1, 'message', 'assistant', '{"role":"assistant","content":[{"type":"text","text":"One"}]}'::jsonb, ${modelA}, 'provider/fast', '{"input":100,"output":20,"total":120,"creditsUsed":0.12}'::jsonb, ${firstTurn!.id}, '{"usage":{"input":100,"output":20,"total":120,"creditsUsed":0.12},"timing":{"generationMs":500,"outputTokensPerSecond":40}}'::jsonb, 'stop'),
          (${createAiShortId()}, ${conversation.id}::uuid, 2, 'message', 'assistant', '{"role":"assistant","content":[{"type":"text","text":"Two"}]}'::jsonb, ${modelB}, 'provider/quality', '{"input":200,"output":50,"total":250,"creditsUsed":0.5}'::jsonb, ${secondTurn!.id}, '{"usage":{"input":200,"output":50,"total":250,"creditsUsed":0.5},"timing":{"generationMs":1000,"outputTokensPerSecond":50}}'::jsonb, 'stop')
      `;
      const messages = await aiConversations.listMessages({ conversationId: conversation.id });
      await aiConversations.setMessageFeedback({
        conversationId: conversation.id,
        messageShortId: messages.at(-1)!.shortId,
        feedback: { rating: "down", reasons: ["incorrect"], comment: "Test feedback" },
      });
      await sql`
        INSERT INTO ai.tool_calls (turn_id, conversation_id, call_id, tool_name, status, started_at, completed_at)
        VALUES (${secondTurn!.id}::uuid, ${conversation.id}::uuid, 'usage-call', ${capability}, 'failed', now() - interval '100 milliseconds', now())
      `;
      await recordAiStructuredRun({
        task,
        appId: "core",
        modelProfileId: modelB,
        providerModel: "provider/quality",
        status: "failed",
        durationMs: 400,
        usage: { input: 50, output: 10, total: 60 },
        errorCode: "invalid_output",
        error: "Test background failure",
      });

      const report = await aiUsage.report("24h");
      expect(report.models.items.find((row) => row.id === modelB)).toMatchObject({ runs: 2, tokens: 310, negative: 1 });
      expect(report.users.items.find((row) => row.id === user!.id)).toMatchObject({ runs: 2, tokens: 370, rated: 1 });
      expect(report.capabilities.items.find((row) => row.id === capability)).toMatchObject({ runs: 1, failed: 1 });
      expect(report.tasks.items.find((row) => row.id === task)).toMatchObject({ runs: 1, failed: 1, tokens: 60 });
      expect(report.apps.items.find((row) => row.id === "mail")?.runs).toBeGreaterThanOrEqual(1);
      expect(report.feedback.items.find((row) => row.comment === "Test feedback")?.reasons).toEqual(["incorrect"]);
      expect(report.overview.switchesAway).toBeGreaterThanOrEqual(1);
    } finally {
      await sql`DELETE FROM ai.structured_runs WHERE task = ${task}`;
      for (const conversationId of conversationIds) await sql`DELETE FROM ai.conversations WHERE id = ${conversationId}::uuid`;
      if (user) await sql`DELETE FROM auth.users WHERE id = ${user.id}::uuid`;
    }
  });
});

suite("AI usage durable accounting", () => {
  const fixture = async () => {
    const uid = `usage-${crypto.randomUUID()}`;
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name)
      VALUES (${uid}, 'local', 'user', ${uid}) RETURNING id
    `;
    const conversations: string[] = [];
    const conversation = async () => {
      const value = await aiConversations.createConversation({ ownerUserId: user!.id });
      conversations.push(value.id);
      return value;
    };
    return {
      userId: user!.id,
      conversation,
      cleanup: async () => {
        for (const id of conversations) await sql`DELETE FROM ai.conversations WHERE id = ${id}::uuid`;
        await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
      },
    };
  };

  test("keeps every provider response after retry and edit truncate the message history", async () => {
    const f = await fixture();
    try {
      const conversation = await f.conversation();
      const submit = (truncateFromSeq?: number) =>
        aiConversations.submitChatTurn({
          conversationId: conversation.id,
          modelProfileId: "usage-retry-model",
          runConfig: { kind: "chat", input: "Hello", toolSource: { kind: "none" } },
          userMessage: { role: "user", content: [{ type: "text", text: "Hello" }] },
          truncateFromSeq,
        });
      const first = await submit();
      const firstStore = aiConversations.createSessionStore({
        conversationId: conversation.id,
        turnId: first.turn.id,
        modelProfileId: "usage-retry-model",
      });
      for (const total of [100, 200])
        await firstStore.append({
          role: "assistant",
          content: [{ type: "text", text: "Response" }],
          model: "provider/retry",
          usage: { input: total - 10, output: 10, total, creditsUsed: total / 1000 },
        });
      await sql`UPDATE ai.turns SET status = 'completed', completed_at = now() WHERE id = ${first.turn.id}::uuid`;
      const beforeRetry = (await aiUsage.report("24h")).users.items.find((row) => row.id === f.userId);
      expect(beforeRetry?.tokens).toBe(300);
      expect(beforeRetry?.credits).toBeCloseTo(0.3);
      const fork = await f.conversation();
      await aiConversations.copyMessages({ sourceConversationId: conversation.id, targetConversationId: fork.id, throughSeq: 3 });
      // Forking copies context, but performs no inference and must not add usage.
      expect((await aiUsage.report("24h")).users.items.find((row) => row.id === f.userId)?.tokens).toBe(300);
      await sql`
        UPDATE ai.messages SET loop_aggregate = '{"timing":{"generationMs":1200,"outputTokensPerSecond":25}}'::jsonb
        WHERE conversation_id = ${conversation.id}::uuid AND seq = 3
      `;
      const retry = await submit(2);
      const retryStore = aiConversations.createSessionStore({
        conversationId: conversation.id,
        turnId: retry.turn.id,
        modelProfileId: "usage-retry-model",
      });
      await retryStore.append({
        role: "assistant",
        content: [{ type: "text", text: "Retry" }],
        usage: { input: 40, output: 10, total: 50, creditsUsed: 0.05 },
      });
      await aiConversations.truncateMessagesFrom({ conversationId: conversation.id, fromSeq: 1 });
      expect(await aiConversations.listMessages({ conversationId: conversation.id })).toHaveLength(0);
      const report = await aiUsage.report("24h");
      expect(report.users.items.find((row) => row.id === f.userId)).toMatchObject({ runs: 2, tokens: 350 });
      expect(report.users.items.find((row) => row.id === f.userId)?.credits).toBeCloseTo(0.35);
      expect(report.models.items.filter((row) => row.id === "usage-retry-model").reduce((sum, row) => sum + (row.tokens ?? 0), 0)).toBe(
        350,
      );
      expect(report.models.items.find((row) => row.providerModel === "provider/retry")?.avgDurationMs).toBe(1200);
      // Re-running the migration must never re-add usage, or erase deleted history.
      await migrateCloudAi();
      expect((await aiUsage.report("24h")).users.items.find((row) => row.id === f.userId)?.tokens).toBe(350);
    } finally {
      await f.cleanup();
    }
  });

  test("counts distinct user capabilities across conversations", async () => {
    const f = await fixture();
    try {
      for (const names of [
        ["usage.lookup", "usage.shared"],
        ["usage.write", "usage.shared"],
      ]) {
        const conversation = await f.conversation();
        const { turn } = await aiConversations.submitChatTurn({
          conversationId: conversation.id,
          modelProfileId: "usage-caps",
          runConfig: { kind: "chat", input: "Hello", toolSource: { kind: "none" } },
          userMessage: { role: "user", content: [{ type: "text", text: "Hello" }] },
        });
        for (const name of names)
          await sql`
          INSERT INTO ai.tool_calls (turn_id, conversation_id, call_id, tool_name, status)
          VALUES (${turn.id}::uuid, ${conversation.id}::uuid, ${name}, ${name}, 'completed')
        `;
      }
      expect((await aiUsage.report("24h")).users.items.find((row) => row.id === f.userId)?.capabilities).toBe(3);
    } finally {
      await f.cleanup();
    }
  });

  test("fills inactive UTC time buckets with zero usage", async () => {
    for (const range of ["24h", "7d", "30d", "90d"] as const) {
      const report = await aiUsage.report(range);
      const step = range === "24h" ? 3_600_000 : 86_400_000;
      expect(report.timeline.length).toBeGreaterThanOrEqual(range === "24h" ? 24 : Number.parseInt(range));
      for (let index = 1; index < report.timeline.length; index++) {
        expect(Date.parse(report.timeline[index]!.bucket) - Date.parse(report.timeline[index - 1]!.bucket)).toBe(step);
      }
      expect(report.timeline.some((point) => point.turns === 0 && point.tokens === 0 && point.failed === 0)).toBeTrue();
    }
  });

  test("distinguishes known, unknown, and reported zero background credits", async () => {
    const prefix = `coverage-${crypto.randomUUID()}`;
    try {
      for (const [task, creditsUsed] of [
        ["mixed", 0.5],
        ["mixed", undefined],
        ["zero", 0],
        ["unknown", undefined],
      ] as const) {
        await recordAiStructuredRun({
          task: `${prefix}-${task}`,
          status: "ok",
          durationMs: 10,
          usage: { input: 8, output: 2, total: 10, ...(creditsUsed === undefined ? {} : { creditsUsed }) },
        });
      }
      const report = await aiUsage.report("24h");
      expect(report.tasks.items.find((row) => row.id === `${prefix}-mixed`)).toMatchObject({
        runs: 2,
        credits: 0.5,
        creditsCoverage: 0.5,
      });
      expect(report.tasks.items.find((row) => row.id === `${prefix}-zero`)).toMatchObject({ credits: 0, creditsCoverage: 1 });
      expect(report.tasks.items.find((row) => row.id === `${prefix}-unknown`)).toMatchObject({ credits: null, creditsCoverage: 0 });
    } finally {
      await sql`DELETE FROM ai.structured_runs WHERE task LIKE ${`${prefix}-%`}`;
    }
  });

  test("paginates more than 100 background groups and clamps out-of-range pages", async () => {
    const prefix = `pages-${crypto.randomUUID()}`;
    try {
      await sql`
        INSERT INTO ai.structured_runs (task, app_id, model_profile_id, status, duration_ms)
        SELECT ${prefix} || '-' || n, 'core', 'usage-pages', 'ok', 1 FROM generate_series(1, 105) AS n
      `;
      const first = await aiUsage.report("24h", { page: 1, perPage: 100 });
      const second = await aiUsage.report("24h", { page: 2, perPage: 100 });
      expect(first.tasks).toMatchObject({ page: 1, perPage: 100, total: 105 });
      expect(first.tasks.items).toHaveLength(100);
      expect(second.tasks.items).toHaveLength(5);
      expect(new Set([...first.tasks.items, ...second.tasks.items].map((row) => row.id)).size).toBe(105);
      const beyond = await aiUsage.report("24h", { page: 999, perPage: 100 });
      expect(beyond.tasks.page).toBe(2);
      expect(beyond.tasks.items).toEqual(second.tasks.items);
    } finally {
      await sql`DELETE FROM ai.structured_runs WHERE task LIKE ${`${prefix}-%`}`;
    }
  });

  test("exposes every user, capability, and feedback row beyond the first page", async () => {
    const prefix = `page-user-${crypto.randomUUID()}`;
    try {
      await sql`
        INSERT INTO auth.users (uid, provider, profile, display_name)
        SELECT ${prefix} || '-' || n, 'local', 'user', ${prefix} || '-' || n
        FROM generate_series(1, 105) AS n
      `;
      const users = await sql<{ id: string; uid: string }[]>`SELECT id, uid FROM auth.users WHERE uid LIKE ${`${prefix}-%`}`;
      for (const user of users) {
        const conversation = await aiConversations.createConversation({ ownerUserId: user.id });
        const [turn] = await sql<{ id: string }[]>`
          INSERT INTO ai.turns (short_id, conversation_id, model_profile_id, status, run_config)
          VALUES (${createAiShortId()}, ${conversation.id}::uuid, 'usage-pages', 'queued', '{"kind":"chat"}'::jsonb) RETURNING id
        `;
        await sql`
          INSERT INTO ai.tool_calls (turn_id, conversation_id, call_id, tool_name, status)
          VALUES (${turn!.id}::uuid, ${conversation.id}::uuid, 'page-call', ${`test.${user.uid}`}, 'completed')
        `;
        await sql`
          INSERT INTO ai.messages (short_id, conversation_id, seq, kind, role, message, loop_id, feedback_rating, feedback_updated_at)
          VALUES (${createAiShortId()}, ${conversation.id}::uuid, 1, 'message', 'assistant', '{"role":"assistant","content":[]}'::jsonb, ${turn!.id}, 1, now())
        `;
      }
      const first = await aiUsage.report("24h", { perPage: 100 });
      const second = await aiUsage.report("24h", { page: 2, perPage: 100 });
      const beyond = await aiUsage.report("24h", { page: 999, perPage: 100 });
      for (const key of ["users", "capabilities", "feedback"] as const) {
        expect(first[key]).toMatchObject({ page: 1, perPage: 100, total: 105 });
        expect(first[key].items).toHaveLength(100);
        expect(second[key].items).toHaveLength(5);
        expect(beyond[key].page).toBe(2);
        expect(beyond[key]).toEqual(second[key]);
      }
      expect(new Set([...first.users.items, ...second.users.items].map((row) => row.id)).size).toBe(105);
      expect(new Set([...first.capabilities.items, ...second.capabilities.items].map((row) => row.id)).size).toBe(105);
      expect(new Set([...first.feedback.items, ...second.feedback.items].map((row) => row.id)).size).toBe(105);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE created_by_user_id IN (SELECT id FROM auth.users WHERE uid LIKE ${`${prefix}-%`})`;
      await sql`DELETE FROM auth.users WHERE uid LIKE ${`${prefix}-%`}`;
    }
  });
});

suite("AI usage exploration", () => {
  test("combines filters, preserves feedback denominators, separates provider models and exposes attributed errors", async () => {
    const prefix = `explore-${crypto.randomUUID()}`;
    const ids: string[] = [];
    const conversations: string[] = [];
    try {
      for (const name of ["A", "B"]) {
        const [user] = await sql<
          { id: string }[]
        >`INSERT INTO auth.users(uid,provider,profile,display_name) VALUES(${`${prefix}-${name}`},'local','user',${name}) RETURNING id`;
        ids.push(user!.id);
        const conversation = await aiConversations.createConversation({ ownerUserId: user!.id, launchedByAppId: "test-app" });
        conversations.push(conversation.id);
      }
      const turn = async (user: number, provider: string, total: number, old = false) => {
        const [value] = await sql<
          { id: string }[]
        >`INSERT INTO ai.turns(short_id,conversation_id,status,model_profile_id,run_config,created_at,usage,provider_model)
          VALUES(${createAiShortId()},${conversations[user]}::uuid,'completed',${prefix},'{"kind":"chat"}',now()-${old ? 172800 : 60}*interval '1 second',${JSON.stringify({ input: total - 10, output: 10, total, creditsUsed: total / 1000 })}::jsonb,${provider}) RETURNING id`;
        return value!.id;
      };
      const a = await turn(0, "provider/a", 100),
        a2 = await turn(0, "provider/b", 50),
        b = await turn(1, "provider/a", 200),
        old = await turn(0, "provider/a", 900, true);
      for (const [idx, id, rating] of [
        [0, a, -1],
        [0, a2, null],
        [1, b, 1],
        [0, old, -1],
      ] as const) {
        await sql`INSERT INTO ai.messages(short_id,conversation_id,seq,kind,role,message,loop_id,model_profile_id,feedback_rating,feedback_reasons,feedback_comment,feedback_updated_at)
          VALUES(${createAiShortId()},${conversations[idx]}::uuid,${id === a ? 1 : id === a2 ? 2 : id === old ? 3 : 1},'message','assistant','{"role":"assistant","content":[]}',${id},${prefix},${rating},CASE WHEN ${rating}::int=-1 THEN ARRAY['incorrect'] ELSE '{}'::text[] END,${rating !== -1 ? null : id === old ? "old response" : "complete feedback"},CASE WHEN ${rating}::int IS NULL THEN NULL ELSE now() END)`;
      }
      const fullError = "Provider rejected this request. " + "context ".repeat(220);
      await recordAiStructuredRun({
        task: prefix,
        appId: "test-app",
        modelProfileId: prefix,
        providerModel: "provider/a",
        status: "failed",
        durationMs: 30,
        errorCode: "provider_rejected",
        error: fullError,
        usage: { input: 8, output: 2, total: 10, creditsUsed: 0.01 },
        attribution: { conversationId: conversations[0], turnId: a },
      });
      await recordAiStructuredRun({
        task: prefix,
        appId: "test-app",
        modelProfileId: prefix,
        providerModel: "provider/a",
        status: "failed",
        durationMs: 40,
        error: "legacy unassigned",
      });
      await sql`INSERT INTO ai.tool_calls(turn_id,conversation_id,call_id,tool_name,status,error) VALUES(${a}::uuid,${conversations[0]}::uuid,'call','mail.lookup','failed','Tool unavailable')`;
      const report = await aiUsage.report("24h", {
        userId: ids[0],
        modelProfileId: prefix,
        providerModel: "provider/a",
        appId: "test-app",
      });
      expect(report.overview).toMatchObject({ runs: 2, tokens: 110, negative: 1, positive: 0, rated: 1, assistantMessages: 1 });
      expect(report.tool.runs).toBe(1);
      expect(report.unassignedBackgroundRuns).toBe(1);
      expect(report.feedback.items).toHaveLength(1);
      expect(report.feedback.items[0]?.comment).toBe("complete feedback");
      const failure = report.runs.items.find((row) => row.kind === "background")!;
      expect(failure).toMatchObject({
        userId: ids[0],
        conversationId: conversations[0],
        turnId: a,
        errorCode: "provider_rejected",
        error: fullError,
      });
      expect(await aiUsage.detail("background", failure.id)).toEqual(failure);
      const all = await aiUsage.report("24h", { modelProfileId: prefix, sort: "negativeRate" });
      expect(all.models.items).toHaveLength(2);
      expect(all.users.items[0]).toMatchObject({ id: ids[0], negative: 1, rated: 1, assistantMessages: 2 });
      const positiveOnly = await aiUsage.report("24h", { modelProfileId: prefix, rating: "up" });
      expect(positiveOnly.chat).toMatchObject({ positive: 1, negative: 1, rated: 2, assistantMessages: 3 });
      expect(positiveOnly.feedback.items).toHaveLength(1);
      const failures = await aiUsage.report("24h", {
        modelProfileId: prefix,
        kind: "background",
        status: "failed",
        errorCode: "provider_rejected",
        search: "rejected",
      });
      expect(failures.runs.total).toBe(1);
      const orphan = await aiUsage.report("24h", { modelProfileId: prefix, userId: "unassigned" });
      expect(orphan.overview).toMatchObject({ runs: 1, tokens: null, credits: null, tokenCoverage: 0 });
      const page1 = await aiUsage.report("24h", { modelProfileId: prefix, perPage: 1 });
      const page2 = await aiUsage.report("24h", { ...page1.query, page: 2 });
      expect(page2.until).toBe(page1.until);
      expect(page2.runs.items[0]?.id).not.toBe(page1.runs.items[0]?.id);
      expect((await aiUsage.facets("userId", ids[0]!, { range: "24h" })).map((row) => row.id)).toEqual([ids[0]!]);
    } finally {
      await sql`DELETE FROM ai.structured_runs WHERE task=${prefix}`;
      for (const id of conversations) await sql`DELETE FROM ai.conversations WHERE id=${id}::uuid`;
      for (const id of ids) await sql`DELETE FROM auth.users WHERE id=${id}::uuid`;
    }
  });
});
