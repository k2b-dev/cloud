import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import {
  listAiPendingWorkflowPatterns,
  listAiTurnWorkflowEvidence,
  markAiWorkflowPatternReviewed,
  recordAiMemoryWorkflowEvidence,
} from "./memory-workflow-evidence";
import { migrateCloudAi } from "./migrate";
import { createAiShortId } from "./short-id";

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

describe.skipIf(!(await canUseAiDatabase()))("AI workflow evidence (integration)", () => {
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
});
