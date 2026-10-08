import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import {
  listAiPendingWorkflowPatterns,
  listAiTurnWorkflowEvidence,
  markAiWorkflowPatternReviewed,
  recordAiMemoryWorkflowEvidence,
} from "./memory-workflow-evidence";
import { migrateCloudAi } from "./migrate";
import { createAiShortId } from "./short-id";
import { aiConversations } from "./store";

const insertUser = async (suffix: string): Promise<string> => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
    VALUES (${`workflow-evidence-${suffix}`}, 'local', 'user', 'Workflow Evidence', ${`workflow-${suffix}@example.test`}, 'Workflow', 'Evidence')
    RETURNING id
  `;
  return row!.id;
};

const insertCompletedTurn = async (userId: string): Promise<{ conversationId: string; turnId: string }> => {
  const [conversation] = await sql<{ id: string }[]>`
    INSERT INTO ai.conversations (short_id, created_by_user_id, title)
    VALUES (${createAiShortId()}, ${userId}::uuid, 'Workflow evidence')
    RETURNING id
  `;
  const [turn] = await sql<{ id: string }[]>`
    INSERT INTO ai.turns (short_id, conversation_id, status, run_config, completed_at)
    VALUES (${createAiShortId()}, ${conversation!.id}::uuid, 'completed', ${JSON.stringify({ kind: "chat", input: [] })}::jsonb, now())
    RETURNING id
  `;
  return { conversationId: conversation!.id, turnId: turn!.id };
};

databaseSuite()("AI workflow evidence (integration)", () => {
  beforeAll(async () => {
    await migrateCloudAi();
  });
  test("counts idempotent successful receipts per user and reviews a three-turn pattern", async () => {
    const suffix = crypto.randomUUID();
    const firstUser = await insertUser(`${suffix}-first`);
    const secondUser = await insertUser(`${suffix}-second`);
    try {
      await sql`
        INSERT INTO ai.user_prefs (user_id, memory_learning_enabled)
        VALUES (${firstUser}::uuid, TRUE), (${secondUser}::uuid, TRUE)
        ON CONFLICT (user_id) DO UPDATE SET memory_learning_enabled = TRUE
      `;
      const turns = await Promise.all(Array.from({ length: 3 }, () => insertCompletedTurn(firstUser)));
      for (const turn of turns) {
        const receipt = {
          userId: firstUser,
          ...turn,
          capabilityId: "mail.conversation.search",
          resources: [{ ref: { type: "mail.mailbox", id: "Box123" }, title: "Accounting" }],
        };
        await recordAiMemoryWorkflowEvidence(receipt);
        await recordAiMemoryWorkflowEvidence(receipt);
      }

      await recordAiMemoryWorkflowEvidence({
        userId: secondUser,
        ...turns[0]!,
        capabilityId: "mail.conversation.search",
        resources: [{ ref: { type: "mail.mailbox", id: "Box123" }, title: "Accounting" }],
      });

      expect(await listAiTurnWorkflowEvidence(secondUser, turns[0]!.turnId)).toEqual([]);
      expect(await listAiTurnWorkflowEvidence(firstUser, turns[0]!.turnId)).toHaveLength(1);
      const pattern = (await listAiPendingWorkflowPatterns(10)).find(
        (item) => item.userId === firstUser && item.resourceRef.id === "Box123",
      );
      expect(pattern).toMatchObject({
        capabilityId: "mail.conversation.search",
        resourceRef: { type: "mail.mailbox", id: "Box123" },
        resourceTitle: "Accounting",
        observationCount: 3,
      });
      expect(pattern?.turnIds).toHaveLength(3);
      await markAiWorkflowPatternReviewed(pattern!);
      expect((await listAiPendingWorkflowPatterns(10)).some((item) => item.userId === firstUser)).toBe(false);
    } finally {
      await sql`DELETE FROM auth.users WHERE id IN (${firstUser}::uuid, ${secondUser}::uuid)`;
    }
  });

  test("archived receipts do not count or become examples, even when still unreviewed", async () => {
    const userId = await insertUser(crypto.randomUUID());
    try {
      const turns = [];
      for (let index = 0; index < 4; index += 1) {
        const turn = await insertCompletedTurn(userId);
        turns.push(turn);
        await recordAiMemoryWorkflowEvidence({
          userId,
          ...turn,
          capabilityId: "mail.conversation.search",
          resources: [{ ref: { type: "mail.mailbox", id: "BoxArchived" }, title: "Accounting" }],
        });
      }
      const archived = turns[3]!;
      // Simulate old pending evidence left behind by archive before this fix.
      await sql`UPDATE ai.conversations SET archived_at = now() WHERE id = ${archived.conversationId}::uuid`;
      await sql`UPDATE ai.memory_workflow_evidence SET observed_at = now() + interval '1 second' WHERE turn_id = ${archived.turnId}::uuid`;
      expect(await listAiTurnWorkflowEvidence(userId, archived.turnId)).toEqual([]);
      const pattern = (await listAiPendingWorkflowPatterns(20)).find((item) => item.userId === userId);
      expect(pattern?.observationCount).toBe(3);
      expect(pattern?.turnIds).toHaveLength(3);
      expect(pattern?.turnIds).not.toContain(archived.turnId);
      await sql`DELETE FROM ai.conversations WHERE id = ${turns[0]!.conversationId}::uuid`;
      expect(await listAiTurnWorkflowEvidence(userId, turns[0]!.turnId)).toEqual([]);
      expect((await listAiPendingWorkflowPatterns(20)).some((item) => item.userId === userId)).toBe(false);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE created_by_user_id = ${userId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("does not record late workflow receipts from archived or deleted chats", async () => {
    const userId = await insertUser(crypto.randomUUID());
    try {
      const turn = await insertCompletedTurn(userId);
      expect(await aiConversations.archiveConversation({ conversationId: turn.conversationId, ownerUserId: userId })).toBe(true);
      const receipt = {
        userId,
        ...turn,
        capabilityId: "mail.conversation.search",
        resources: [{ ref: { type: "mail.mailbox", id: "BoxLate" } }],
      };
      await recordAiMemoryWorkflowEvidence(receipt);
      const [count] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM ai.memory_workflow_evidence WHERE user_id = ${userId}::uuid
      `;
      expect(count?.count).toBe(0);
      await sql`DELETE FROM ai.conversations WHERE id = ${turn.conversationId}::uuid`;
      await expect(recordAiMemoryWorkflowEvidence(receipt)).resolves.toBeUndefined();
    } finally {
      await sql`DELETE FROM ai.conversations WHERE created_by_user_id = ${userId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
});
