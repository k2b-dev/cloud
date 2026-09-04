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
      expect(report.models.find((row) => row.modelProfileId === modelB)).toMatchObject({ turns: 1, tokens: 250, negativeFeedback: 1 });
      expect(report.users.find((row) => row.userId === user!.id)).toMatchObject({ turns: 2, tokens: 370, feedbackGiven: 1 });
      expect(report.capabilities.find((row) => row.name === capability)).toMatchObject({ calls: 1, failed: 1 });
      expect(report.backgroundTasks.find((row) => row.task === task)).toMatchObject({ runs: 1, failed: 1, tokens: 60 });
      expect(report.launches.find((row) => row.appId === "mail")?.chats).toBeGreaterThanOrEqual(1);
      expect(report.feedback.find((row) => row.comment === "Test feedback")?.reasons).toEqual(["incorrect"]);
      expect(report.overview.modelSwitches).toBeGreaterThanOrEqual(1);
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
      const beforeRetry = (await aiUsage.report("24h")).users.find((row) => row.userId === f.userId);
      expect(beforeRetry?.tokens).toBe(300);
      expect(beforeRetry?.credits).toBeCloseTo(0.3);
      const fork = await f.conversation();
      await aiConversations.copyMessages({ sourceConversationId: conversation.id, targetConversationId: fork.id, throughSeq: 3 });
      // Forking copies context, but performs no inference and must not add usage.
      expect((await aiUsage.report("24h")).users.find((row) => row.userId === f.userId)?.tokens).toBe(300);
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
      expect(report.users.find((row) => row.userId === f.userId)).toMatchObject({ turns: 2, tokens: 350 });
      expect(report.users.find((row) => row.userId === f.userId)?.credits).toBeCloseTo(0.35);
      expect(report.models.find((row) => row.modelProfileId === "usage-retry-model")).toMatchObject({
        tokens: 350,
        avgGenerationMs: 1200,
        avgOutputTokensPerSecond: 25,
      });
      // Re-running the migration must never re-add usage, or erase deleted history.
      await migrateCloudAi();
      expect((await aiUsage.report("24h")).users.find((row) => row.userId === f.userId)?.tokens).toBe(350);
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
      expect((await aiUsage.report("24h")).users.find((row) => row.userId === f.userId)?.capabilities).toBe(3);
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
      expect(report.backgroundTasks.find((row) => row.task === `${prefix}-mixed`)).toMatchObject({
        runs: 2,
        credits: 0.5,
        creditsCoverage: 0.5,
      });
      expect(report.backgroundTasks.find((row) => row.task === `${prefix}-zero`)).toMatchObject({ credits: 0, creditsCoverage: 1 });
      expect(report.backgroundTasks.find((row) => row.task === `${prefix}-unknown`)).toMatchObject({ credits: null, creditsCoverage: 0 });
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
      const first = await aiUsage.report("24h", { backgroundTasksPage: 1 });
      const second = await aiUsage.report("24h", { backgroundTasksPage: 2 });
      expect(first.pagination.backgroundTasks).toMatchObject({ page: 1, perPage: 100, total: 105 });
      expect(first.backgroundTasks).toHaveLength(100);
      expect(second.backgroundTasks).toHaveLength(5);
      expect(new Set([...first.backgroundTasks, ...second.backgroundTasks].map((row) => row.task)).size).toBe(105);
      const beyond = await aiUsage.report("24h", { backgroundTasksPage: 999 });
      expect(beyond.pagination.backgroundTasks.page).toBe(2);
      expect(beyond.backgroundTasks).toEqual(second.backgroundTasks);
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
      const first = await aiUsage.report("24h");
      const second = await aiUsage.report("24h", { usersPage: 2, capabilitiesPage: 2, feedbackPage: 2 });
      const beyond = await aiUsage.report("24h", { usersPage: 999, capabilitiesPage: 999, feedbackPage: 999 });
      for (const key of ["users", "capabilities", "feedback"] as const) {
        expect(first.pagination[key]).toMatchObject({ page: 1, perPage: 100, total: 105 });
        expect(first[key]).toHaveLength(100);
        expect(second[key]).toHaveLength(5);
        expect(beyond.pagination[key].page).toBe(2);
        expect(beyond[key]).toEqual(second[key]);
      }
      expect(new Set([...first.users, ...second.users].map((row) => row.userId)).size).toBe(105);
      expect(new Set([...first.capabilities, ...second.capabilities].map((row) => row.name)).size).toBe(105);
      expect(new Set([...first.feedback, ...second.feedback].map((row) => row.messageId)).size).toBe(105);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE created_by_user_id IN (SELECT id FROM auth.users WHERE uid LIKE ${`${prefix}-%`})`;
      await sql`DELETE FROM auth.users WHERE uid LIKE ${`${prefix}-%`}`;
    }
  });
});
