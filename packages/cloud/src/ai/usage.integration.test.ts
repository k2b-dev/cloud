import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { migrateCloudAi } from "./migrate";
import { createAiShortId } from "./short-id";
import { aiConversations } from "./store";
import { recordAiStructuredRun } from "./structured-runs";
import { aiUsage } from "./usage";

const canUseDatabase = async () => {
  try {
    const [row] = await sql<{ users: string | null }[]>`SELECT to_regclass('auth.users')::text AS users`;
    if (!row?.users) return false;
    await migrateCloudAi();
    return true;
  } catch {
    return false;
  }
};
const suite = (await canUseDatabase()) ? describe : describe.skip;

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
