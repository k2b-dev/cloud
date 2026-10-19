import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { mandates } from "../services/mandates";
import { toAiChatTaskView } from "./chat-task-contracts";
import { chatTaskReasonSentence } from "./chat-task-reasons";
import { AiChatTaskIdempotencyConflictError, type AiChatTaskSchedule, aiChatTasks } from "./chat-tasks";
import { authorizeCodeExecution } from "./code-execution";
import { aiMemoryLearningRuns } from "./memory-learning-runs";
import { migrateCloudAi } from "./migrate";
import { AI_SHORT_ID_PATTERN, createAiShortId } from "./short-id";
import { aiConversations } from "./store";

const suite = databaseSuite();

suite("AI chat tasks", () => {
  beforeAll(async () => {
    await migrateCloudAi();
  });
  const createRetentionRun = async (input: {
    userId: string;
    conversation: { id: string; shortId: string };
    now: Date;
    ageDays: number;
    schedule?: AiChatTaskSchedule;
    state?: "completed" | "failed" | "running";
    turnStatus?: "completed" | "failed" | "aborted" | "running";
  }) => {
    const state = input.state ?? "completed";
    const finishedAt = new Date(input.now.getTime() - input.ageDays * 86_400_000);
    const startedAt = new Date(finishedAt.getTime() - 60_000);
    const task = (await aiChatTasks.create({
      userId: input.userId,
      chatId: input.conversation.shortId,
      prompt: "Retention evidence",
      schedule: input.schedule ?? { kind: "cron", cron: "0 9 * * *" },
      timezone: "UTC",
    }))!;
    const occurrence = (await aiChatTasks.createOccurrence({
      taskId: task.id,
      scheduledFor: startedAt.toISOString(),
      trigger: "manual",
      requestKey: crypto.randomUUID(),
    }))!;
    const delivered = await aiChatTasks.deliverOccurrence({
      occurrenceId: occurrence.id,
      modelProfileId: "test",
      runConfig: { kind: "chat", input: task.prompt, toolSource: { kind: "none" } },
      userMessage: { role: "user", content: [{ type: "text", text: task.prompt }] },
      expectedRevision: task.revision,
    });
    if (!delivered.delivered) throw new Error("Expected retention run to start");
    await sql`INSERT INTO ai.task_messages(short_id, conversation_id, seq, kind, role, message, loop_id, created_at)
      VALUES (${createAiShortId()}, ${input.conversation.id}::uuid, 2, 'message', 'assistant',
        ${JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Retained chat result" }] })}::text::jsonb,
        ${delivered.turnId}, ${finishedAt})`;
    if (state !== "running") {
      expect(await aiChatTasks.finalizeTurn({ turnId: delivered.turnId, status: state })).toEqual({
        occurrenceId: occurrence.id,
        failed: state === "failed",
      });
    }
    await sql`UPDATE ai.chat_task_occurrences
      SET created_at = ${startedAt}, started_at = ${startedAt}, completed_at = ${state === "running" ? null : finishedAt}
      WHERE id = ${occurrence.id}::uuid`;
    const turnStatus = input.turnStatus ?? state;
    await sql`UPDATE ai.turns SET status = ${turnStatus}, created_at = ${startedAt},
      completed_at = ${turnStatus === "running" ? null : finishedAt} WHERE id = ${delivered.turnId}::uuid`;
    await sql`UPDATE ai.task_messages SET created_at = ${startedAt} WHERE loop_id = ${delivered.turnId} AND role = 'user'`;
    return { task, occurrence, turnId: delivered.turnId };
  };

  test("prunes expired run evidence while preserving the delivered chat result", async () => {
    const now = new Date("2001-01-01T00:00:00.000Z");
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${`retention-result-${suffix}`}, 'local', 'user', 'Retention', ${`${suffix}@example.test`}, 'AI', 'Test') RETURNING id`;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id, title: "Retained result" });
    try {
      const run = await createRetentionRun({ userId: user!.id, conversation, now, ageDays: 91 });
      await sql`INSERT INTO ai.tool_calls(turn_id, conversation_id, call_id, tool_name, status)
        VALUES (${run.turnId}::uuid, ${conversation.id}::uuid, 'retention-tool', 'code', 'completed')`;
      const before = await aiConversations.listMessages({ conversationId: conversation.id });
      expect(before).toHaveLength(1);
      expect(await sql`SELECT id FROM ai.task_messages WHERE loop_id = ${run.turnId}`).toHaveLength(2);
      expect(await aiChatTasks.pruneExpiredRuns({ now, limit: 100 })).toBe(1);
      expect(await sql`SELECT id FROM ai.chat_task_occurrences WHERE id = ${run.occurrence.id}::uuid`).toHaveLength(0);
      expect(await sql`SELECT id FROM ai.turns WHERE id = ${run.turnId}::uuid`).toHaveLength(0);
      expect(await sql`SELECT id FROM ai.task_messages WHERE loop_id = ${run.turnId}`).toHaveLength(0);
      expect(await sql`SELECT id FROM ai.tool_calls WHERE turn_id = ${run.turnId}::uuid`).toHaveLength(0);
      const results = await sql<{ loop_id: string | null }[]>`SELECT loop_id FROM ai.messages
        WHERE conversation_id = ${conversation.id}::uuid AND meta->'scheduledTask'->>'occurrenceId' = ${run.occurrence.shortId}`;
      expect(results).toEqual([{ loop_id: null }]);
      expect(await aiConversations.listMessages({ conversationId: conversation.id })).toEqual(before);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("prunes expired run evidence while preserving workflow learning runs", async () => {
    const now = new Date("2001-01-01T00:00:00.000Z");
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${`retention-learning-${suffix}`}, 'local', 'user', 'Retention', ${`${suffix}@example.test`}, 'AI', 'Test') RETURNING id`;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id, title: "Retained workflow learning" });
    try {
      const run = await createRetentionRun({ userId: user!.id, conversation, now, ageDays: 91 });
      const evidenceKey = `retention-workflow-${suffix}`;
      const learningRunId = await aiMemoryLearningRuns.start({
        userId: user!.id,
        conversationId: conversation.id,
        turnId: run.turnId,
        runKind: "workflow",
        evidenceKey,
        modelProfileId: "test",
        accountedTokens: 0,
      });
      expect(learningRunId).not.toBeNull();
      expect(await aiChatTasks.pruneExpiredRuns({ now, limit: 100 })).toBe(1);
      expect(await sql`SELECT id FROM ai.chat_task_occurrences WHERE id = ${run.occurrence.id}::uuid`).toHaveLength(0);
      expect(await sql`SELECT id FROM ai.turns WHERE id = ${run.turnId}::uuid`).toHaveLength(0);
      expect(await sql`SELECT id FROM ai.task_messages WHERE loop_id = ${run.turnId}`).toHaveLength(0);
      expect(
        await sql<
          { turn_id: string | null; evidence_key: string | null; conversation_title: string }[]
        >`SELECT turn_id, evidence_key, conversation_title FROM ai.memory_learning_runs
        WHERE id = ${learningRunId}::uuid`,
      ).toEqual([{ turn_id: null, evidence_key: evidenceKey, conversation_title: "Retained workflow learning" }]);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("keeps a one-off task's current slot row while its evidence expires, even after completion", async () => {
    const now = new Date("2001-01-01T00:00:00.000Z");
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${`retention-once-${suffix}`}, 'local', 'user', 'Retention', ${`${suffix}@example.test`}, 'AI', 'Test') RETURNING id`;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id, title: "One-off retention guard" });
    try {
      const run = await createRetentionRun({
        userId: user!.id,
        conversation,
        now,
        ageDays: 91,
        schedule: { kind: "once", runAt: "2099-01-01T09:00:00.000Z" },
      });
      // Simulate a revision change during the run: the finished task stays active at the same slot.
      await sql`UPDATE ai.chat_tasks SET state = 'active', run_at = ${run.occurrence.scheduledFor}::timestamptz
        WHERE id = ${run.task.id}::uuid`;
      const before = await aiConversations.listMessages({ conversationId: conversation.id });
      expect(before).toHaveLength(1);
      const expectKept = async (pruned: number) => {
        expect(await aiChatTasks.pruneExpiredRuns({ now })).toBe(pruned);
        expect(
          await sql<{ turn_id: string | null }[]>`SELECT turn_id FROM ai.chat_task_occurrences WHERE id = ${run.occurrence.id}::uuid`,
        ).toEqual([{ turn_id: null }]);
        expect(await sql`SELECT id FROM ai.turns WHERE id = ${run.turnId}::uuid`).toHaveLength(0);
        expect(await sql`SELECT id FROM ai.task_messages WHERE loop_id = ${run.turnId}`).toHaveLength(0);
        expect(await aiConversations.listMessages({ conversationId: conversation.id })).toEqual(before);
      };
      await expectKept(1);
      // Exercise materialization's task-scoped insert; materializeDueOnce would affect other tests' tasks.
      expect(
        await aiChatTasks.createOccurrence({
          taskId: run.task.id,
          scheduledFor: run.occurrence.scheduledFor,
          trigger: "scheduled",
          requestKey: `once:${run.task.id}:${run.occurrence.scheduledFor}`,
        }),
      ).toBeNull();
      await expectKept(0);
      await sql`UPDATE ai.chat_tasks SET state = 'completed' WHERE id = ${run.task.id}::uuid`;
      await expectKept(0);
      // A timezone edit with the same timestamp can reactivate a completed task without changing its slot.
      const reactivated = await aiChatTasks.update({
        userId: user!.id,
        taskId: run.task.shortId,
        schedule: { kind: "once", runAt: run.occurrence.scheduledFor },
        timezone: "Europe/Berlin",
      });
      expect(reactivated?.state).toBe("active");
      expect(reactivated?.schedule).toEqual({ kind: "once", runAt: run.occurrence.scheduledFor });
      await expectKept(0);
      await sql`UPDATE ai.chat_tasks SET run_at = '2099-01-02T09:00:00.000Z'::timestamptz WHERE id = ${run.task.id}::uuid`;
      expect(await aiChatTasks.pruneExpiredRuns({ now })).toBe(1);
      expect(await sql`SELECT id FROM ai.chat_task_occurrences WHERE id = ${run.occurrence.id}::uuid`).toHaveLength(0);
      expect(await sql`SELECT id FROM ai.turns WHERE id = ${run.turnId}::uuid`).toHaveLength(0);
      expect(await sql`SELECT id FROM ai.task_messages WHERE loop_id = ${run.turnId}`).toHaveLength(0);
      expect(await aiChatTasks.pruneExpiredRuns({ now })).toBe(0);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("expires orphaned run evidence after task deletion while keeping recent and active turns and chat results", async () => {
    const now = new Date("2001-01-01T00:00:00.000Z");
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${`retention-orphans-${suffix}`}, 'local', 'user', 'Retention', ${`${suffix}@example.test`}, 'AI', 'Test') RETURNING id`;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id, title: "Deleted task runs" });
    try {
      const expired = await createRetentionRun({ userId: user!.id, conversation, now, ageDays: 91 });
      const recent = await createRetentionRun({ userId: user!.id, conversation, now, ageDays: 89 });
      const running = await createRetentionRun({
        userId: user!.id,
        conversation,
        now,
        ageDays: 200,
        state: "running",
        turnStatus: "running",
      });
      const runs = [expired, recent, running];
      // A live worker owns the active turn, so deleting its routine only asks it to stop and it stays active.
      await sql`UPDATE ai.turns SET status = 'running', lease_owner = 'retention-worker', lease_expires_at = now() + interval '1 hour'
        WHERE id = ${running.turnId}::uuid`;
      await sql`INSERT INTO ai.tool_calls(turn_id, conversation_id, call_id, tool_name, status)
        VALUES (${expired.turnId}::uuid, ${conversation.id}::uuid, 'orphan-retention-tool', 'code', 'completed')`;
      // Seed a chat result for the active run too, to guard every run's delivered messages.
      await sql`INSERT INTO ai.messages(short_id, conversation_id, seq, kind, role, message, meta, created_at)
        VALUES (${createAiShortId()}, ${conversation.id}::uuid,
          (SELECT COALESCE(MAX(seq), 0) + 1 FROM ai.messages WHERE conversation_id = ${conversation.id}::uuid),
          'message', 'assistant',
          ${JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Retained active run result" }] })}::text::jsonb,
          ${JSON.stringify({ scheduledTask: { taskId: running.task.shortId, occurrenceId: running.occurrence.shortId } })}::text::jsonb,
          ${now})`;
      const before = await aiConversations.listMessages({ conversationId: conversation.id });
      expect(before).toHaveLength(3);
      for (const run of runs) {
        expect(await aiChatTasks.delete({ userId: user!.id, taskId: run.task.shortId })).toBe(true);
        expect(await sql`SELECT id FROM ai.chat_task_occurrences WHERE id = ${run.occurrence.id}::uuid`).toHaveLength(0);
        expect(await sql`SELECT id FROM ai.turns WHERE id = ${run.turnId}::uuid`).toHaveLength(1);
        expect(await sql`SELECT id FROM ai.task_messages WHERE loop_id = ${run.turnId}`).toHaveLength(2);
      }
      const [stopping] = await sql`SELECT status, cancellation_reason FROM ai.turns WHERE id = ${running.turnId}::uuid`;
      expect(stopping).toEqual({ status: "running", cancellation_reason: "routine_deleted" });
      expect(await aiChatTasks.pruneExpiredRuns({ now, limit: 100 })).toBe(1);
      expect(await sql`SELECT id FROM ai.turns WHERE id = ${expired.turnId}::uuid`).toHaveLength(0);
      expect(await sql`SELECT id FROM ai.task_messages WHERE loop_id = ${expired.turnId}`).toHaveLength(0);
      expect(await sql`SELECT id FROM ai.tool_calls WHERE turn_id = ${expired.turnId}::uuid`).toHaveLength(0);
      for (const run of [recent, running]) {
        expect(await sql`SELECT id FROM ai.turns WHERE id = ${run.turnId}::uuid`).toHaveLength(1);
        expect(await sql`SELECT id FROM ai.task_messages WHERE loop_id = ${run.turnId}`).toHaveLength(2);
      }
      for (const run of runs) {
        expect(
          await sql`SELECT id FROM ai.messages WHERE conversation_id = ${conversation.id}::uuid
          AND meta->'scheduledTask'->>'occurrenceId' = ${run.occurrence.shortId}`,
        ).toHaveLength(1);
      }
      expect(await aiConversations.listMessages({ conversationId: conversation.id })).toEqual(before);
      expect(await aiChatTasks.pruneExpiredRuns({ now, limit: 100 })).toBe(0);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("shares the batch budget between expired occurrences and orphaned background turns", async () => {
    const now = new Date("2001-01-01T00:00:00.000Z");
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${`retention-mixed-${suffix}`}, 'local', 'user', 'Retention', ${`${suffix}@example.test`}, 'AI', 'Test') RETURNING id`;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id, title: "Mixed retention batches" });
    try {
      const runs = [];
      for (let index = 0; index < 4; index++) {
        runs.push(await createRetentionRun({ userId: user!.id, conversation, now, ageDays: 91 + index }));
      }
      for (const run of runs.slice(2)) {
        expect(await aiChatTasks.delete({ userId: user!.id, taskId: run.task.shortId })).toBe(true);
      }
      expect(await aiChatTasks.pruneExpiredRuns({ now, limit: 3 })).toBe(3);
      for (const [index, run] of runs.entries()) {
        // Occurrences use two slots; the older orphan uses the last slot.
        expect(await sql`SELECT id FROM ai.chat_task_occurrences WHERE id = ${run.occurrence.id}::uuid`).toHaveLength(0);
        expect(await sql`SELECT id FROM ai.turns WHERE id = ${run.turnId}::uuid`).toHaveLength(index === 2 ? 1 : 0);
        expect(await sql`SELECT id FROM ai.task_messages WHERE loop_id = ${run.turnId}`).toHaveLength(index === 2 ? 2 : 0);
      }
      expect(await aiChatTasks.pruneExpiredRuns({ now, limit: 3 })).toBe(1);
      expect(await aiChatTasks.pruneExpiredRuns({ now, limit: 3 })).toBe(0);
      expect(await sql`SELECT id FROM ai.turns WHERE conversation_id = ${conversation.id}::uuid`).toHaveLength(0);
      expect(await sql`SELECT id FROM ai.task_messages WHERE conversation_id = ${conversation.id}::uuid`).toHaveLength(0);
      expect(await aiConversations.listMessages({ conversationId: conversation.id })).toHaveLength(4);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("keeps active turns and runs within retention regardless of their creation age", async () => {
    const now = new Date("2001-01-01T00:00:00.000Z");
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${`retention-kept-${suffix}`}, 'local', 'user', 'Retention', ${`${suffix}@example.test`}, 'AI', 'Test') RETURNING id`;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id, title: "Active retention runs" });
    try {
      const runs = [
        await createRetentionRun({ userId: user!.id, conversation, now, ageDays: 200, state: "running", turnStatus: "running" }),
        // A terminal turn with a running occurrence belongs to recovery, not orphan cleanup.
        await createRetentionRun({ userId: user!.id, conversation, now, ageDays: 200, state: "running", turnStatus: "completed" }),
        await createRetentionRun({ userId: user!.id, conversation, now, ageDays: 91, state: "failed", turnStatus: "running" }),
        await createRetentionRun({ userId: user!.id, conversation, now, ageDays: 89 }),
        // The cutoff is strict: a run finished exactly 90 days ago stays until the next tick.
        await createRetentionRun({ userId: user!.id, conversation, now, ageDays: 90 }),
      ];
      expect(await aiChatTasks.pruneExpiredRuns({ now, limit: 100 })).toBe(0);
      for (const run of runs) {
        expect(await sql`SELECT id FROM ai.chat_task_occurrences WHERE id = ${run.occurrence.id}::uuid`).toHaveLength(1);
        expect(await sql`SELECT id FROM ai.turns WHERE id = ${run.turnId}::uuid`).toHaveLength(1);
        expect(await sql`SELECT id FROM ai.task_messages WHERE loop_id = ${run.turnId}`).toHaveLength(2);
      }
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("prunes expired runs oldest first in bounded idempotent batches", async () => {
    const now = new Date("2001-01-01T00:00:00.000Z");
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${`retention-batches-${suffix}`}, 'local', 'user', 'Retention', ${`${suffix}@example.test`}, 'AI', 'Test') RETURNING id`;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id, title: "Retention batches" });
    try {
      const runs = [];
      for (let index = 0; index < 5; index++) {
        runs.push(
          await createRetentionRun({
            userId: user!.id,
            conversation,
            now,
            ageDays: 91 + index,
            state: index === 0 ? "failed" : "completed",
            turnStatus: index === 0 ? "aborted" : "completed",
          }),
        );
      }
      expect(await aiChatTasks.pruneExpiredRuns({ now, limit: 2 })).toBe(2);
      // Created youngest first, so the two last-created runs must be removed first.
      for (const [index, run] of runs.entries()) {
        expect(await sql`SELECT id FROM ai.chat_task_occurrences WHERE id = ${run.occurrence.id}::uuid`).toHaveLength(index >= 3 ? 0 : 1);
      }
      expect(await aiChatTasks.pruneExpiredRuns({ now, limit: 2 })).toBe(2);
      expect(await aiChatTasks.pruneExpiredRuns({ now, limit: 2 })).toBe(1);
      expect(await aiChatTasks.pruneExpiredRuns({ now, limit: 2 })).toBe(0);
      expect(await aiChatTasks.pruneExpiredRuns({ now, limit: 2 })).toBe(0);
      expect(await sql`SELECT id FROM ai.turns WHERE conversation_id = ${conversation.id}::uuid`).toHaveLength(0);
      expect(await sql`SELECT id FROM ai.task_messages WHERE conversation_id = ${conversation.id}::uuid`).toHaveLength(0);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("uses current mandate revisions for explicit lifecycle changes without restoring changed authority", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${`ai-lifecycle-${suffix}`}, 'local', 'user', 'Lifecycle', ${`${suffix}@example.test`}, 'AI', 'Test') RETURNING id
    `;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id, title: "Current lifecycle authority" });
    try {
      const task = (await aiChatTasks.create({
        userId: user!.id,
        chatId: conversation.shortId,
        prompt: "Lifecycle",
        schedule: { kind: "cron", cron: "0 9 * * *" },
        timezone: "UTC",
      }))!;
      const paused = await mandates.pause({
        mandateId: task.mandateId!,
        expectedRevision: task.mandateRevision!,
        authority: { kind: "workload", ownerAppId: "core" },
      });
      expect(paused.ok).toBe(true);
      // Explicit resume must work before scheduler reconciliation sees the independent pause.
      const resumed = await aiChatTasks.setState({ userId: user!.id, taskId: task.shortId, state: "active" });
      expect(resumed?.state).toBe("active");
      expect(resumed?.mandateRevision).toBe(task.mandateRevision! + 2);
      // Simulate an independent authority change; task lifecycle must not restore it.
      await sql`UPDATE auth.mandates SET policy = ${JSON.stringify({ version: 1, apps: ["mail"], operations: ["capability.query:mail.read"], actions: "deny" })}::text::jsonb,
        revision = revision + 1 WHERE id = ${task.mandateId!}::uuid`;
      await expect(aiChatTasks.setState({ userId: user!.id, taskId: task.shortId, state: "active" })).rejects.toThrow(
        "Scheduled task mandate cannot be resumed",
      );
      expect((await aiChatTasks.setState({ userId: user!.id, taskId: task.shortId, state: "paused" }))?.state).toBe("paused");
      const current = (await mandates.get(task.mandateId!))!;
      const changed = await mandates.updatePolicy({
        mandateId: current.id,
        expectedRevision: current.revision,
        authority: { kind: "workload", ownerAppId: "core" },
        policy: { version: 1, apps: [], operations: [], actions: "deny" },
      });
      expect(changed.ok).toBe(true);
      // Deletion must revoke the current binding even while the paused task retains an older revision.
      expect(await aiChatTasks.delete({ userId: user!.id, taskId: task.shortId })).toBe(true);
      expect((await mandates.get(current.id))?.state).toBe("revoked");

      const revokedTask = (await aiChatTasks.create({
        userId: user!.id,
        chatId: conversation.shortId,
        prompt: "Revoked",
        schedule: { kind: "cron", cron: "0 9 * * *" },
        timezone: "UTC",
      }))!;
      expect(
        (
          await mandates.revoke({
            mandateId: revokedTask.mandateId!,
            expectedRevision: revokedTask.mandateRevision!,
            authority: { kind: "interactive", userId: user!.id },
            reason: "Owner revoked authority",
          })
        ).ok,
      ).toBe(true);
      await expect(aiChatTasks.setState({ userId: user!.id, taskId: revokedTask.shortId, state: "active" })).rejects.toThrow(
        "Mandate is revoked",
      );
      expect(await aiChatTasks.delete({ userId: user!.id, taskId: revokedTask.shortId })).toBe(true);
      expect((await mandates.get(revokedTask.mandateId!))?.state).toBe("revoked");
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("executes mandated queued occurrences without an issuance switch", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${`ai-issuance-${suffix}`}, 'local', 'user', 'Issuance', ${`${suffix}@example.test`}, 'AI', 'Test') RETURNING id
    `;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id, title: "Issuance gate" });
    try {
      const task = (await aiChatTasks.create({
        userId: user!.id,
        chatId: conversation.shortId,
        prompt: "Migrated task",
        schedule: { kind: "once", runAt: new Date(Date.now() + 60_000).toISOString() },
        timezone: "UTC",
      }))!;
      await sql`UPDATE ai.chat_tasks SET run_at = now() - interval '1 minute' WHERE id = ${task.id}::uuid`;
      const waiting = (await aiChatTasks.get({ userId: user!.id, taskId: task.shortId }))!;
      expect(waiting.state).toBe("active");
      const [occurrence] = await aiChatTasks.materializeDueOnce();
      expect(occurrence?.state).toBe("queued");
      expect(await aiChatTasks.get({ userId: user!.id, taskId: task.shortId })).toEqual(waiting);
      expect((await aiChatTasks.materializeDueOnce())[0]?.id).toBe(occurrence!.id);
      expect((await aiChatTasks.listQueuedOccurrences())[0]?.occurrence.id).toBe(occurrence!.id);
      const deliver = () =>
        aiChatTasks.deliverOccurrence({
          occurrenceId: occurrence!.id,
          modelProfileId: "test",
          runConfig: { kind: "chat", input: waiting.prompt, toolSource: { kind: "none" } },
          userMessage: { role: "user", content: [{ type: "text", text: waiting.prompt }] },
          expectedRevision: waiting.revision,
        });
      expect(await aiChatTasks.get({ userId: user!.id, taskId: task.shortId })).toEqual(waiting);
      expect((await aiChatTasks.listOccurrences({ userId: user!.id, taskId: task.shortId }))?.[0]?.state).toBe("queued");
      expect(
        (await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM ai.turns WHERE conversation_id = ${conversation.id}::uuid`)[0]
          ?.count,
      ).toBe(0);

      expect((await aiChatTasks.listQueuedOccurrences())[0]?.occurrence.id).toBe(occurrence!.id);
      expect((await aiChatTasks.getQueuedOccurrence(occurrence!.id))?.task.id).toBe(task.id);
      const delivered = await deliver();
      if (!delivered.delivered) throw new Error("Expected migrated task to execute");
      await aiChatTasks.finalizeTurn({ turnId: delivered.turnId, status: "completed" });
      expect((await aiChatTasks.get({ userId: user!.id, taskId: task.shortId }))?.state).toBe("completed");
      const manualTask = (await aiChatTasks.create({
        userId: user!.id,
        chatId: conversation.shortId,
        prompt: "Manual run",
        schedule: { kind: "cron", cron: "0 9 * * *" },
        timezone: "UTC",
      }))!;
      expect(
        (
          await aiChatTasks.createOccurrence({
            taskId: manualTask.id,
            scheduledFor: new Date().toISOString(),
            trigger: "manual",
            requestKey: `legacy-manual:${suffix}`,
          })
        )?.state,
      ).toBe("queued");
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("runs different schedules independently and records only the task's current mandate", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${`ai-concurrent-${suffix}`}, 'local', 'user', 'Concurrent', ${`${suffix}@example.test`}, 'AI', 'Test') RETURNING id
    `;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id, title: "Concurrent admission" });
    try {
      const tasks = await Promise.all(
        ["First", "Second"].map((prompt) =>
          aiChatTasks.create({
            userId: user!.id,
            chatId: conversation.shortId,
            prompt,
            schedule: { kind: "cron", cron: "0 9 * * *" },
            timezone: "UTC",
          }),
        ),
      );
      const results = await Promise.all(
        tasks.map(async (task) => {
          const occurrence = (await aiChatTasks.createOccurrence({
            taskId: task!.id,
            scheduledFor: new Date().toISOString(),
            trigger: "manual",
            requestKey: `${suffix}:${task!.id}`,
          }))!;
          const result = await aiChatTasks.deliverOccurrence({
            occurrenceId: occurrence.id,
            modelProfileId: "test",
            runConfig: {
              kind: "chat",
              input: task!.prompt,
              toolSource: { kind: "none" },
              mandate: { id: crypto.randomUUID(), revision: 999 },
            },
            userMessage: { role: "user", content: [{ type: "text", text: task!.prompt }] },
            expectedRevision: task!.revision,
          });
          if (result.delivered) {
            const [turn] = await sql<
              { mandate: unknown }[]
            >`SELECT run_config->'mandate' AS mandate FROM ai.turns WHERE id = ${result.turnId}::uuid`;
            expect(turn?.mandate).toEqual({ id: task!.mandateId, revision: task!.mandateRevision });
          }
          return result;
        }),
      );
      expect(results.filter((result) => result.delivered)).toHaveLength(2);
      expect(results.filter((result) => !result.delivered)).toEqual([]);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("converges live authority before admission and never resumes it through a prompt edit", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${`ai-authority-${suffix}`}, 'local', 'user', 'Authority', ${`${suffix}@example.test`}, 'AI', 'Test') RETURNING id
    `;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id, title: "Authority checks" });
    try {
      for (const condition of ["paused", "revoked", "stale", "unconfirmed", "expired", "policy", "sponsor"] as const) {
        const task = (await aiChatTasks.create({
          userId: user!.id,
          chatId: conversation.shortId,
          prompt: condition,
          schedule: { kind: "cron", cron: "0 9 * * *" },
          timezone: "UTC",
        }))!;
        const occurrence = (await aiChatTasks.createOccurrence({
          taskId: task.id,
          scheduledFor: new Date().toISOString(),
          trigger: "manual",
          requestKey: `${suffix}:${condition}`,
        }))!;
        if (condition === "paused" || condition === "revoked") {
          await sql`UPDATE auth.mandates SET state = ${condition}, revision = revision + 1,
            revoked_at = CASE WHEN ${condition} = 'revoked' THEN now() ELSE NULL END,
            revoke_reason = CASE WHEN ${condition} = 'revoked' THEN 'Test revocation' ELSE NULL END WHERE id = ${task.mandateId}::uuid`;
        } else if (condition === "stale") {
          await sql`UPDATE auth.mandates SET revision = revision + 1 WHERE id = ${task.mandateId}::uuid`;
        } else if (condition === "unconfirmed") {
          await sql`UPDATE auth.mandates SET confirmed_at = NULL, confirmation_deadline = now() + interval '15 minutes' WHERE id = ${task.mandateId}::uuid`;
        } else if (condition === "expired") {
          await sql`UPDATE auth.mandates SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = ${task.mandateId}::uuid`;
        } else if (condition === "policy") {
          await sql`UPDATE auth.mandates SET policy = '{"version":1,"apps":["mail"],"operations":["capability.query:mail.read"],"actions":"deny"}'::jsonb WHERE id = ${task.mandateId}::uuid`;
        } else {
          await sql`UPDATE auth.users SET account_expires = now() - interval '1 hour' WHERE id = ${user!.id}::uuid`;
        }
        if (condition === "stale") {
          expect(
            await aiChatTasks.createOccurrence({
              taskId: task.id,
              scheduledFor: new Date().toISOString(),
              trigger: "manual",
              requestKey: `${suffix}:stale:admission`,
            }),
          ).toBeNull();
        } else if (condition === "expired") {
          expect(await aiChatTasks.getQueuedOccurrence(occurrence.id)).toBeNull();
        } else if (condition === "sponsor") {
          expect(await aiChatTasks.listActiveCron()).toEqual([]);
        }
        const delivery = await aiChatTasks.deliverOccurrence({
          occurrenceId: occurrence.id,
          modelProfileId: "test",
          runConfig: { kind: "chat", input: condition, toolSource: { kind: "none" } },
          userMessage: { role: "user", content: [{ type: "text", text: condition }] },
          expectedRevision: task.revision,
        });
        expect(delivery.delivered).toBe(false);
        expect(await aiChatTasks.getQueuedOccurrence(occurrence.id)).toBeNull();
        expect(
          await aiChatTasks.createOccurrence({
            taskId: task.id,
            scheduledFor: new Date().toISOString(),
            trigger: "manual",
            requestKey: `${suffix}:${condition}:second`,
          }),
        ).toBeNull();
        const stopped = await aiChatTasks.get({ userId: user!.id, taskId: task.shortId });
        expect(stopped?.state).toBe(condition === "paused" || condition === "sponsor" ? "paused" : "needs_attention");
        expect(stopped?.reasonCode).toBe(condition === "paused" ? "paused" : condition === "sponsor" ? "owner_inactive" : "rights_changed");
        expect(stopped?.reasonAt).not.toBeNull();
        if (condition === "sponsor") {
          expect((await mandates.get(task.mandateId!))?.state).toBe("paused");
          expect((await mandates.get(task.mandateId!))!.revision).toBe(stopped!.mandateRevision!);
          expect((await aiChatTasks.listOccurrences({ userId: user!.id, taskId: task.shortId }))?.[0]).toMatchObject({
            state: "queued",
            resultText: null,
          });
        }
        expect(
          (await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM ai.turns WHERE conversation_id = ${conversation.id}::uuid`)[0]
            ?.count,
        ).toBe(0);
        if (condition === "paused") {
          // Convergence must retain a revision usable only by an explicit interactive resume.
          expect(stopped?.mandateRevision).toBe(task.mandateRevision! + 1);
          expect((await aiChatTasks.setState({ userId: user!.id, taskId: task.shortId, state: "active" }))?.state).toBe("active");
          await sql`UPDATE auth.mandates SET state = 'paused', revision = revision + 1 WHERE id = ${task.mandateId}::uuid`;
          expect((await aiChatTasks.update({ userId: user!.id, taskId: task.shortId, prompt: "Edited safely" }))?.state).toBe("paused");
          expect((await mandates.get(task.mandateId!))?.state).toBe("paused");
        }
        await sql`UPDATE auth.users SET account_expires = NULL WHERE id = ${user!.id}::uuid`;
      }
      expect(await aiChatTasks.listActiveCron()).toEqual([]);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("approval refusal survives a completed model turn, keeps the first action, and clears on resume", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, display_name)
      VALUES (${`approval-refusal-${suffix}`}, 'local', 'user', 'Routine owner') RETURNING id`;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id });
    const action = "Aufgabe zuweisen";
    const sentence = `Wollte ${action}. Das macht der Assistant nur mit dir, und Routinen fragen nie.`;
    try {
      for (const status of ["completed", "failed"] as const) {
        const runAt = "2099-04-07T09:00:00.000Z";
        const task = (await aiChatTasks.create({
          userId: user!.id,
          chatId: conversation.shortId,
          title: "Aufgaben prüfen",
          locale: "de",
          prompt: "Check tasks",
          schedule: { kind: "once", runAt },
          timezone: "UTC",
        }))!;
        const occurrence = (await aiChatTasks.createOccurrence({
          taskId: task.id,
          scheduledFor: runAt,
          trigger: "scheduled",
          requestKey: `${suffix}:${status}`,
        }))!;
        const delivered = await aiChatTasks.deliverOccurrence({
          occurrenceId: occurrence.id,
          modelProfileId: "test",
          runConfig: { kind: "chat", input: task.prompt, toolSource: { kind: "none" } },
          userMessage: { role: "user", content: [{ type: "text", text: task.prompt }] },
          expectedRevision: task.revision,
        });
        if (!delivered.delivered) throw new Error("Expected routine delivery");
        await aiChatTasks.markNeedsApproval({ turnId: delivered.turnId, action });
        await aiChatTasks.markNeedsApproval({ turnId: delivered.turnId, action: "Second action" });
        await sql`INSERT INTO ai.task_messages(short_id, conversation_id, seq, kind, role, message, loop_id)
          VALUES (${createAiShortId()}, ${conversation.id}::uuid, 2, 'message', 'assistant',
            ${JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Dafür brauche ich deine Bestätigung." }] })}::text::jsonb,
            ${delivered.turnId})`;
        expect(await aiChatTasks.finalizeTurn({ turnId: delivered.turnId, status })).toEqual({ occurrenceId: occurrence.id, failed: true });
        expect(await aiChatTasks.finalizeTurn({ turnId: delivered.turnId, status })).toBeNull();
        const stopped = (await aiChatTasks.get({ userId: user!.id, taskId: task.shortId }))!;
        expect(stopped).toMatchObject({
          state: "needs_attention",
          reasonCode: "needs_approval",
          reasonAction: action,
          reasonAt: expect.any(String),
          lastError: expect.stringContaining(action),
        });
        const reason = toAiChatTaskView(stopped).reason!;
        expect(reason).toEqual({ code: "needs_approval", at: stopped.reasonAt!, action });
        expect(chatTaskReasonSentence(reason, { locale: "de", timeZone: "UTC" })).toBe(sentence);
        const [stored] = await sql`SELECT state, error, result_text FROM ai.chat_task_occurrences WHERE id = ${occurrence.id}::uuid`;
        expect(stored).toMatchObject({
          state: "failed",
          error: expect.stringContaining(action),
          result_text: "Dafür brauche ich deine Bestätigung.",
        });
        const [mandate] = await sql`SELECT state FROM auth.mandates WHERE id = ${task.mandateId}::uuid`;
        expect(mandate!.state).toBe("paused");
        const messages = await aiConversations.listMessages({ conversationId: conversation.id });
        expect(
          messages.find((message) => message.meta?.scheduledTask?.occurrenceId === occurrence.shortId)?.meta?.scheduledTask?.reason,
        ).toEqual(reason);
        expect(
          await aiChatTasks.update({
            userId: user!.id,
            taskId: task.shortId,
            schedule: { kind: "once", runAt: "2099-04-08T09:00:00.000Z" },
          }),
        ).toMatchObject({ state: "active", reasonCode: null, reasonAction: null });
        // A second failure must keep the new column clear. The new time is a new slot; the refused slot stays used.
        const next = (await aiChatTasks.createOccurrence({
          taskId: task.id,
          scheduledFor: "2099-04-08T09:00:00.000Z",
          trigger: "manual",
          requestKey: `${suffix}:${status}:next`,
        }))!;
        await aiChatTasks.failOccurrence({ occurrenceId: next.id, code: "failed", error: "Later failure" });
        expect(await aiChatTasks.get({ userId: user!.id, taskId: task.shortId })).toMatchObject({
          reasonCode: "failed",
          reasonAction: null,
        });
      }
      // Marker writes do not change interactive turns; stored titles stay bounded.
      const [interactive] = await sql`INSERT INTO ai.turns(short_id, conversation_id, status, run_config)
        VALUES (${createAiShortId()}, ${conversation.id}::uuid, 'running', '{"kind":"chat"}'::jsonb) RETURNING id`;
      await aiChatTasks.markNeedsApproval({ turnId: interactive!.id, action });
      const [plain] = await sql`SELECT run_config FROM ai.turns WHERE id = ${interactive!.id}::uuid`;
      expect(plain!.run_config).toEqual({ kind: "chat" });
      const [background] = await sql`INSERT INTO ai.turns(short_id, conversation_id, status, run_config)
        VALUES (${createAiShortId()}, ${conversation.id}::uuid, 'running', '{"kind":"chat","background":{}}'::jsonb) RETURNING id`;
      await aiChatTasks.markNeedsApproval({ turnId: background!.id, action: "A".repeat(300) });
      const [bounded] =
        await sql`SELECT run_config #>> '{background,needsApproval,action}' AS action FROM ai.turns WHERE id = ${background!.id}::uuid`;
      expect(bounded!.action).toBe("A".repeat(200));
      // An older Core changes the reason without knowing reason_action: the write succeeds, and the stale action never shows.
      const [older] = await sql<{ short_id: string }[]>`UPDATE ai.chat_tasks SET state = 'needs_attention', reason_code = 'failed',
        reason_at = now(), reason_action = ${action} WHERE conversation_id = ${conversation.id}::uuid RETURNING short_id`;
      const stale = (await aiChatTasks.get({ userId: user!.id, taskId: older!.short_id }))!;
      expect(stale).toMatchObject({ reasonCode: "failed", reasonAction: null });
      expect(toAiChatTaskView(stale).reason).toEqual({ code: "failed", at: stale.reasonAt! });
      // A Bun SQL query is lazy: execute() starts it so `rejects` sees the CHECK failure.
      await expect(
        sql`UPDATE ai.chat_tasks SET reason_action = ${"A".repeat(201)} WHERE short_id = ${older!.short_id}`.execute(),
      ).rejects.toThrow("ai_chat_tasks_reason_action_length_check");
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("a stale or explicitly stopped routine keeps its existing finalization despite an approval marker", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, display_name)
      VALUES (${`approval-precedence-${suffix}`}, 'local', 'user', 'Routine owner') RETURNING id`;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id });
    try {
      for (const condition of ["stale", "routine_paused", "routine_deleted"] as const) {
        const runAt = "2099-04-07T09:00:00.000Z";
        const task = (await aiChatTasks.create({
          userId: user!.id,
          chatId: conversation.shortId,
          prompt: condition,
          schedule: { kind: "once", runAt },
          timezone: "UTC",
        }))!;
        const occurrence = (await aiChatTasks.createOccurrence({
          taskId: task.id,
          scheduledFor: runAt,
          trigger: "scheduled",
          requestKey: `${suffix}:${condition}`,
        }))!;
        const delivered = await aiChatTasks.deliverOccurrence({
          occurrenceId: occurrence.id,
          modelProfileId: "test",
          runConfig: { kind: "chat", input: condition, toolSource: { kind: "none" } },
          userMessage: { role: "user", content: [{ type: "text", text: condition }] },
          expectedRevision: task.revision,
        });
        if (!delivered.delivered) throw new Error("Expected routine delivery");
        await aiChatTasks.markNeedsApproval({ turnId: delivered.turnId, action: "Create task" });
        if (condition === "stale") await sql`UPDATE ai.chat_tasks SET revision = revision + 1 WHERE id = ${task.id}::uuid`;
        else await sql`UPDATE ai.turns SET cancellation_reason = ${condition} WHERE id = ${delivered.turnId}::uuid`;
        expect(await aiChatTasks.finalizeTurn({ turnId: delivered.turnId, status: "completed" })).toEqual({
          occurrenceId: occurrence.id,
          failed: false,
        });
        const [row] = await sql`SELECT state, error FROM ai.chat_task_occurrences WHERE id = ${occurrence.id}::uuid`;
        expect(row).toEqual({ state: condition === "stale" ? "completed" : "stopped", error: null });
        expect((await aiChatTasks.get({ userId: user!.id, taskId: task.shortId }))!.reasonCode).not.toBe("needs_approval");
      }
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("finalizes terminal occurrences without creating or reviving execution authority", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${`ai-terminal-${suffix}`}, 'local', 'user', 'Terminal', ${`${suffix}@example.test`}, 'AI', 'Test') RETURNING id
    `;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id, title: "Terminal checks" });
    try {
      for (const condition of ["legacy", "revoked", "stale", "narrowed", "malformed"] as const) {
        const runAt = new Date(Date.now() + 60_000).toISOString();
        const task = (await aiChatTasks.create({
          userId: user!.id,
          chatId: conversation.shortId,
          prompt: condition,
          schedule: { kind: "once", runAt },
          timezone: "UTC",
        }))!;
        const occurrence = (await aiChatTasks.createOccurrence({
          taskId: task.id,
          scheduledFor: runAt,
          trigger: "scheduled",
          requestKey: `${suffix}:${condition}`,
        }))!;
        const delivered = await aiChatTasks.deliverOccurrence({
          occurrenceId: occurrence.id,
          modelProfileId: "test",
          runConfig: { kind: "chat", input: condition, toolSource: { kind: "none" } },
          userMessage: { role: "user", content: [{ type: "text", text: condition }] },
          expectedRevision: task.revision,
        });
        if (!delivered.delivered) throw new Error("Expected initial authorized delivery");
        const status = condition === "revoked" || condition === "malformed" ? "failed" : "completed";
        await sql`UPDATE ai.turns SET status = ${status}, completed_at = now() WHERE id = ${delivered.turnId}::uuid`;
        if (condition === "legacy") {
          await sql`UPDATE ai.chat_tasks SET mandate_id = NULL, mandate_revision = NULL WHERE id = ${task.id}::uuid`;
          await sql`UPDATE auth.users SET account_expires = now() - interval '1 hour' WHERE id = ${user!.id}::uuid`;
        } else if (condition === "revoked") {
          await sql`UPDATE auth.mandates SET state = 'revoked', revoked_at = now(), revoke_reason = 'Test revocation', revision = revision + 1 WHERE id = ${task.mandateId}::uuid`;
        } else if (condition === "stale") {
          await sql`UPDATE auth.mandates SET revision = revision + 1 WHERE id = ${task.mandateId}::uuid`;
        } else if (condition === "narrowed") {
          await sql`UPDATE auth.mandates SET policy = '{"version":1,"apps":["mail"],"operations":["capability.query:mail.read"],"actions":"deny"}'::jsonb WHERE id = ${task.mandateId}::uuid`;
        } else {
          await sql`UPDATE auth.mandates SET policy = '{"version":1}'::jsonb WHERE id = ${task.mandateId}::uuid`;
        }
        expect(await aiChatTasks.finalizeTurn({ turnId: delivered.turnId, status })).toEqual({
          occurrenceId: occurrence.id,
          failed: status === "failed",
        });
        expect(await aiChatTasks.finalizeTurn({ turnId: delivered.turnId, status })).toBeNull();
        const finished = await aiChatTasks.get({ userId: user!.id, taskId: task.shortId });
        expect(finished?.state).toBe(status === "completed" ? "completed" : "needs_attention");
        expect(finished?.reasonCode).toBe(status === "completed" ? null : "failed");
        if (status === "completed") expect(finished?.reasonAt).toBeNull();
        const [liveMandate] = await sql<{ state: string }[]>`SELECT state FROM auth.mandates WHERE id = ${task.mandateId}::uuid`;
        expect(liveMandate?.state).toBe(
          condition === "stale" || condition === "narrowed" ? "paused" : condition === "revoked" ? "revoked" : "active",
        );
        if (condition === "legacy") expect(finished?.mandateId).toBeNull();
        expect(
          (await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM auth.mandates WHERE workload_id = ${task.id}`)[0]?.count,
        ).toBe(1);
        await sql`UPDATE auth.users SET account_expires = NULL WHERE id = ${user!.id}::uuid`;
      }
      expect(await aiChatTasks.listTerminalRunningTurns()).toEqual([]);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("never regenerates missing task authority and allows the owner to remove the task", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name)
      VALUES (${"ai-hardcut-" + suffix}, 'local', 'user', 'Hard cut') RETURNING id
    `;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id, title: "Missing mandate" });
    try {
      const [task] = await sql<{ id: string; short_id: string }[]>`
        INSERT INTO ai.chat_tasks (short_id, conversation_id, sponsor_user_id, prompt, schedule_kind, cron, timezone)
        VALUES (${createAiShortId()}, ${conversation.id}::uuid, ${user!.id}::uuid, 'Old task', 'cron', '0 9 * * *', 'UTC')
        RETURNING id, short_id
      `;
      await expect(aiChatTasks.update({ userId: user!.id, taskId: task!.short_id, prompt: "Changed while active" })).rejects.toThrow(
        "recreate the task",
      );
      expect(
        await aiChatTasks.createOccurrence({
          taskId: task!.id,
          scheduledFor: new Date().toISOString(),
          trigger: "manual",
          requestKey: suffix,
        }),
      ).toBeNull();
      const stopped = await aiChatTasks.get({ userId: user!.id, taskId: task!.short_id });
      expect(stopped?.state).toBe("needs_attention");
      expect(stopped?.mandateId).toBeNull();
      await expect(aiChatTasks.setState({ userId: user!.id, taskId: task!.short_id, state: "active" })).rejects.toThrow(
        "recreate the task",
      );
      await expect(aiChatTasks.update({ userId: user!.id, taskId: task!.short_id, prompt: "Changed" })).rejects.toThrow(
        "recreate the task",
      );
      const [count] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM auth.mandates WHERE workload_id = ${task!.id}`;
      expect(count?.count).toBe(0);
      expect(await aiChatTasks.delete({ userId: crypto.randomUUID(), taskId: task!.short_id })).toBe(false);
      expect(await aiChatTasks.delete({ userId: user!.id, taskId: task!.short_id })).toBe(true);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("runs in its chat and is removed with the chat", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${`ai-task-${suffix}`}, 'local', 'user', 'AI Task Test', ${`ai-task-${suffix}@example.test`}, 'AI', 'Task')
      RETURNING id
    `;
    const conversation = await aiConversations.createConversation({
      ownerUserId: user!.id,
      title: "Scheduled work",
    });

    try {
      const runAt = new Date(Date.now() + 60_000).toISOString();
      const task = await aiChatTasks.create({
        userId: user!.id,
        chatId: conversation.shortId,
        prompt: "Check the release status.",
        schedule: { kind: "once", runAt },
        timezone: "Europe/Berlin",
        idempotencyKey: `test:${suffix}`,
      });
      expect(task?.shortId).toMatch(AI_SHORT_ID_PATTERN);
      expect(task?.chatId).toBe(conversation.shortId);
      expect(
        await sql<
          Array<{ owner_app_id: string; workload_type: string; workload_id: string; state: string; policy: unknown }>
        >`SELECT owner_app_id, workload_type, workload_id, state, policy FROM auth.mandates WHERE id = ${task!.mandateId}::uuid`,
      ).toEqual([
        {
          owner_app_id: "core",
          workload_type: "ai.chat-task",
          workload_id: task!.id,
          state: "active",
          policy: { version: 1, apps: [], operations: [], actions: "deny", grants: [] },
        },
      ]);
      expect((await aiChatTasks.list({ userId: user!.id })).map((entry) => entry.shortId)).toEqual([task!.shortId]);

      const manualAt = new Date().toISOString();
      const manual = await aiChatTasks.createOccurrence({
        taskId: task!.id,
        scheduledFor: manualAt,
        trigger: "manual",
        requestKey: `manual:${task!.id}:${suffix}`,
      });
      expect(manual?.shortId).toMatch(AI_SHORT_ID_PATTERN);
      expect((await aiChatTasks.setState({ userId: user!.id, taskId: task!.shortId, state: "paused" }))?.state).toBe("paused");
      expect((await sql<{ state: string }[]>`SELECT state FROM auth.mandates WHERE id = ${task!.mandateId}::uuid`)[0]?.state).toBe(
        "paused",
      );
      expect((await aiChatTasks.listQueuedOccurrences()).some((entry) => entry.occurrence.id === manual!.id)).toBe(false);
      expect((await aiChatTasks.setState({ userId: user!.id, taskId: task!.shortId, state: "active" }))?.state).toBe("active");
      expect((await sql<{ state: string }[]>`SELECT state FROM auth.mandates WHERE id = ${task!.mandateId}::uuid`)[0]?.state).toBe(
        "active",
      );
      expect((await aiChatTasks.listQueuedOccurrences()).find((entry) => entry.occurrence.id === manual!.id)?.task.shortId).toBe(
        task!.shortId,
      );
      const [blockingTurn] = await sql<{ id: string }[]>`
        INSERT INTO ai.turns (short_id, conversation_id, status)
        VALUES (${createAiShortId()}, ${conversation.id}::uuid, 'queued')
        RETURNING id
      `;
      const manualDelivery = await aiChatTasks.deliverOccurrence({
        occurrenceId: manual!.id,
        modelProfileId: "test-model",
        runConfig: { kind: "chat", input: task!.prompt, toolSource: { kind: "none" } },
        userMessage: { role: "user", content: [{ type: "text", text: task!.prompt }] },
        expectedRevision: (await aiChatTasks.get({ userId: user!.id, taskId: task!.shortId }))!.revision,
      });
      expect(manualDelivery.delivered).toBe(true);
      if (!manualDelivery.delivered) throw new Error("Expected manual task occurrence to be delivered");
      expect((await aiConversations.getActiveTurn({ conversationId: conversation.id }))?.turn.id).toBe(blockingTurn!.id);
      await sql`UPDATE ai.turns SET status = 'aborted', completed_at = now() WHERE id = ${blockingTurn!.id}::uuid`;
      await sql`UPDATE ai.turns SET status = 'completed', completed_at = now() WHERE id = ${manualDelivery.turnId}::uuid`;
      await aiChatTasks.finalizeTurn({ turnId: manualDelivery.turnId, status: "completed" });
      expect((await aiChatTasks.get({ userId: user!.id, taskId: task!.shortId }))?.state).toBe("active");

      await sql`UPDATE ai.chat_tasks SET run_at = now() - interval '1 minute' WHERE id = ${task!.id}::uuid`;
      const occurrence = (await aiChatTasks.materializeDueOnce()).find((entry) => entry.taskId === task!.id);
      expect(occurrence?.id).toBeDefined();
      expect((await aiChatTasks.materializeDueOnce()).find((entry) => entry.taskId === task!.id)?.id).toBe(occurrence!.id);
      const delivered = await aiChatTasks.deliverOccurrence({
        occurrenceId: occurrence!.id,
        modelProfileId: "test-model",
        runConfig: { kind: "chat", input: task!.prompt, toolSource: { kind: "none" } },
        userMessage: { role: "user", content: [{ type: "text", text: task!.prompt }] },
        expectedRevision: (await aiChatTasks.get({ userId: user!.id, taskId: task!.shortId }))!.revision,
      });
      if (!delivered.delivered) throw new Error("Expected scheduled task occurrence to be delivered");
      const [scheduledMessage] = await sql<{ meta: unknown }[]>`
        SELECT meta FROM ai.task_messages WHERE loop_id = ${delivered.turnId} AND role = 'user'
      `;
      expect(scheduledMessage?.meta).toEqual({
        scheduledTask: {
          taskId: task!.shortId,
          occurrenceId: occurrence!.shortId,
          scheduledFor: occurrence!.scheduledFor,
          trigger: "scheduled",
        },
      });
      expect(await aiChatTasks.finalizeTurn({ turnId: delivered.turnId, status: "completed" })).toEqual({
        occurrenceId: occurrence!.id,
        failed: false,
      });
      expect((await aiChatTasks.get({ userId: user!.id, taskId: task!.shortId }))?.state).toBe("completed");
      expect((await sql<{ state: string }[]>`SELECT state FROM auth.mandates WHERE id = ${task!.mandateId}::uuid`)[0]?.state).toBe(
        "paused",
      );

      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      const [counts] = await sql<{ tasks: number; occurrences: number }[]>`
        SELECT
          (SELECT count(*)::int FROM ai.chat_tasks WHERE id = ${task!.id}::uuid) AS tasks,
          (SELECT count(*)::int FROM ai.chat_task_occurrences WHERE id IN (${manual!.id}::uuid, ${occurrence!.id}::uuid)) AS occurrences
      `;
      expect(counts).toEqual({ tasks: 0, occurrences: 0 });
      expect((await sql<{ state: string }[]>`SELECT state FROM auth.mandates WHERE id = ${task!.mandateId}::uuid`)[0]?.state).toBe(
        "revoked",
      );
      const cascadeAudit = await sql<{ action: string; outcome: string; reason: string | null; metadata: unknown }[]>`
        SELECT action, outcome, reason, metadata
        FROM audit.events
        WHERE target_type = 'mandate' AND target_id = ${task!.mandateId}
          AND metadata->>'provenance' = 'ai.chat-task-cascade'
      `;
      expect(cascadeAudit).toEqual([
        {
          action: "mandate.revoke",
          outcome: "allowed",
          reason: "Scheduled chat task deleted",
          metadata: {
            ownerAppId: "core",
            workloadType: "ai.chat-task",
            workloadId: task!.id,
            provenance: "ai.chat-task-cascade",
          },
        },
      ]);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("snapshots completed context, skips overlapping ticks and delivers a result exactly once", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users(uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${`bg-isolation-${suffix}`}, 'local', 'user', 'Background test', ${`${suffix}@example.test`}, 'AI', 'Test') RETURNING id
    `;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id, title: "Independent background run" });
    try {
      const task = (await aiChatTasks.create({
        userId: user!.id,
        chatId: conversation.shortId,
        prompt: "Summarize",
        grants: [
          { kind: "http", fixedInput: { origin: "https://example.com", method: "GET" } },
          { kind: "database", fixedInput: { resourceId: "AbC234", operation: "rows.insert", table: "invoices" } },
        ],
        schedule: { kind: "cron", cron: "0 9 * * *" },
        timezone: "UTC",
      }))!;
      await sql`INSERT INTO ai.messages(short_id,conversation_id,seq,kind,role,message)
        VALUES (${createAiShortId()},${conversation.id}::uuid,1,'message','user',${JSON.stringify({ role: "user", content: [{ type: "text", text: "Completed context" }] })}::text::jsonb)`;
      const [interactive] = await sql<{ id: string }[]>`INSERT INTO ai.turns(short_id,conversation_id,status)
        VALUES (${createAiShortId()},${conversation.id}::uuid,'running') RETURNING id`;
      await sql`INSERT INTO ai.messages(short_id,conversation_id,seq,kind,role,message,loop_id)
        VALUES (${createAiShortId()},${conversation.id}::uuid,2,'message','user',${JSON.stringify({ role: "user", content: [{ type: "text", text: "Still processing" }] })}::text::jsonb,${interactive!.id})`;
      const occurrence = (await aiChatTasks.createOccurrence({
        taskId: task.id,
        scheduledFor: new Date().toISOString(),
        trigger: "manual",
        requestKey: `isolated:${suffix}`,
      }))!;
      const delivered = await aiChatTasks.deliverOccurrence({
        occurrenceId: occurrence.id,
        modelProfileId: "test",
        runConfig: { kind: "chat", input: task.prompt, toolSource: { kind: "none" } },
        userMessage: { role: "user", content: [{ type: "text", text: task.prompt }] },
        expectedRevision: task.revision,
      });
      if (!delivered.delivered) throw new Error("Background run must start alongside interactive turn");
      const config = await aiConversations.getTurnRunConfig({ conversationId: conversation.id, turnId: delivered.turnId });
      expect(config?.kind === "chat" && config.background?.context).toHaveLength(1);
      await sql`UPDATE ai.turns SET status='running' WHERE id=${delivered.turnId}::uuid`;
      if (config?.kind !== "chat" || !config.mandate) throw new Error("Missing scheduled authority");
      expect((await authorizeCodeExecution(conversation.id, delivered.turnId, user!.id)).config).toEqual(config);
      await aiChatTasks.authorizeRuntime({
        mandate: config.mandate,
        kind: "http",
        input: { origin: "https://example.com", method: "GET" },
      });
      await expect(
        aiChatTasks.authorizeRuntime({ mandate: config.mandate, kind: "http", input: { origin: "https://other.example", method: "GET" } }),
      ).rejects.toThrow("access denied");
      await aiChatTasks.authorizeRuntime({
        mandate: config.mandate,
        kind: "database",
        input: { resourceId: "AbC234", operation: "rows.insert", table: "invoices" },
      });
      await expect(
        aiChatTasks.authorizeRuntime({
          mandate: config.mandate,
          kind: "database",
          input: { resourceId: "AbC234", operation: "rows.delete", table: "invoices" },
        }),
      ).rejects.toThrow("access denied");

      expect(
        await aiChatTasks.createOccurrence({
          taskId: task.id,
          scheduledFor: new Date().toISOString(),
          trigger: "scheduled",
          requestKey: `tick:${suffix}`,
        }),
      ).toBeNull();
      expect(
        (
          await aiChatTasks.createOccurrence({
            taskId: task.id,
            scheduledFor: occurrence.scheduledFor,
            trigger: "manual",
            requestKey: `isolated:${suffix}`,
          })
        )?.id,
      ).toBe(occurrence.id);
      await sql`INSERT INTO ai.task_messages(short_id,conversation_id,seq,kind,role,message,loop_id)
        VALUES (${createAiShortId()},${conversation.id}::uuid,2,'message','assistant',${JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Your summary is ready." }] })}::text::jsonb,${delivered.turnId})`;
      await sql`UPDATE ai.conversations SET done = true, last_viewed_at = now() - interval '1 day', last_used_at = now() - interval '1 day' WHERE id = ${conversation.id}::uuid`;
      await sql`UPDATE ai.turns SET status='completed',completed_at=now() WHERE id=${delivered.turnId}::uuid`;
      await expect(authorizeCodeExecution(conversation.id, delivered.turnId, user!.id)).rejects.toThrow("no longer authorized");
      expect(await aiChatTasks.finalizeTurn({ turnId: delivered.turnId, status: "completed" })).toEqual({
        occurrenceId: occurrence.id,
        failed: false,
      });
      expect(await aiChatTasks.finalizeTurn({ turnId: delivered.turnId, status: "completed" })).toBeNull();
      const messages = await sql<
        { role: string; loop_id: string | null; message: unknown }[]
      >`SELECT role,loop_id,message FROM ai.messages WHERE conversation_id=${conversation.id}::uuid ORDER BY seq`;
      expect(messages).toHaveLength(3);
      expect(messages[2]).toEqual({
        role: "assistant",
        loop_id: null,
        message: { role: "assistant", content: [{ type: "text", text: "Your summary is ready." }] },
      });
      const updated = await aiConversations.getConversation({ conversationId: conversation.id, ownerUserId: user!.id });
      expect(updated?.done).toBeNull();
      expect(updated?.unreadCompletion).toBe(true);
      expect(updated?.hasActiveSchedule).toBe(true);
      expect((await aiConversations.getActiveTurn({ conversationId: conversation.id }))?.turn.id).toBe(interactive!.id);
      const activities = (await aiChatTasks.listActivities({ userId: user!.id })).items;
      expect(activities[0]?.occurrence.resultText).toBe("Your summary is ready.");
      expect(activities[0]?.unread).toBe(true);
      expect(
        await aiChatTasks.getOccurrenceDetail({ userId: user!.id, taskId: task.shortId, occurrenceId: occurrence.shortId }),
      ).not.toBeNull();
      expect(
        await aiChatTasks.getOccurrenceDetail({ userId: crypto.randomUUID(), taskId: task.shortId, occurrenceId: occurrence.shortId }),
      ).toBeNull();
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id=${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${user!.id}::uuid`;
    }
  });

  test("delivers startup failures to the chat once and preserves repairable task state", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name,mail,given_name,sn)
      VALUES (${`bg-failure-${suffix}`},'local','user','BG failure',${`${suffix}@example.test`},'AI','Test') RETURNING id`;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id, title: "Startup failure" });
    try {
      const task = (await aiChatTasks.create({
        userId: user!.id,
        chatId: conversation.shortId,
        prompt: "Read my notes",
        schedule: { kind: "cron", cron: "0 9 * * *" },
        timezone: "UTC",
      }))!;
      const occurrence = (await aiChatTasks.createOccurrence({
        taskId: task.id,
        scheduledFor: new Date().toISOString(),
        trigger: "manual",
        requestKey: suffix,
      }))!;
      expect(
        await aiChatTasks.failOccurrence({
          code: "failed",
          occurrenceId: occurrence.id,
          error: "Project access is missing. Update this task in the chat.",
        }),
      ).toBe("failed");
      expect(await aiChatTasks.failOccurrence({ code: "failed", occurrenceId: occurrence.id, error: "duplicate" })).toBe("gone");
      expect((await aiChatTasks.get({ userId: user!.id, taskId: task.shortId }))?.state).toBe("needs_attention");
      expect((await aiChatTasks.listOccurrences({ userId: user!.id, taskId: task.shortId }))?.[0]?.resultText).toBe("The last run failed.");
      expect(
        (await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM ai.messages WHERE conversation_id=${conversation.id}::uuid`)[0]
          ?.count,
      ).toBe(1);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id=${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${user!.id}::uuid`;
    }
  });

  test("keeps retries, lifecycle changes, and terminal recovery consistent", async () => {
    const suffix = crypto.randomUUID();
    const users = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
      VALUES
        (${`ai-task-owner-${suffix}`}, 'local', 'user', 'AI Task Owner', ${`ai-task-owner-${suffix}@example.test`}, 'AI', 'Owner'),
        (${`ai-task-peer-${suffix}`}, 'local', 'user', 'AI Task Peer', ${`ai-task-peer-${suffix}@example.test`}, 'AI', 'Peer')
      RETURNING id
    `;
    const owner = users[0]!;
    const peer = users[1]!;
    const conversation = await aiConversations.createConversation({
      ownerUserId: owner.id,
      title: "Task recovery",
    });
    const peerConversation = await aiConversations.createConversation({
      ownerUserId: peer.id,
      title: "Peer tasks",
    });

    try {
      const createInput = {
        userId: owner.id,
        chatId: conversation.shortId,
        prompt: "Check recovery.",
        schedule: { kind: "cron" as const, cron: "0 9 * * 1" },
        timezone: "Europe/Berlin",
        idempotencyKey: `shared-${suffix}`,
      };
      const task = await aiChatTasks.create(createInput);
      expect((await aiChatTasks.create(createInput))?.id).toBe(task!.id);
      await expect(aiChatTasks.create({ ...createInput, prompt: "Different input" })).rejects.toBeInstanceOf(
        AiChatTaskIdempotencyConflictError,
      );
      expect(
        await aiChatTasks.create({ ...createInput, userId: peer.id, chatId: peerConversation.shortId, prompt: "Peer input" }),
      ).not.toBeNull();

      await aiChatTasks.setState({ userId: owner.id, taskId: task!.shortId, state: "paused" });
      expect(
        (
          await aiChatTasks.update({
            userId: owner.id,
            taskId: task!.shortId,
            prompt: "Updated while paused.",
          })
        )?.state,
      ).toBe("paused");
      await aiChatTasks.setState({ userId: owner.id, taskId: task!.shortId, state: "active" });
      const activeRevision = (await aiChatTasks.get({ userId: owner.id, taskId: task!.shortId }))!.revision;
      expect((await aiChatTasks.setState({ userId: owner.id, taskId: task!.shortId, state: "active" }))?.revision).toBe(activeRevision);

      const stale = await aiChatTasks.createOccurrence({
        taskId: task!.id,
        scheduledFor: new Date().toISOString(),
        trigger: "manual",
        requestKey: `manual:stale:${suffix}`,
      });
      await aiChatTasks.update({
        userId: owner.id,
        taskId: task!.shortId,
        schedule: { kind: "cron", cron: "0 9 * * 1" },
        timezone: "Europe/Berlin",
      });
      expect((await aiChatTasks.listOccurrences({ userId: owner.id, taskId: task!.shortId }))?.[0]?.state).toBe("queued");
      await aiChatTasks.getQueuedOccurrence(stale!.id);
      await aiChatTasks.update({ userId: owner.id, taskId: task!.shortId, prompt: "Updated before preflight failed." });
      expect(await aiChatTasks.failOccurrence({ code: "failed", occurrenceId: stale!.id, error: "Stale preflight" })).toBe("stale");
      expect((await aiChatTasks.listOccurrences({ userId: owner.id, taskId: task!.shortId }))?.[0]?.state).toBe("queued");
      const rebound = await aiChatTasks.getQueuedOccurrence(stale!.id);
      const staleDelivery = await aiChatTasks.deliverOccurrence({
        occurrenceId: stale!.id,
        modelProfileId: "test-model",
        runConfig: { kind: "chat", input: rebound!.task.prompt, toolSource: { kind: "none" } },
        userMessage: { role: "user", content: [{ type: "text", text: rebound!.task.prompt }] },
        expectedRevision: rebound!.task.revision,
      });
      if (!staleDelivery.delivered) throw new Error("Expected stale occurrence delivery");
      await aiChatTasks.update({ userId: owner.id, taskId: task!.shortId, prompt: "Newer task prompt." });
      await sql`
        UPDATE ai.turns SET status = 'failed', error = 'Old run failed', completed_at = now()
        WHERE id = ${staleDelivery.turnId}::uuid
      `;
      await aiChatTasks.finalizeTurn({ turnId: staleDelivery.turnId, status: "failed" });
      expect((await aiChatTasks.get({ userId: owner.id, taskId: task!.shortId }))?.state).toBe("active");

      const failed = await aiChatTasks.createOccurrence({
        taskId: task!.id,
        scheduledFor: new Date(Date.now() + 1).toISOString(),
        trigger: "manual",
        requestKey: `manual:failed:${suffix}`,
      });
      const failedDelivery = await aiChatTasks.deliverOccurrence({
        occurrenceId: failed!.id,
        modelProfileId: "test-model",
        runConfig: { kind: "chat", input: "Fail", toolSource: { kind: "none" } },
        userMessage: { role: "user", content: [{ type: "text", text: "Fail" }] },
        expectedRevision: (await aiChatTasks.get({ userId: owner.id, taskId: task!.shortId }))!.revision,
      });
      if (!failedDelivery.delivered) throw new Error("Expected failed occurrence delivery");
      await sql`
        UPDATE ai.turns SET status = 'failed', error = 'Model unavailable', completed_at = now()
        WHERE id = ${failedDelivery.turnId}::uuid
      `;
      expect(await aiChatTasks.listTerminalRunningTurns()).toContainEqual({
        turnId: failedDelivery.turnId,
        status: "failed",
      });
      await aiChatTasks.finalizeTurn({ turnId: failedDelivery.turnId, status: "failed" });
      const detail = await aiChatTasks.listOccurrences({ userId: owner.id, taskId: task!.shortId });
      expect(detail?.find((entry) => entry.id === failed!.id)?.error).toBe("Model unavailable");
      expect((await aiChatTasks.get({ userId: owner.id, taskId: task!.shortId }))?.state).toBe("needs_attention");
      expect((await aiChatTasks.setState({ userId: owner.id, taskId: task!.shortId, state: "active" }))?.state).toBe("active");

      await sql`UPDATE ai.chat_tasks SET state = 'completed' WHERE id = ${task!.id}::uuid`;
      expect((await aiChatTasks.update({ userId: owner.id, taskId: task!.shortId, prompt: "Still complete." }))?.state).toBe("completed");
      expect(
        (
          await aiChatTasks.update({
            userId: owner.id,
            taskId: task!.shortId,
            schedule: { kind: "once", runAt: new Date(Date.now() + 60_000).toISOString() },
            timezone: "Europe/Berlin",
          })
        )?.state,
      ).toBe("active");
      await sql`UPDATE ai.chat_tasks SET state = 'needs_attention', reason_code = 'failed', reason_at = now() WHERE id = ${task!.id}::uuid`;
      expect(await aiChatTasks.setState({ userId: owner.id, taskId: task!.shortId, state: "active" })).toBeNull();
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id IN (${conversation.id}::uuid, ${peerConversation.id}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id IN (${owner.id}::uuid, ${peer.id}::uuid)`;
    }
  });
  test("archive pauses routines, restore resumes only archive reasons, and admission remains a backstop", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, display_name)
      VALUES (${`routine-archive-${suffix}`}, 'local', 'user', 'Routine owner') RETURNING id`;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id, title: "Invoices" });
    const create = () =>
      aiChatTasks.create({
        userId: user!.id,
        chatId: conversation.shortId,
        prompt: "Save invoices",
        schedule: { kind: "cron", cron: "0 9 * * *" },
        timezone: "UTC",
        locale: "de",
      });
    try {
      const task = (await create())!;
      const manual = (await create())!;
      await aiChatTasks.setState({ userId: user!.id, taskId: manual.shortId, state: "paused" });
      expect(await aiConversations.archiveConversation({ conversationId: conversation.id, ownerUserId: user!.id })).toBe(true);
      // The AI routes run this after the store archived the chat; the route test covers that wiring.
      await aiChatTasks.pauseForArchivedChat({ conversationId: conversation.id, userId: user!.id });
      expect(await aiChatTasks.get({ userId: user!.id, taskId: task.shortId })).toMatchObject({
        state: "paused",
        reasonCode: "chat_archived",
      });
      expect((await mandates.get(task.mandateId!))?.state).toBe("paused");
      expect(await aiConversations.restoreConversation({ conversationId: conversation.id, ownerUserId: user!.id })).not.toBeNull();
      await aiChatTasks.resumeForRestoredChat({ conversationId: conversation.id, userId: user!.id, resume: true });
      expect(await aiChatTasks.get({ userId: user!.id, taskId: task.shortId })).toMatchObject({
        state: "active",
        reasonCode: null,
        reasonAt: null,
      });
      expect(await aiChatTasks.get({ userId: user!.id, taskId: manual.shortId })).toMatchObject({ state: "paused", reasonCode: "paused" });
      // An archive follow-up that arrives after the chat was restored again leaves its routines running.
      await aiChatTasks.pauseForArchivedChat({ conversationId: conversation.id, userId: user!.id });
      expect(await aiChatTasks.get({ userId: user!.id, taskId: task.shortId })).toMatchObject({ state: "active", reasonCode: null });
      // Simulate an archive whose follow-up failed. Admission narrows authority without creating a failed run or message.
      await sql`UPDATE ai.conversations SET archived_at = now() WHERE id = ${conversation.id}::uuid`;
      expect(
        await aiChatTasks.createOccurrence({
          taskId: task.id,
          scheduledFor: "2026-04-07T09:00:00.000Z",
          trigger: "manual",
          requestKey: suffix,
        }),
      ).toBeNull();
      expect(await aiChatTasks.get({ userId: user!.id, taskId: task.shortId })).toMatchObject({
        state: "paused",
        reasonCode: "chat_archived",
      });
      expect(await sql`SELECT id FROM ai.chat_task_occurrences WHERE task_id = ${task.id}::uuid`).toHaveLength(0);
      expect(await aiConversations.listMessages({ conversationId: conversation.id })).toHaveLength(0);
      await mandates.revoke({
        mandateId: task.mandateId!,
        expectedRevision: (await mandates.get(task.mandateId!))!.revision,
        authority: { kind: "interactive", userId: user!.id },
        reason: "Test revocation",
      });
      await aiConversations.restoreConversation({ conversationId: conversation.id, ownerUserId: user!.id });
      await aiChatTasks.resumeForRestoredChat({ conversationId: conversation.id, userId: user!.id, resume: true });
      expect(await aiChatTasks.get({ userId: user!.id, taskId: task.shortId })).toMatchObject({
        state: "needs_attention",
        reasonCode: "rights_changed",
      });
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("restore relabels archive pauses when a one-time run passed or automatic resume is disabled", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, display_name)
      VALUES (${`routine-restore-paused-${suffix}`}, 'local', 'user', 'Routine owner') RETURNING id`;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id });
    try {
      const [time] = await sql<{ run_at: Date }[]>`SELECT now() + interval '1 day' AS run_at`;
      const once = (await aiChatTasks.create({
        userId: user!.id,
        chatId: conversation.shortId,
        prompt: "Send the summary",
        schedule: { kind: "once", runAt: time!.run_at.toISOString() },
        timezone: "UTC",
      }))!;
      const cron = (await aiChatTasks.create({
        userId: user!.id,
        chatId: conversation.shortId,
        prompt: "Save invoices",
        schedule: { kind: "cron", cron: "0 9 * * *" },
        timezone: "UTC",
      }))!;
      await aiConversations.archiveConversation({ conversationId: conversation.id, ownerUserId: user!.id });
      await aiChatTasks.pauseForArchivedChat({ conversationId: conversation.id, userId: user!.id });
      const archived = (await aiChatTasks.get({ userId: user!.id, taskId: once.shortId }))!;
      expect(archived.reasonCode).toBe("chat_archived");
      await sql`UPDATE ai.chat_tasks SET run_at = now() - interval '1 day' WHERE id = ${once.id}::uuid`;
      await aiConversations.restoreConversation({ conversationId: conversation.id, ownerUserId: user!.id });
      await aiChatTasks.resumeForRestoredChat({ conversationId: conversation.id, userId: user!.id, resume: true });
      expect(await aiChatTasks.get({ userId: user!.id, taskId: once.shortId })).toMatchObject({
        state: "paused",
        reasonCode: "paused",
        reasonAt: archived.reasonAt,
        lastError: archived.lastError,
      });
      expect((await mandates.get(once.mandateId!))?.state).toBe("paused");
      expect((await aiChatTasks.get({ userId: user!.id, taskId: cron.shortId }))?.state).toBe("active");
      await aiConversations.archiveConversation({ conversationId: conversation.id, ownerUserId: user!.id });
      await aiChatTasks.pauseForArchivedChat({ conversationId: conversation.id, userId: user!.id });
      const pausedMandate = await mandates.get(cron.mandateId!);
      expect(pausedMandate?.state).toBe("paused");
      await aiConversations.restoreConversation({ conversationId: conversation.id, ownerUserId: user!.id });
      await aiChatTasks.resumeForRestoredChat({ conversationId: conversation.id, userId: user!.id, resume: false });
      expect(await aiChatTasks.get({ userId: user!.id, taskId: cron.shortId })).toMatchObject({ state: "paused", reasonCode: "paused" });
      expect(await mandates.get(cron.mandateId!)).toEqual(pausedMandate);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("recovery relabels archive pauses a failed restore step left behind, never inside the grace", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, display_name)
      VALUES (${`routine-restore-backstop-${suffix}`}, 'local', 'user', 'Routine owner') RETURNING id`;
    const restoredChat = await aiConversations.createConversation({ ownerUserId: user!.id });
    const archivedChat = await aiConversations.createConversation({ ownerUserId: user!.id });
    const create = (chatId: string) =>
      aiChatTasks.create({
        userId: user!.id,
        chatId,
        prompt: "Save invoices",
        schedule: { kind: "cron", cron: "0 9 * * *" },
        timezone: "UTC",
      });
    try {
      const restored = (await create(restoredChat.shortId))!;
      const archived = (await create(archivedChat.shortId))!;
      const manual = (await create(restoredChat.shortId))!;
      await aiChatTasks.setState({ userId: user!.id, taskId: manual.shortId, state: "paused" });
      for (const chat of [restoredChat, archivedChat]) {
        await aiConversations.archiveConversation({ conversationId: chat.id, ownerUserId: user!.id });
        await aiChatTasks.pauseForArchivedChat({ conversationId: chat.id, userId: user!.id });
      }
      await sql`UPDATE ai.chat_tasks SET updated_at = now() - interval '10 minutes'
        WHERE id IN (${restored.id}::uuid, ${archived.id}::uuid, ${manual.id}::uuid)`;
      await aiChatTasks.markRestoreStarted({ conversationId: restoredChat.id, userId: crypto.randomUUID() });
      const [unmarked] = await sql<{ untouched: boolean }[]>`SELECT updated_at < now() - interval '5 minutes' AS untouched
        FROM ai.chat_tasks WHERE id = ${restored.id}::uuid`;
      expect(unmarked!.untouched).toBe(true);
      // The restore marks its routines before it restores the chat; its routine step then fails and never runs.
      await aiChatTasks.markRestoreStarted({ conversationId: restoredChat.id, userId: user!.id });
      const [marked] = await sql<{ fresh: boolean }[]>`SELECT updated_at > now() - interval '1 minute' AS fresh
        FROM ai.chat_tasks WHERE id = ${restored.id}::uuid`;
      expect(marked!.fresh).toBe(true);
      const untouched = await sql<{ untouched: boolean }[]>`SELECT updated_at < now() - interval '5 minutes' AS untouched
        FROM ai.chat_tasks WHERE id IN (${manual.id}::uuid, ${archived.id}::uuid)`;
      expect(untouched).toHaveLength(2);
      expect(untouched.every((task) => task.untouched)).toBe(true);
      await aiConversations.restoreConversation({ conversationId: restoredChat.id, ownerUserId: user!.id });
      await aiChatTasks.relabelRestoredArchivePauses();
      expect((await aiChatTasks.get({ userId: user!.id, taskId: restored.shortId }))?.reasonCode).toBe("chat_archived");
      await sql`UPDATE ai.chat_tasks SET updated_at = now() - interval '10 minutes' WHERE id IN (${restored.id}::uuid, ${archived.id}::uuid)`;
      const pausedMandate = await mandates.get(restored.mandateId!);
      expect(pausedMandate?.state).toBe("paused");
      const paused = (await aiChatTasks.get({ userId: user!.id, taskId: restored.shortId }))!;
      // Other suites' rows may share the database, so the count is not exact.
      expect(await aiChatTasks.relabelRestoredArchivePauses()).toBeGreaterThanOrEqual(1);
      expect(await aiChatTasks.get({ userId: user!.id, taskId: restored.shortId })).toMatchObject({
        state: "paused",
        reasonCode: "paused",
        reasonAt: paused.reasonAt,
        lastError: paused.lastError,
      });
      expect(await mandates.get(restored.mandateId!)).toEqual(pausedMandate);
      expect(await aiChatTasks.get({ userId: user!.id, taskId: archived.shortId })).toMatchObject({
        state: "paused",
        reasonCode: "chat_archived",
      });
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id IN (${restoredChat.id}::uuid, ${archivedChat.id}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("archive and restore never undo a stop or accept changed authority", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, display_name)
      VALUES (${`routine-archive-authority-${suffix}`}, 'local', 'user', 'Routine owner') RETURNING id`;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id, title: "Invoices" });
    const create = (prompt: string) =>
      aiChatTasks.create({
        userId: user!.id,
        chatId: conversation.shortId,
        prompt,
        schedule: { kind: "cron", cron: "0 9 * * *" },
        timezone: "UTC",
      });
    try {
      // Paused through its mandate before reconciliation saw it: archiving must not relabel it as an archive pause.
      const stopped = (await create("Stopped elsewhere"))!;
      await sql`UPDATE auth.mandates SET state = 'paused', revision = revision + 1 WHERE id = ${stopped.mandateId}::uuid`;
      const changed = (await create("Changed while archived"))!;
      expect(await aiConversations.archiveConversation({ conversationId: conversation.id, ownerUserId: user!.id })).toBe(true);
      // The AI routes run this after the store archived the chat; the route test covers that wiring.
      await aiChatTasks.pauseForArchivedChat({ conversationId: conversation.id, userId: user!.id });
      expect(await aiChatTasks.get({ userId: user!.id, taskId: stopped.shortId })).toMatchObject({ state: "paused", reasonCode: "paused" });
      expect(await aiChatTasks.get({ userId: user!.id, taskId: changed.shortId })).toMatchObject({
        state: "paused",
        reasonCode: "chat_archived",
      });
      // What the routine may do changes while the chat is archived.
      await sql`UPDATE auth.mandates SET revision = revision + 1 WHERE id = ${changed.mandateId}::uuid`;
      expect(await aiConversations.restoreConversation({ conversationId: conversation.id, ownerUserId: user!.id })).not.toBeNull();
      await aiChatTasks.resumeForRestoredChat({ conversationId: conversation.id, userId: user!.id, resume: true });
      expect(await aiChatTasks.get({ userId: user!.id, taskId: stopped.shortId })).toMatchObject({ state: "paused", reasonCode: "paused" });
      expect((await mandates.get(stopped.mandateId!))?.state).toBe("paused");
      expect(await aiChatTasks.get({ userId: user!.id, taskId: changed.shortId })).toMatchObject({
        state: "needs_attention",
        reasonCode: "rights_changed",
      });
      expect((await mandates.get(changed.mandateId!))?.state).toBe("paused");
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("a one-time routine stopped at its time asks for a new time instead of resuming into nothing", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, display_name)
      VALUES (${`routine-once-stop-${suffix}`}, 'local', 'user', 'Routine owner') RETURNING id`;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id });
    try {
      const task = (await aiChatTasks.create({
        userId: user!.id,
        chatId: conversation.shortId,
        prompt: "Send the summary",
        schedule: { kind: "once", runAt: "2099-04-07T09:00:00.000Z" },
        timezone: "UTC",
      }))!;
      // Its time comes and its run starts; then the person pauses it.
      await sql`UPDATE ai.chat_tasks SET run_at = '2001-04-07T09:00:00Z'::timestamptz WHERE id = ${task.id}::uuid`;
      await aiChatTasks.materializeDueOnce();
      expect(await sql`SELECT id FROM ai.chat_task_occurrences WHERE task_id = ${task.id}::uuid`).toHaveLength(1);
      const paused = await aiChatTasks.setState({ userId: user!.id, taskId: task.shortId, state: "paused" });
      expect(paused).toMatchObject({ state: "paused", reasonCode: "paused" });
      // A repeated pause, such as a retry after a lost answer, keeps when the pause began.
      await sql`UPDATE ai.chat_tasks SET reason_at = '2001-04-07T09:30:00Z'::timestamptz WHERE id = ${task.id}::uuid`;
      expect(await aiChatTasks.setState({ userId: user!.id, taskId: task.shortId, state: "paused" })).toMatchObject({
        reasonCode: "paused",
        reasonAt: "2001-04-07T09:30:00.000Z",
      });
      expect(await aiChatTasks.setState({ userId: user!.id, taskId: task.shortId, state: "active" })).toBeNull();
      expect(await aiChatTasks.get({ userId: user!.id, taskId: task.shortId })).toMatchObject({ state: "paused" });
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("a paused run whose routine is deleted before its line went out still gets its line once", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, display_name)
      VALUES (${`routine-paused-orphan-${suffix}`}, 'local', 'user', 'Routine owner') RETURNING id`;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id });
    try {
      const task = (await aiChatTasks.create({
        userId: user!.id,
        chatId: conversation.shortId,
        prompt: "Save invoices",
        locale: "en",
        schedule: { kind: "cron", cron: "0 9 * * *" },
        timezone: "UTC",
      }))!;
      const occurrence = (await aiChatTasks.createOccurrence({
        taskId: task.id,
        scheduledFor: "2026-04-07T09:00:00Z",
        trigger: "manual",
        requestKey: suffix,
      }))!;
      const turn = await aiChatTasks.deliverOccurrence({
        occurrenceId: occurrence.id,
        modelProfileId: "test",
        runConfig: { kind: "chat", input: task.prompt, toolSource: { kind: "none" } },
        userMessage: { role: "user", content: [{ type: "text", text: task.prompt }] },
        expectedRevision: task.revision,
      });
      if (!turn.delivered) throw new Error("Expected run admission");
      await sql`UPDATE ai.turns SET status = 'running', lease_owner = 'crashing-worker', lease_expires_at = now() + interval '1 hour'
        WHERE id = ${turn.turnId}::uuid`;
      await aiChatTasks.setState({ userId: user!.id, taskId: task.shortId, state: "paused" });
      // The worker ends the turn and crashes before it finalizes the run; then the routine is deleted.
      await aiConversations.completeTurn({
        conversationId: conversation.id,
        turnId: turn.turnId,
        leaseOwner: "crashing-worker",
        status: "aborted",
        error: null,
      });
      expect(await aiChatTasks.delete({ userId: user!.id, taskId: task.shortId })).toBe(true);
      expect(await aiChatTasks.listTerminalRunningTurns()).toContainEqual({ turnId: turn.turnId, status: "aborted" });
      await aiChatTasks.finalizeTurn({ turnId: turn.turnId, status: "aborted" });
      await aiChatTasks.finalizeTurn({ turnId: turn.turnId, status: "aborted" });
      const messages = await aiConversations.listMessages({ conversationId: conversation.id });
      expect(messages).toHaveLength(1);
      expect(messages[0]?.meta?.scheduledTask?.stop).toEqual({ cause: "paused", done: [] });
      expect(await aiChatTasks.listTerminalRunningTurns()).not.toContainEqual({ turnId: turn.turnId, status: "aborted" });
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  for (const cause of ["paused", "deleted"] as const)
    test(`${cause} aborts a running turn and recovers one factual stop line`, async () => {
      const suffix = crypto.randomUUID();
      const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, display_name)
      VALUES (${`routine-stop-${suffix}`}, 'local', 'user', 'Routine owner') RETURNING id`;
      const conversation = await aiConversations.createConversation({ ownerUserId: user!.id, title: "Invoices" });
      try {
        const task = (await aiChatTasks.create({
          userId: user!.id,
          chatId: conversation.shortId,
          title: "Neue Rechnungen",
          locale: "de",
          prompt: "Save invoices",
          schedule: { kind: "cron", cron: "0 9 * * *" },
          timezone: "Europe/Berlin",
        }))!;
        const occurrence = (await aiChatTasks.createOccurrence({
          taskId: task.id,
          scheduledFor: "2026-04-07T09:00:00.000Z",
          trigger: "manual",
          requestKey: suffix,
        }))!;
        const delivered = await aiChatTasks.deliverOccurrence({
          occurrenceId: occurrence.id,
          modelProfileId: "test",
          runConfig: { kind: "chat", input: task.prompt, locale: "de", toolSource: { kind: "none" } },
          userMessage: { role: "user", content: [{ type: "text", text: task.prompt }] },
          expectedRevision: task.revision,
        });
        if (!delivered.delivered) throw new Error("Expected run admission");
        await sql`UPDATE ai.turns SET status = 'running', lease_owner = 'routine-test', lease_expires_at = now() + interval '1 hour'
        WHERE id = ${delivered.turnId}::uuid`;
        const presentation = {
          kind: "capability",
          appId: "invoices",
          appName: "Invoices",
          appIcon: "ti ti-file",
          title: "Save invoice",
          capabilityKind: "action",
          sentences: { done: "Rechnung {input.number} gespeichert" },
        };
        const messages = [
          {
            role: "assistant",
            content: [
              { type: "text", text: "MODEL CLAIM: I deleted all invoices" },
              { type: "tool_call", id: "write", name: "save", args: { number: "42" } },
              { type: "tool_call", id: "read", name: "read", args: {} },
              { type: "tool_call", id: "web-read", name: "web_extract", args: { url: "https://example.test" } },
              { type: "tool_call", id: "file-write", name: "write_file", args: { path: "invoices.csv" } },
              { type: "tool_call", id: "untitled", name: "update_draft", args: { draftId: "d1" } },
              { type: "tool_call", id: "failed", name: "save", args: { number: "43" } },
              { type: "tool_call", id: "rejected", name: "save", args: { number: "44" } },
              { type: "tool_call", id: "not-run", name: "save", args: { number: "45" } },
            ],
          },
          { role: "tool_result", callId: "write", name: "save", result: { ok: true, data: {} } },
          { role: "tool_result", callId: "read", name: "read", result: { ok: true, data: {} } },
          { role: "tool_result", callId: "web-read", name: "web_extract", result: { content: "Read only" } },
          { role: "tool_result", callId: "file-write", name: "write_file", result: { path: "invoices.csv" } },
          { role: "tool_result", callId: "untitled", name: "update_draft", result: { ok: true, data: {} } },
          { role: "tool_result", callId: "failed", name: "save", isError: true, result: { ok: false } },
          { role: "tool_result", callId: "rejected", name: "save", result: { ok: false } },
        ];
        for (const [i, message] of messages.entries())
          await sql`
        INSERT INTO ai.task_messages(short_id, conversation_id, seq, kind, role, message, loop_id, meta)
        VALUES (${createAiShortId()}, ${conversation.id}::uuid, ${i + 2}, 'message', ${message.role}, ${JSON.stringify(message)}::text::jsonb,
          ${delivered.turnId}, ${JSON.stringify({ toolPresentations: { write: presentation, untitled: { ...presentation, title: "Entwurf aktualisieren", sentences: undefined }, read: { ...presentation, capabilityKind: "query" }, failed: presentation, rejected: presentation, "not-run": presentation } })}::text::jsonb)`;
        if (cause === "paused") await aiChatTasks.setState({ userId: user!.id, taskId: task.shortId, state: "paused" });
        else expect(await aiChatTasks.delete({ userId: user!.id, taskId: task.shortId })).toBe(true);
        const [turn] = await sql<{ cancel_requested_at: Date | null; cancellation_reason: string }[]>`
        SELECT cancel_requested_at, cancellation_reason FROM ai.turns WHERE id = ${delivered.turnId}::uuid`;
        expect(turn?.cancel_requested_at).not.toBeNull();
        expect(turn?.cancellation_reason).toBe(`routine_${cause}`);
        expect(
          await aiConversations.completeTurn({
            conversationId: conversation.id,
            turnId: delivered.turnId,
            leaseOwner: "routine-test",
            status: "aborted",
            error: null,
          }),
        ).toBe("completed");
        expect(await aiChatTasks.listTerminalRunningTurns()).toContainEqual({ turnId: delivered.turnId, status: "aborted" });
        await aiChatTasks.finalizeTurn({ turnId: delivered.turnId, status: "aborted" });
        await aiChatTasks.finalizeTurn({ turnId: delivered.turnId, status: "aborted" });
        expect(await aiChatTasks.listTerminalRunningTurns()).not.toContainEqual({ turnId: delivered.turnId, status: "aborted" });
        const lines = await aiConversations.listMessages({ conversationId: conversation.id });
        expect(lines).toHaveLength(1);
        // An Action without a done sentence still counts; its title names it.
        expect(lines[0]?.meta?.scheduledTask?.stop).toEqual({
          cause,
          done: ["Rechnung 42 gespeichert", "invoices.csv geschrieben", "Entwurf aktualisieren"],
        });
        expect(JSON.stringify(lines[0]?.message)).toContain(
          "Schon erledigt: Rechnung 42 gespeichert; invoices.csv geschrieben; Entwurf aktualisieren. Nichts wurde rückgängig gemacht.",
        );
        expect(JSON.stringify(lines[0]?.message)).not.toContain("MODEL CLAIM");
        if (cause === "paused") {
          const [stoppedRun] = (await aiChatTasks.listOccurrences({ userId: user!.id, taskId: task.shortId })) ?? [];
          expect(stoppedRun?.state).toBe("stopped");
          // The routine's own result shows the same line as the chat.
          expect(stoppedRun?.resultText).toContain("Angehalten, während die Routine lief.");
          expect(await aiChatTasks.get({ userId: user!.id, taskId: task.shortId })).toMatchObject({
            state: "paused",
            reasonCode: "paused",
          });
          await aiChatTasks.setState({ userId: user!.id, taskId: task.shortId, state: "active" });
          expect(await aiChatTasks.get({ userId: user!.id, taskId: task.shortId })).toMatchObject({
            state: "active",
            reasonCode: null,
            reasonAt: null,
          });
        } else expect(await aiChatTasks.get({ userId: user!.id, taskId: task.shortId })).toBeNull();
      } finally {
        await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
        await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
      }
    });

  for (const cause of ["paused", "deleted"] as const)
    test(`${cause} finalizes an ownerless running routine immediately with an empty done list`, async () => {
      const suffix = crypto.randomUUID();
      const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, display_name)
        VALUES (${`routine-ownerless-${suffix}`}, 'local', 'user', 'Routine owner') RETURNING id`;
      const conversation = await aiConversations.createConversation({ ownerUserId: user!.id });
      try {
        const task = (await aiChatTasks.create({
          userId: user!.id,
          chatId: conversation.shortId,
          prompt: "Save invoices",
          locale: "en",
          schedule: { kind: "cron", cron: "0 9 * * *" },
          timezone: "UTC",
        }))!;
        const occurrence = (await aiChatTasks.createOccurrence({
          taskId: task.id,
          scheduledFor: "2026-04-07T09:00:00Z",
          trigger: "manual",
          requestKey: suffix,
        }))!;
        const turn = await aiChatTasks.deliverOccurrence({
          occurrenceId: occurrence.id,
          modelProfileId: "test",
          runConfig: { kind: "chat", input: task.prompt, toolSource: { kind: "none" } },
          userMessage: { role: "user", content: [{ type: "text", text: task.prompt }] },
          expectedRevision: task.revision,
        });
        if (!turn.delivered) throw new Error("Expected run admission");
        await sql`UPDATE ai.turns SET status = 'running' WHERE id = ${turn.turnId}::uuid`;
        if (cause === "paused") await aiChatTasks.setState({ userId: user!.id, taskId: task.shortId, state: "paused" });
        else await aiChatTasks.delete({ userId: user!.id, taskId: task.shortId });
        expect((await sql<{ status: string }[]>`SELECT status FROM ai.turns WHERE id = ${turn.turnId}::uuid`)[0]?.status).toBe("aborted");
        const messages = await aiConversations.listMessages({ conversationId: conversation.id });
        expect(messages).toHaveLength(1);
        expect(messages[0]?.meta?.scheduledTask?.stop).toEqual({ cause, done: [] });
        expect(JSON.stringify(messages[0]?.message)).toContain("Stopped while the routine was running. Nothing was undone.");
        await aiChatTasks.finalizeTurn({ turnId: turn.turnId, status: "aborted" });
        expect(await aiConversations.listMessages({ conversationId: conversation.id })).toHaveLength(1);
      } finally {
        await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
        await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
      }
    });

  test("renaming a routine that needs you changes only its name", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, display_name)
      VALUES (${`routine-rename-${suffix}`}, 'local', 'user', 'Routine owner') RETURNING id`;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id, title: "Invoices" });
    try {
      const task = (await aiChatTasks.create({
        userId: user!.id,
        chatId: conversation.shortId,
        prompt: "Record new invoices",
        schedule: { kind: "cron", cron: "0 9 * * *" },
        timezone: "UTC",
      }))!;
      // Without a title the routine is called after its chat.
      expect(task.name).toBe("Invoices");
      const occurrence = (await aiChatTasks.createOccurrence({
        taskId: task.id,
        scheduledFor: "2026-04-07T09:00:00Z",
        trigger: "manual",
        requestKey: suffix,
      }))!;
      expect(await aiChatTasks.failOccurrence({ occurrenceId: occurrence.id, error: "Delivery failed", code: "failed" })).toBe("failed");
      const failed = (await aiChatTasks.get({ userId: user!.id, taskId: task.shortId }))!;
      const renamed = await aiChatTasks.update({ userId: user!.id, taskId: task.shortId, title: "Neue Rechnungen eintragen" });
      expect(renamed).toMatchObject({
        name: "Neue Rechnungen eintragen",
        state: "needs_attention",
        reasonCode: "failed",
        reasonAt: failed.reasonAt,
        lastError: "Delivery failed",
        revision: failed.revision,
        mandateRevision: failed.mandateRevision,
      });
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("reason checks and one-time locale migration are idempotent", async () => {
    const { migrateChatTaskReasons } = await import("./chat-task-reasons-migrate");
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, display_name)
      VALUES (${`routine-migration-${suffix}`}, 'local', 'user', 'Routine owner') RETURNING id`;
    const conversation = await aiConversations.createConversation({ ownerUserId: user!.id, title: "Migration" });
    const emptyConversation = await aiConversations.createConversation({ ownerUserId: user!.id });
    try {
      const tasks: Awaited<ReturnType<typeof aiChatTasks.create>>[] = [];
      for (const prompt of ["paused", "changed", "failed", "fallback", "no_locale", "unavailable"])
        tasks.push(
          await aiChatTasks.create({
            userId: user!.id,
            chatId: prompt === "no_locale" ? emptyConversation.shortId : conversation.shortId,
            prompt,
            schedule: { kind: "cron", cron: "0 9 * * *" },
            timezone: "UTC",
          }),
        );
      // A lazy query runs only when awaited; `.execute()` starts it for the matcher.
      await expect(
        sql`UPDATE ai.chat_tasks SET state = 'needs_attention' WHERE id = ${tasks[0]!.id}::uuid`.execute(),
      ).rejects.toMatchObject({
        constraint: "ai_chat_tasks_reason_state_check",
      });
      const rollback = new Error("Rollback migration fixture");
      await expect(
        sql.begin(async (tx) => {
          await tx`ALTER TABLE ai.chat_tasks DROP CONSTRAINT ai_chat_tasks_reason_state_check`.simple();
          await tx`ALTER TABLE ai.chat_tasks DROP COLUMN locale`.simple();
          // An older Core changes state without clearing or replacing the stored reason.
          for (const state of ["active", "needs_attention", "paused"])
            await tx`INSERT INTO ai.chat_tasks
              (short_id, conversation_id, sponsor_user_id, prompt, schedule_kind, cron, timezone,
                state, reason_code, reason_at, created_at, updated_at)
              VALUES (${createAiShortId()}, ${conversation.id}::uuid, ${user!.id}::uuid,
                'Rollback fixture', 'cron', '0 9 * * *', 'UTC', ${state},
                ${state === "paused" ? "chat_archived" : "paused"}, '2000-01-03T00:00:00.000Z'::timestamptz,
                '2001-01-01T00:00:00.000Z'::timestamptz, '2001-01-02T00:00:00.000Z'::timestamptz)`;
          for (const [i, task] of tasks.entries())
            await tx`UPDATE ai.chat_tasks
          SET state = ${i === 0 ? "paused" : "needs_attention"}, reason_code = NULL, reason_at = NULL,
            last_error = ${i === 1 ? "Scheduled task mandate revision changed" : i === 5 ? "Scheduled task mandate or sponsor is unavailable" : "Raw technical error"},
            created_at = ${i === 3 ? "1999-01-01T00:00:00.000Z" : "2001-01-01T00:00:00.000Z"}::timestamptz,
            updated_at = '2001-01-02T00:00:00.000Z'::timestamptz WHERE id = ${task!.id}::uuid`;
          for (const [locale, createdAt, background] of [
            ["DE-ch", "2000-01-01T00:00:00.000Z", false],
            ["fr", "2002-01-01T00:00:00.000Z", false],
            ["es", "2000-12-31T00:00:00.000Z", true],
          ] as const)
            await tx`INSERT INTO ai.turns(short_id, conversation_id, status, created_at, run_config)
            VALUES (${createAiShortId()}, ${conversation.id}::uuid, 'completed', ${createdAt}::timestamptz,
              ${JSON.stringify({ kind: "chat", locale, ...(background ? { background: {} } : {}) })}::text::jsonb)`;
          await migrateChatTaskReasons(tx);
          expect(
            await tx<
              { state: string; reason_code: string | null; reason_at: Date | null }[]
            >`SELECT state, reason_code, reason_at FROM ai.chat_tasks
              WHERE conversation_id = ${conversation.id}::uuid AND prompt = 'Rollback fixture' ORDER BY state`,
          ).toEqual([
            { state: "active", reason_code: null, reason_at: null },
            { state: "needs_attention", reason_code: "failed", reason_at: new Date("2001-01-02T00:00:00.000Z") },
            { state: "paused", reason_code: "chat_archived", reason_at: new Date("2000-01-03T00:00:00.000Z") },
          ]);
          for (const [i, task] of tasks.entries()) {
            const [row] = await tx<
              { reason_code: string; reason_at: Date; locale: string | null }[]
            >`SELECT reason_code, reason_at, locale FROM ai.chat_tasks WHERE id = ${task!.id}::uuid`;
            expect(row).toEqual({
              reason_code: i === 0 ? "paused" : i === 1 || i === 5 ? "rights_changed" : "failed",
              reason_at: new Date("2001-01-02T00:00:00.000Z"),
              locale: i === 4 ? null : i === 3 ? "fr" : "de-CH",
            });
          }
          // Clearing locale after the first migration proves restart does not rescan the turns.
          await tx`UPDATE ai.chat_tasks SET locale = NULL WHERE id = ${tasks[0]!.id}::uuid`;
          const before = await tx`SELECT id, xmin::text, reason_code, reason_at, locale FROM ai.chat_tasks ORDER BY id`;
          await migrateChatTaskReasons(tx);
          expect(await tx`SELECT id, xmin::text, reason_code, reason_at, locale FROM ai.chat_tasks ORDER BY id`).toEqual(before);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      await migrateCloudAi();
      await migrateCloudAi();
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id IN (${conversation.id}::uuid, ${emptyConversation.id}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });
});
