import { afterAll, expect, test } from "bun:test";
import { databaseSuite, testInfra, useMigratedDatabase } from "../../../../scripts/fixtures/test-infra";

const database = testInfra.database ? await useMigratedDatabase("retired_routines") : null;
const { sql } = await import("../runtime/clients");
const { migrateCloudAi } = await import("./migrate");
const { aiConversations } = await import("./store");
afterAll(async () => {
  await database?.drop();
});

// A private migrated database lets this fixture represent the last old release,
// then run the real startup migration twice. No existing installation is used.
databaseSuite()("scheduled routine retirement", () => {
  test("fresh startup creates no routine product; upgrade preserves evidence and cannot regain authority after restart", async () => {
    await migrateCloudAi();
    expect((await sql`SELECT to_regclass('ai.chat_tasks') AS tasks, to_regclass('ai.chat_task_occurrences') AS runs`)[0]).toEqual({
      tasks: null,
      runs: null,
    });
    const [owner] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, mail)
      VALUES ('retired-routine-owner', 'local', 'user', 'owner@example.test') RETURNING id`;
    const chat = await aiConversations.createConversation({ ownerUserId: owner!.id });
    const taskId = "11111111-1111-4111-8111-111111111111";
    const turnId = "22222222-2222-4222-8222-222222222222";
    const mandateId = "33333333-3333-4333-8333-333333333333";
    const config = {
      kind: "chat",
      input: "Routine prompt",
      background: { taskId: "Task01", occurrenceId: "Run001", context: [] },
      mandate: { id: mandateId, revision: 1 },
    };
    await sql.begin(async (db) => {
      // Only the pre-upgrade fixture bypasses fences, before any workers exist.
      await db`DROP TRIGGER ai_retired_routine_turn ON ai.turns`;
      await db`DROP TRIGGER ai_retired_routine_mandate ON auth.mandates`;
      await db`DROP TRIGGER ai_routine_archive_read_only ON ai.task_messages`;
      await db`CREATE TABLE ai.chat_tasks(id UUID PRIMARY KEY, conversation_id UUID REFERENCES ai.conversations(id) ON DELETE CASCADE,
        sponsor_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE, mandate_id UUID REFERENCES auth.mandates(id) ON DELETE SET NULL,
        state TEXT, prompt TEXT, grants JSONB)`;
      await db`CREATE TABLE ai.chat_task_occurrences(id UUID PRIMARY KEY, task_id UUID REFERENCES ai.chat_tasks(id) ON DELETE CASCADE,
        turn_id UUID REFERENCES ai.turns(id) ON DELETE SET NULL, state TEXT, result_text TEXT, error TEXT)`;
      await db`INSERT INTO auth.mandates(id, subject_kind, subject_user_id, owner_app_id, workload_type, workload_id, policy, confirmed_at)
        VALUES (${mandateId}::uuid, 'user', ${owner!.id}::uuid, 'core', 'ai.chat-task', ${taskId},
          '{"version":1,"apps":"*","operations":"*","actions":"require_approval","grants":[{"kind":"database","fixedInput":{}}]}'::jsonb,
          '2026-11-06T08:00:00Z')`;
      await db`INSERT INTO ai.turns(id, short_id, conversation_id, status, run_config)
        VALUES (${turnId}::uuid, 'Turn01', ${chat.id}::uuid, 'queued', ${JSON.stringify(config)}::text::jsonb)`;
      await db`INSERT INTO ai.chat_tasks VALUES (${taskId}::uuid, ${chat.id}::uuid, ${owner!.id}::uuid, ${mandateId}::uuid,
        'active', 'Routine prompt', '[{"kind":"database","fixedInput":{}}]'::jsonb)`;
      await db`INSERT INTO ai.chat_task_occurrences VALUES ('44444444-4444-4444-8444-444444444444', ${taskId}::uuid,
        ${turnId}::uuid, 'running', 'Partial result', 'Original error')`;
      await db`INSERT INTO ai.task_messages(short_id, conversation_id, seq, kind, role, message, loop_id)
        VALUES ('Msg001', ${chat.id}::uuid, 1, 'message', 'assistant',
          '{"role":"assistant","content":[{"type":"text","text":"Preserved run log"}]}'::jsonb, ${turnId})`;
    });
    const evidence = async () => ({
      tasks: await sql`SELECT to_jsonb(row) - 'retired_mandate' AS row FROM ai.chat_tasks row`,
      runs: await sql`SELECT to_jsonb(row) AS row FROM ai.chat_task_occurrences row`,
      logs: await sql`SELECT to_jsonb(row) AS row FROM ai.task_messages row`,
    });
    const before = await evidence();
    await migrateCloudAi();
    await migrateCloudAi();
    expect(await evidence()).toEqual(before);
    const [revoked] = await sql`SELECT state, revision FROM auth.mandates WHERE id=${mandateId}::uuid`;
    expect(revoked.state).toBe("revoked");
    expect(Number(revoked.revision)).toBe(2);
    const [archive] = await sql`SELECT retired_mandate FROM ai.chat_tasks WHERE id=${taskId}::uuid`;
    expect(archive.retired_mandate.state).toBe("active");
    expect(archive.retired_mandate.policy.grants[0].kind).toBe("database");
    expect((await aiConversations.getTurn({ conversationId: chat.id, turnId }))?.status).toBe("aborted");
    expect((await aiConversations.listTurnMessages({ conversationId: chat.id, loopId: turnId })).map((row) => row.message)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "Preserved run log" }] },
    ]);
    expect(
      await aiConversations.claimTurn({
        conversationId: chat.id,
        turnId,
        leaseOwner: "restart",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      }),
    ).toBeNull();
    await expect(sql`UPDATE ai.turns SET status='queued' WHERE id=${turnId}::uuid`).rejects.toThrow("routines are retired");
    await expect(sql`UPDATE auth.mandates SET state='active' WHERE id=${mandateId}::uuid`).rejects.toThrow("routines are retired");
    await expect(sql`UPDATE ai.chat_tasks SET state='active'`).rejects.toThrow("read-only");
    await expect(sql`DELETE FROM ai.chat_task_occurrences`).rejects.toThrow("read-only");
    await expect(sql`TRUNCATE ai.task_messages`).rejects.toThrow("read-only");
    await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
    await sql`DELETE FROM auth.users WHERE id=${owner!.id}::uuid`;
    expect(await evidence()).toEqual(before);
    expect((await sql`SELECT retired_mandate FROM ai.chat_tasks WHERE id=${taskId}::uuid`)[0]).toEqual(archive);
  });
});
