import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { aiMemoryLearningRuns } from "./memory-learning-runs";
import { listAiPendingWorkflowPatterns, recordAiMemoryWorkflowEvidence } from "./memory-workflow-evidence";
import { aiMemories } from "./memories";
import { learnAiMemoriesFromPrivateChats, listAiMemoryLearningCandidates } from "./memory-learning";
import { migrateCloudAi } from "./migrate";
import { createAiShortId } from "./short-id";
import type { AiResolvedModel } from "./types";

const canUseAiDatabase = async () => {
  try {
    const [authRow] = await sql<{ users: string | null }[]>`SELECT to_regclass('auth.users')::text AS users`;
    if (!authRow?.users) return false;
    await migrateCloudAi();
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!(await canUseAiDatabase()))("AI memory learning (integration)", () => {
  test("stores bounded learned memories with conversation provenance", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${`ai-learning-${suffix}`}, 'local', 'user', 'AI Learning Test', ${`ai-learning-${suffix}@example.test`}, 'AI', 'Learning')
      RETURNING id
    `;
    const [conversation] = await sql<{ id: string }[]>`
      INSERT INTO ai.conversations (short_id, created_by_user_id, title)
      VALUES (${createAiShortId()}, ${user!.id}::uuid, 'Memory learning test')
      RETURNING id
    `;
    const [turn] = await sql<{ id: string; completed_as_of: string }[]>`
      INSERT INTO ai.turns (short_id, conversation_id, status, run_config, completed_at)
      VALUES (${createAiShortId()}, ${conversation!.id}::uuid, 'completed', ${JSON.stringify({ kind: "chat", input: [] })}::jsonb, now())
      RETURNING id, completed_at::text AS completed_as_of
    `;
    await sql`
      INSERT INTO ai.user_prefs (user_id, memory_learning_enabled)
      VALUES (${user!.id}::uuid, TRUE)
      ON CONFLICT (user_id) DO UPDATE SET memory_learning_enabled = TRUE
    `;
    await sql`
      INSERT INTO ai.messages (short_id, conversation_id, seq, role, message, loop_id)
      VALUES (
        ${createAiShortId()},
        ${conversation!.id}::uuid,
        1,
        'user',
        ${JSON.stringify({ role: "user", content: [{ type: "text", text: "I prefer concise answers in German." }] })}::jsonb,
        ${turn!.id}::uuid
      )
    `;

    try {
      const summary = await learnAiMemoriesFromPrivateChats({
        deps: {
          resolveModel: async () => ({ profile: { id: "test-model" } }) as AiResolvedModel,
          listCandidates: async () => [
            {
              conversationId: conversation!.id,
              turnId: turn!.id,
              userId: user!.id,
              completedAsOf: turn!.completed_as_of,
              failCount: 0,
            },
          ],
          listWorkflowPatterns: async () => [],
          structured: async () =>
            ({
              output: {
                changes: [
                  {
                    action: "add",
                    kind: "preference",
                    content: "Prefers concise answers in German.",
                    memoryIds: [],
                    resourceRef: null,
                  },
                  {
                    action: "add",
                    kind: "workflow",
                    content: "Uses a made-up mailbox for invoices.",
                    memoryIds: [],
                    resourceRef: { type: "mail.mailbox", id: "NotObserved" },
                  },
                ],
              },
              modelProfileId: "test-model",
              structuredMeta: { mode: "native" },
            }) as never,
        },
      });

      expect(summary).toEqual({ scanned: 1, learned: 1, updated: 0, retired: 0, skipped: 0, failed: 0 });
      const saved = await aiMemories.list({ userId: user!.id });
      expect(saved).toHaveLength(1);
      const [memory] = saved;
      expect(memory?.content).toBe("Prefers concise answers in German.");
      expect(memory?.source).toBe("background");
      expect(memory?.sourceConversationId).toBe(conversation!.id);
      expect((await aiMemories.resolveSourceConversationShortIds(user!.id, [conversation!.id])).get(conversation!.id)).toBeDefined();

      const activity = await aiMemoryLearningRuns.list({ userId: user!.id });
      expect(activity.total).toBe(1);
      expect(activity.runs[0]).toMatchObject({
        conversationTitle: "Memory learning test",
        status: "ok",
        addedCount: 1,
        updatedCount: 0,
        mergedCount: 0,
        retiredCount: 0,
        kind: "turn",
        changes: [{ action: "added", kind: "preference", content: "Prefers concise answers in German." }],
      });
      expect(activity.runs[0]?.conversationId).toBeDefined();

      await sql`UPDATE ai.conversations SET updated_at = now() + interval '1 second' WHERE id = ${conversation!.id}::uuid`;
      expect((await listAiMemoryLearningCandidates(100, 1000000)).some((candidate) => candidate.turnId === turn!.id)).toBe(false);

      const otherUser = await sql<{ id: string }[]>`
        INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
        VALUES (${`ai-learning-other-${suffix}`}, 'local', 'user', 'Other User', ${`ai-learning-other-${suffix}@example.test`}, 'Other', 'User')
        RETURNING id
      `;
      expect((await aiMemoryLearningRuns.list({ userId: otherUser[0]!.id })).runs).toEqual([]);
      await sql`DELETE FROM auth.users WHERE id = ${otherUser[0]!.id}::uuid`;
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("learns one resource workflow only after three successful matching turns", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${`ai-workflow-${suffix}`}, 'local', 'user', 'AI Workflow Test', ${`ai-workflow-${suffix}@example.test`}, 'AI', 'Workflow')
      RETURNING id
    `;
    await sql`
      INSERT INTO ai.user_prefs (user_id, memory_learning_enabled)
      VALUES (${user!.id}::uuid, TRUE)
      ON CONFLICT (user_id) DO UPDATE SET memory_learning_enabled = TRUE
    `;

    try {
      const turns: { conversationId: string; turnId: string }[] = [];
      for (const [index, request] of [
        "Find the latest invoice mail.",
        "Check whether an invoice arrived today.",
        "Look for the supplier invoice.",
      ].entries()) {
        const [conversation] = await sql<{ id: string }[]>`
          INSERT INTO ai.conversations (short_id, created_by_user_id, title)
          VALUES (${createAiShortId()}, ${user!.id}::uuid, ${`Invoice lookup ${index + 1}`})
          RETURNING id
        `;
        const [turn] = await sql<{ id: string }[]>`
          INSERT INTO ai.turns (short_id, conversation_id, status, run_config, completed_at)
          VALUES (${createAiShortId()}, ${conversation!.id}::uuid, 'completed', ${JSON.stringify({ kind: "chat", input: [] })}::jsonb, now())
          RETURNING id
        `;
        await sql`
          INSERT INTO ai.messages (short_id, conversation_id, seq, role, message, loop_id)
          VALUES
            (${createAiShortId()}, ${conversation!.id}::uuid, 1, 'user', ${JSON.stringify({ role: "user", content: [{ type: "text", text: request }] })}::jsonb, ${turn!.id}::uuid),
            (${createAiShortId()}, ${conversation!.id}::uuid, 2, 'assistant', ${JSON.stringify({ role: "assistant", content: [{ type: "text", text: "I checked Accounting." }] })}::jsonb, ${turn!.id}::uuid)
        `;
        turns.push({ conversationId: conversation!.id, turnId: turn!.id });
        await recordAiMemoryWorkflowEvidence({
          userId: user!.id,
          conversationId: conversation!.id,
          turnId: turn!.id,
          capabilityId: "mail.conversation.search",
          resources: [{ ref: { type: "mail.mailbox", id: "Box123" }, title: "Accounting" }],
        });
      }
      const pattern = (await listAiPendingWorkflowPatterns(100)).find(
        (item) => item.userId === user!.id && item.resourceRef.type === "mail.mailbox" && item.resourceRef.id === "Box123",
      );
      expect(pattern).toBeDefined();

      let modelCalls = 0;
      const deps = {
        resolveModel: async () => ({ profile: { id: "test-model" } }) as AiResolvedModel,
        listCandidates: async () => [],
        listWorkflowPatterns: async () => [pattern!],
        monthlyTokenBudget: 1_000_000,
        readMonthlyAccountedTokens: async () => 0,
        structured: async (request: { task: string }) => {
          modelCalls += 1;
          expect(request.task).toBe("memory-learn-workflow");
          return {
            output: { workflow: { content: "Use Accounting for invoice mail searches.", memoryIds: [] } },
            modelProfileId: "test-model",
            structuredMeta: { mode: "native" },
          } as never;
        },
      };
      const summary = await learnAiMemoriesFromPrivateChats({
        deps: {
          ...deps,
          structured: deps.structured as never,
        },
      });

      expect(summary).toEqual({ scanned: 0, learned: 1, updated: 0, retired: 0, skipped: 0, failed: 0 });
      const memories = await aiMemories.list({ userId: user!.id });
      expect(memories).toHaveLength(1);
      expect(memories[0]).toMatchObject({
        kind: "workflow",
        content: "Use Accounting for invoice mail searches.",
        source: "background",
        resourceRef: { type: "mail.mailbox", id: "Box123" },
      });
      const activity = await aiMemoryLearningRuns.list({ userId: user!.id });
      expect(activity.runs[0]).toMatchObject({
        kind: "workflow",
        changes: [{ action: "added", kind: "workflow", resourceRef: { type: "mail.mailbox", id: "Box123" } }],
      });
      expect(modelCalls).toBe(1);
      expect(await learnAiMemoriesFromPrivateChats({ deps: { ...deps, structured: deps.structured as never } })).toEqual({
        scanned: 0,
        learned: 0,
        updated: 0,
        retired: 0,
        skipped: 0,
        failed: 0,
      });
      expect(modelCalls).toBe(1);
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });

  test("does not call a model or consume a turn when its conservative reservation exceeds the monthly budget", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
      VALUES (${`ai-budget-${suffix}`}, 'local', 'user', 'AI Budget Test', ${`ai-budget-${suffix}@example.test`}, 'AI', 'Budget')
      RETURNING id
    `;
    const [conversation] = await sql<{ id: string }[]>`
      INSERT INTO ai.conversations (short_id, created_by_user_id, title)
      VALUES (${createAiShortId()}, ${user!.id}::uuid, 'Memory budget test') RETURNING id
    `;
    const [turn] = await sql<{ id: string; completed_as_of: string }[]>`
      INSERT INTO ai.turns (short_id, conversation_id, status, run_config, completed_at)
      VALUES (${createAiShortId()}, ${conversation!.id}::uuid, 'completed', ${JSON.stringify({ kind: "chat", input: [] })}::jsonb, now())
      RETURNING id, completed_at::text AS completed_as_of
    `;
    await sql`
      INSERT INTO ai.user_prefs (user_id, memory_learning_enabled) VALUES (${user!.id}::uuid, TRUE)
      ON CONFLICT (user_id) DO UPDATE SET memory_learning_enabled = TRUE
    `;
    await sql`
      INSERT INTO ai.messages (short_id, conversation_id, seq, role, message, loop_id)
      VALUES (${createAiShortId()}, ${conversation!.id}::uuid, 1, 'user',
        ${JSON.stringify({ role: "user", content: [{ type: "text", text: "Always answer briefly." }] })}::jsonb, ${turn!.id}::uuid)
    `;
    let modelCalls = 0;
    try {
      const summary = await learnAiMemoriesFromPrivateChats({
        deps: {
          resolveModel: async () => ({ profile: { id: "test-model" } }) as AiResolvedModel,
          listCandidates: async () => [{
            conversationId: conversation!.id,
            turnId: turn!.id,
            userId: user!.id,
            completedAsOf: turn!.completed_as_of,
            failCount: 0,
          }],
          listWorkflowPatterns: async () => [],
          monthlyTokenBudget: 1,
          readMonthlyAccountedTokens: async () => 0,
          structured: async () => {
            modelCalls += 1;
            throw new Error("must not run");
          },
        },
      });
      expect(summary).toEqual({ scanned: 1, learned: 0, updated: 0, retired: 0, skipped: 0, failed: 0 });
      expect(modelCalls).toBe(0);
      expect((await listAiMemoryLearningCandidates(100, 1_000_000)).some((candidate) => candidate.turnId === turn!.id)).toBe(true);
      expect((await aiMemoryLearningRuns.list({ userId: user!.id })).total).toBe(0);
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });
});
