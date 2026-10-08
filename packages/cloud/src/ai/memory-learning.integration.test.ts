import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import type { z } from "zod";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { aiMemories } from "./memories";
import { learnAiMemoriesFromPrivateChats, listAiMemoryLearningCandidates } from "./memory-learning";
import { aiMemoryLearningRuns } from "./memory-learning-runs";
import { listAiPendingWorkflowPatterns, listAiTurnWorkflowEvidence, recordAiMemoryWorkflowEvidence } from "./memory-workflow-evidence";
import { migrateCloudAi } from "./migrate";
import { aiUserPrefs } from "./prefs";
import { createAiShortId } from "./short-id";
import { aiConversations } from "./store";
import type { RunAiStructuredInput, RunAiStructuredResult } from "./structured";
import type { AiResolvedModel } from "./types";

const learningTestModel: AiResolvedModel = {
  profile: { id: "test-model", label: "Test", provider: "openai", model: "test", enabled: true, capabilities: [], dataBoundary: "private" },
  provider: {
    name: "test",
    family: "openai-compatible",
    model: "test",
    capabilities: { streaming: false, tools: false, images: false, thinking: false, usage: false },
    async complete() {
      throw new Error("Must use the structured fixture");
    },
    async *stream() {
      throw new Error("Must use the structured fixture");
    },
  },
};

const insertLearningUser = async (): Promise<string> => {
  const suffix = crypto.randomUUID();
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
    VALUES (${`ai-archive-${suffix}`}, 'local', 'user', 'Archive Learning', ${`ai-archive-${suffix}@example.test`}, 'Archive', 'Learning')
    RETURNING id
  `;
  return user!.id;
};

const insertLearningTurn = async (userId: string, existingConversationId?: string) => {
  let conversationId = existingConversationId;
  if (!conversationId) {
    const [conversation] = await sql<{ id: string }[]>`
      INSERT INTO ai.conversations (short_id, created_by_user_id, title)
      VALUES (${createAiShortId()}, ${userId}::uuid, 'Archive learning test') RETURNING id
    `;
    conversationId = conversation!.id;
  }
  const [turn] = await sql<{ id: string }[]>`
    INSERT INTO ai.turns (short_id, conversation_id, status, run_config)
    VALUES (${createAiShortId()}, ${conversationId}::uuid, 'running', ${JSON.stringify({ kind: "chat", input: [] })}::jsonb)
    RETURNING id
  `;
  const [seq] = await sql<{ next: number }[]>`
    SELECT COALESCE(max(seq), 0)::int + 1 AS next FROM ai.messages WHERE conversation_id = ${conversationId}::uuid
  `;
  await sql`
    INSERT INTO ai.messages (short_id, conversation_id, seq, role, message, loop_id)
    VALUES (${createAiShortId()}, ${conversationId}::uuid, ${seq!.next}, 'user',
      ${JSON.stringify({ role: "user", content: [{ type: "text", text: "Always use Accounting for invoice mail." }] })}::jsonb, ${turn!.id}::uuid)
  `;
  await recordAiMemoryWorkflowEvidence({
    userId,
    conversationId,
    turnId: turn!.id,
    capabilityId: "mail.conversation.search",
    resources: [{ ref: { type: "mail.mailbox", id: "BoxArchive" }, title: "Accounting" }],
  });
  expect(await aiConversations.completeTurn({ conversationId, turnId: turn!.id, status: "completed" })).toBe("completed");
  const [completed] = await sql<{ completed_as_of: string }[]>`
    SELECT completed_at::text AS completed_as_of FROM ai.turns WHERE id = ${turn!.id}::uuid
  `;
  return { userId, conversationId, turnId: turn!.id, completedAsOf: completed!.completed_as_of, failCount: 0, locale: "en" };
};

const proposeLearning =
  (duringModel: () => Promise<void> = async () => {}) =>
  async <TOutput extends z.ZodType>(request: RunAiStructuredInput<TOutput>): Promise<RunAiStructuredResult<TOutput>> => {
    await duringModel();
    return {
      output: request.output.parse(
        request.task === "memory-learn-workflow"
          ? { workflow: { content: "Use Accounting for invoice mail.", memoryIds: [] } }
          : { changes: [{ action: "add", kind: "preference", content: "Prefers concise answers.", memoryIds: [], resourceRef: null }] },
      ),
      modelProfileId: "test-model",
      structuredMeta: { mode: "native", repaired: false, attempts: 1, usedResponseFormat: true },
    };
  };

const learningDeps = () => ({
  resolveModel: async () => learningTestModel,
  listCandidates: async () => [],
  listWorkflowPatterns: async () => [],
  monthlyTokenBudget: 1_000_000,
  readMonthlyAccountedTokens: async () => 0,
  readAdditionalInstructions: async () => "",
  readDefaultLocale: async () => "en",
  structured: proposeLearning(),
});

databaseSuite()("AI memory learning (integration)", () => {
  beforeAll(async () => {
    await migrateCloudAi();
  });
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
        skipped: 1,
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
  test("considers people who never chose and skips an explicit off", async () => {
    const createUserWithTurn = async (label: string) => {
      const suffix = crypto.randomUUID();
      const [user] = await sql<{ id: string }[]>`
        INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
        VALUES (${`ai-default-${label}-${suffix}`}, 'local', 'user', 'AI Default Test', ${`ai-default-${label}-${suffix}@example.test`}, 'AI', 'Default')
        RETURNING id
      `;
      const [conversation] = await sql<{ id: string }[]>`
        INSERT INTO ai.conversations (short_id, created_by_user_id, title)
        VALUES (${createAiShortId()}, ${user!.id}::uuid, 'Default learning test') RETURNING id
      `;
      // Three successful uses of one mailbox make a workflow pattern; the first turn is the learning candidate.
      const turns: { id: string; completed_as_of: string }[] = [];
      for (let index = 0; index < 3; index += 1) {
        const [turn] = await sql<{ id: string; completed_as_of: string }[]>`
          INSERT INTO ai.turns (short_id, conversation_id, status, run_config, completed_at)
          VALUES (${createAiShortId()}, ${conversation!.id}::uuid, 'completed', ${JSON.stringify({ kind: "chat", input: [] })}::jsonb, now())
          RETURNING id, completed_at::text AS completed_as_of
        `;
        turns.push(turn!);
        await recordAiMemoryWorkflowEvidence({
          userId: user!.id,
          conversationId: conversation!.id,
          turnId: turn!.id,
          capabilityId: "mail.conversation.search",
          resources: [{ ref: { type: "mail.mailbox", id: "BoxDefault" } }],
        });
      }
      const turn = turns[0]!;
      await sql`
        INSERT INTO ai.messages (short_id, conversation_id, seq, role, message, loop_id)
        VALUES (${createAiShortId()}, ${conversation!.id}::uuid, 1, 'user',
          ${JSON.stringify({ role: "user", content: [{ type: "text", text: "Always answer briefly." }] })}::jsonb, ${turn.id}::uuid)
      `;
      return { userId: user!.id, conversationId: conversation!.id, turnId: turn.id, completedAsOf: turn.completed_as_of };
    };
    const noRow = await createUserWithTurn("none");
    const neverChose = await createUserWithTurn("null");
    const chose = await createUserWithTurn("off");
    await aiUserPrefs.update(neverChose.userId, { lastModelId: "test-model" });
    await aiUserPrefs.update(chose.userId, { memoryLearningEnabled: false });

    try {
      const candidates = (await listAiMemoryLearningCandidates(100, 1_000_000)).map((candidate) => candidate.turnId);
      expect(candidates).toContain(noRow.turnId);
      expect(candidates).toContain(neverChose.turnId);
      expect(candidates).not.toContain(chose.turnId);

      const patternUsers = (await listAiPendingWorkflowPatterns(20)).map((pattern) => pattern.userId);
      expect(patternUsers).toContain(noRow.userId);
      expect(patternUsers).toContain(neverChose.userId);
      expect(patternUsers).not.toContain(chose.userId);

      // The run reads the choice again right before the model call, so turning
      // learning off takes effect even for a candidate that was already listed.
      let modelCalls = 0;
      const summary = await learnAiMemoriesFromPrivateChats({
        deps: {
          resolveModel: async () => ({ profile: { id: "test-model" } }) as AiResolvedModel,
          listCandidates: async () => [{ ...chose, failCount: 0 }],
          listWorkflowPatterns: async () => [],
          monthlyTokenBudget: 1_000_000,
          readMonthlyAccountedTokens: async () => 0,
          structured: async () => {
            modelCalls += 1;
            throw new Error("must not run");
          },
        },
      });
      expect(summary).toEqual({ scanned: 1, learned: 0, updated: 0, retired: 0, skipped: 0, failed: 0 });
      expect(modelCalls).toBe(0);
      expect((await aiMemoryLearningRuns.list({ userId: chose.userId })).total).toBe(0);
    } finally {
      await sql`DELETE FROM auth.users WHERE id IN (${noRow.userId}::uuid, ${neverChose.userId}::uuid, ${chose.userId}::uuid)`;
    }
  });

  test("learns only from turns that finish while learning is on", async () => {
    const createUser = async (label: string) => {
      const suffix = crypto.randomUUID();
      const [user] = await sql<{ id: string }[]>`
        INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
        VALUES (${`ai-since-${label}-${suffix}`}, 'local', 'user', 'AI Since Test', ${`ai-since-${label}-${suffix}@example.test`}, 'AI', 'Since')
        RETURNING id
      `;
      const [conversation] = await sql<{ id: string }[]>`
        INSERT INTO ai.conversations (short_id, created_by_user_id, title)
        VALUES (${createAiShortId()}, ${user!.id}::uuid, 'Learning since test') RETURNING id
      `;
      return { userId: user!.id, conversationId: conversation!.id };
    };
    const finishTurn = async (owner: { userId: string; conversationId: string }) => {
      const [turn] = await sql<{ id: string }[]>`
        INSERT INTO ai.turns (short_id, conversation_id, status, run_config)
        VALUES (${createAiShortId()}, ${owner.conversationId}::uuid, 'running', ${JSON.stringify({ kind: "chat", input: [] })}::jsonb)
        RETURNING id
      `;
      await recordAiMemoryWorkflowEvidence({
        userId: owner.userId,
        conversationId: owner.conversationId,
        turnId: turn!.id,
        capabilityId: "mail.conversation.search",
        resources: [{ ref: { type: "mail.mailbox", id: "BoxSince" } }],
      });
      expect(await aiConversations.completeTurn({ conversationId: owner.conversationId, turnId: turn!.id, status: "completed" })).toBe(
        "completed",
      );
      return turn!.id;
    };
    const learnedAt = async (turnId: string) =>
      (await sql<{ learned: boolean }[]>`SELECT memory_learned_at IS NOT NULL AS learned FROM ai.turns WHERE id = ${turnId}::uuid`)[0]!
        .learned;
    const byDefault = await createUser("default");
    const off = await createUser("off");
    await aiUserPrefs.update(off.userId, { memoryLearningEnabled: false });
    try {
      const defaultTurn = await finishTurn(byDefault);
      const offTurn = await finishTurn(off);
      expect(await learnedAt(defaultTurn)).toBe(false);
      expect(await learnedAt(offTurn)).toBe(true);
      expect(await listAiTurnWorkflowEvidence(byDefault.userId, defaultTurn)).toHaveLength(1);
      expect(await listAiTurnWorkflowEvidence(off.userId, offTurn)).toEqual([]);

      // Turning learning on does not reach back to the turn that finished while it was off.
      await aiUserPrefs.update(off.userId, { memoryLearningEnabled: true });
      const laterTurn = await finishTurn(off);
      const candidates = (await listAiMemoryLearningCandidates(100, 1_000_000)).map((candidate) => candidate.turnId);
      expect(candidates).toContain(defaultTurn);
      expect(candidates).toContain(laterTurn);
      expect(candidates).not.toContain(offTurn);
    } finally {
      await sql`DELETE FROM auth.users WHERE id IN (${byDefault.userId}::uuid, ${off.userId}::uuid)`;
    }
  });

  test("archive retires pending turns and receipts; restore learns only newly completed turns", async () => {
    const userId = await insertLearningUser();
    try {
      const old = await insertLearningTurn(userId);
      await sql`UPDATE ai.turns SET memory_learn_failed_at = now(), memory_learn_fail_count = 2 WHERE id = ${old.turnId}::uuid`;
      expect(await aiConversations.archiveConversation({ conversationId: old.conversationId, ownerUserId: userId })).toBe(true);
      const [turn] = await sql<{ learned: boolean; fail_count: number; failed_at: string | null }[]>`
        SELECT memory_learned_at = completed_at AS learned, memory_learn_fail_count AS fail_count, memory_learn_failed_at AS failed_at
        FROM ai.turns WHERE id = ${old.turnId}::uuid
      `;
      expect(turn).toMatchObject({ learned: true, fail_count: 0, failed_at: null });
      const [receipt] = await sql<{ reviewed: boolean }[]>`
        SELECT reviewed_at IS NOT NULL AS reviewed FROM ai.memory_workflow_evidence WHERE turn_id = ${old.turnId}::uuid
      `;
      expect(receipt?.reviewed).toBe(true);
      let calls = 0;
      const deps = {
        ...learningDeps(),
        listCandidates: async (limit: number, budget: number) =>
          (await listAiMemoryLearningCandidates(limit, budget)).filter((item) => item.userId === userId),
        structured: proposeLearning(async () => {
          calls += 1;
        }),
      };
      expect((await learnAiMemoriesFromPrivateChats({ deps })).learned).toBe(0);
      expect(calls).toBe(0);
      expect(await aiMemories.list({ userId })).toEqual([]);
      expect(await aiConversations.restoreConversation({ conversationId: old.conversationId, ownerUserId: userId })).not.toBeNull();
      expect((await listAiMemoryLearningCandidates(100, 1_000_000)).some((item) => item.turnId === old.turnId)).toBe(false);
      expect((await learnAiMemoriesFromPrivateChats({ deps: { ...deps, listCandidates: async () => [old] } })).skipped).toBe(1);
      expect(calls).toBe(0);
      const fresh = await insertLearningTurn(userId, old.conversationId);
      expect((await listAiMemoryLearningCandidates(100, 1_000_000)).some((item) => item.turnId === fresh.turnId)).toBe(true);
      expect((await learnAiMemoriesFromPrivateChats({ deps: { ...deps, listCandidates: async () => [fresh] } })).learned).toBe(1);
      expect(calls).toBe(1);
      expect(await aiMemories.list({ userId })).toHaveLength(1);
      expect((await listAiPendingWorkflowPatterns(20)).some((item) => item.userId === userId)).toBe(false);
    } finally {
      await sql`DELETE FROM ai.memory_learning_runs WHERE user_id = ${userId}::uuid`;
      await sql`DELETE FROM ai.conversations WHERE created_by_user_id = ${userId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("restore never backfills turns or receipts left pending by an earlier archive", async () => {
    const userId = await insertLearningUser();
    try {
      const first = await insertLearningTurn(userId);
      await insertLearningTurn(userId, first.conversationId);
      await insertLearningTurn(userId, first.conversationId);
      expect((await listAiPendingWorkflowPatterns(20)).some((item) => item.userId === userId)).toBe(true);

      await sql`UPDATE ai.conversations SET archived_at = now() WHERE id = ${first.conversationId}::uuid`;
      expect(await aiConversations.restoreConversation({ conversationId: first.conversationId, ownerUserId: userId })).not.toBeNull();

      expect((await listAiMemoryLearningCandidates(100, 1_000_000)).some((item) => item.userId === userId)).toBe(false);
      expect((await listAiPendingWorkflowPatterns(20)).some((item) => item.userId === userId)).toBe(false);
      const turns = await sql<{ learned: boolean }[]>`
        SELECT memory_learned_at = completed_at AS learned FROM ai.turns WHERE conversation_id = ${first.conversationId}::uuid
      `;
      expect(turns).toEqual([{ learned: true }, { learned: true }, { learned: true }]);
      const receipts = await sql<{ reviewed: boolean }[]>`
        SELECT reviewed_at IS NOT NULL AS reviewed FROM ai.memory_workflow_evidence WHERE user_id = ${userId}::uuid
      `;
      expect(receipts).toEqual([{ reviewed: true }, { reviewed: true }, { reviewed: true }]);
    } finally {
      await sql`DELETE FROM ai.memory_learning_runs WHERE user_id = ${userId}::uuid`;
      await sql`DELETE FROM ai.conversations WHERE created_by_user_id = ${userId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  for (const timing of [
    "after-list",
    "before-model",
    "during-model",
    "restored-during-model",
    "deleted-after-list",
    "deleted-during-model",
  ]) {
    test(`skips turn learning when chat becomes ineligible ${timing}`, async () => {
      const userId = await insertLearningUser();
      try {
        const candidate = await insertLearningTurn(userId);
        const invalidate = async () => {
          if (timing.startsWith("deleted")) {
            await sql`DELETE FROM ai.conversations WHERE id = ${candidate.conversationId}::uuid`;
          } else {
            expect(await aiConversations.archiveConversation({ conversationId: candidate.conversationId, ownerUserId: userId })).toBe(true);
            if (timing === "restored-during-model") {
              expect(
                await aiConversations.restoreConversation({ conversationId: candidate.conversationId, ownerUserId: userId }),
              ).not.toBeNull();
            }
          }
        };
        let calls = 0;
        const summary = await learnAiMemoriesFromPrivateChats({
          deps: {
            ...learningDeps(),
            listCandidates: async () => {
              expect((await listAiMemoryLearningCandidates(100, 1_000_000)).some((item) => item.turnId === candidate.turnId)).toBe(true);
              if (timing.endsWith("after-list")) await invalidate();
              return [candidate];
            },
            readMonthlyAccountedTokens: async () => {
              if (timing === "before-model") await invalidate();
              return 0;
            },
            structured: proposeLearning(async () => {
              calls += 1;
              if (timing.endsWith("during-model")) await invalidate();
            }),
          },
        });
        expect(summary).toMatchObject({ scanned: 1, learned: 0, skipped: 1, failed: 0 });
        if (timing === "before-model") {
          const runs = await sql<{ status: string; accounted_tokens: number }[]>`
            SELECT status, accounted_tokens FROM ai.memory_learning_runs WHERE user_id = ${userId}::uuid
          `;
          expect(runs).toEqual([{ status: "skipped", accounted_tokens: 0 }]);
        }
        expect(calls).toBe(timing.endsWith("during-model") ? 1 : 0);
        expect(await aiMemories.list({ userId })).toEqual([]);
        const rows = await sql<
          { learned: boolean }[]
        >`SELECT memory_learned_at IS NOT NULL AS learned FROM ai.turns WHERE id = ${candidate.turnId}::uuid`;
        if (timing.startsWith("deleted")) {
          expect(rows).toEqual([]);
          expect(await listAiTurnWorkflowEvidence(userId, candidate.turnId)).toEqual([]);
        } else {
          expect(rows[0]?.learned).toBe(true);
        }
        expect((await listAiMemoryLearningCandidates(100, 1_000_000)).some((item) => item.turnId === candidate.turnId)).toBe(false);
      } finally {
        await sql`DELETE FROM ai.memory_learning_runs WHERE user_id = ${userId}::uuid`;
        await sql`DELETE FROM ai.conversations WHERE created_by_user_id = ${userId}::uuid`;
        await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
      }
    });
  }

  for (const timing of [
    "after-list",
    "before-model",
    "during-model",
    "restored-during-model",
    "deleted-after-list",
    "deleted-during-model",
  ]) {
    test(`skips workflow learning when any example becomes ineligible ${timing}`, async () => {
      const userId = await insertLearningUser();
      try {
        const turns = [];
        for (let index = 0; index < 3; index += 1) turns.push(await insertLearningTurn(userId));
        const pattern = (await listAiPendingWorkflowPatterns(20)).find((item) => item.userId === userId);
        expect(pattern).toBeDefined();
        // Invalidate a different example than the source (the newest turn).
        const removed = turns[0]!;
        const invalidate = async () => {
          if (timing.startsWith("deleted")) {
            await sql`DELETE FROM ai.conversations WHERE id = ${removed.conversationId}::uuid`;
          } else {
            expect(await aiConversations.archiveConversation({ conversationId: removed.conversationId, ownerUserId: userId })).toBe(true);
            if (timing === "restored-during-model") {
              expect(
                await aiConversations.restoreConversation({ conversationId: removed.conversationId, ownerUserId: userId }),
              ).not.toBeNull();
            }
          }
        };
        let calls = 0;
        const summary = await learnAiMemoriesFromPrivateChats({
          deps: {
            ...learningDeps(),
            listWorkflowPatterns: async () => {
              if (timing.endsWith("after-list")) await invalidate();
              return [pattern!];
            },
            readMonthlyAccountedTokens: async () => {
              if (timing === "before-model") await invalidate();
              return 0;
            },
            structured: proposeLearning(async () => {
              calls += 1;
              if (timing.endsWith("during-model")) await invalidate();
            }),
          },
        });
        expect(summary).toMatchObject({ learned: 0, skipped: 1, failed: 0 });
        if (timing === "before-model") {
          const runs = await sql<{ status: string; accounted_tokens: number }[]>`
            SELECT status, accounted_tokens FROM ai.memory_learning_runs WHERE user_id = ${userId}::uuid
          `;
          expect(runs).toEqual([{ status: "skipped", accounted_tokens: 0 }]);
        }
        expect(calls).toBe(timing.endsWith("during-model") ? 1 : 0);
        expect(await aiMemories.list({ userId })).toEqual([]);
        expect((await listAiPendingWorkflowPatterns(20)).some((item) => item.userId === userId)).toBe(false);
        // The two remaining chats can contribute to a future three-turn pattern.
        const [pending] = await sql<{ count: number }[]>`
          SELECT count(*)::int AS count FROM ai.memory_workflow_evidence WHERE user_id = ${userId}::uuid AND reviewed_at IS NULL
        `;
        expect(pending?.count).toBe(2);
      } finally {
        await sql`DELETE FROM ai.memory_learning_runs WHERE user_id = ${userId}::uuid`;
        await sql`DELETE FROM ai.conversations WHERE created_by_user_id = ${userId}::uuid`;
        await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
      }
    });
  }
});
