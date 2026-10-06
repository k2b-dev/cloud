import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { migrateCloudAi } from "./migrate";
import { aiUserPrefs } from "./prefs";
import { createAiShortId } from "./short-id";

const insertUser = async () => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
    VALUES (${`ai-prefs-${suffix}`}, 'local', 'user', 'AI Prefs Test', ${`ai-prefs-${suffix}@example.test`}, 'AI', 'Prefs')
    RETURNING id
  `;
  return row!.id;
};

// user delete cascades ai.user_prefs
const cleanupUser = async (userId: string) => {
  await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
};

const storedLearning = async (userId: string) => {
  const [row] = await sql<{ memory_learning_enabled: boolean | null }[]>`
    SELECT memory_learning_enabled FROM ai.user_prefs WHERE user_id = ${userId}::uuid
  `;
  return row?.memory_learning_enabled;
};

const learningChosenAt = async (userId: string) => {
  const [row] = await sql<{ chosen_at: string | null }[]>`
    SELECT memory_learning_chosen_at::text AS chosen_at FROM ai.user_prefs WHERE user_id = ${userId}::uuid
  `;
  return row?.chosen_at ?? null;
};

/** A completed private-chat turn with one workflow receipt, written the way an earlier release left it. */
const insertLegacyTurn = async (userId: string) => {
  const [conversation] = await sql<{ id: string }[]>`
    INSERT INTO ai.conversations (short_id, created_by_user_id, title)
    VALUES (${createAiShortId()}, ${userId}::uuid, 'Legacy learning') RETURNING id
  `;
  const [turn] = await sql<{ id: string }[]>`
    INSERT INTO ai.turns (short_id, conversation_id, status, run_config, completed_at)
    VALUES (${createAiShortId()}, ${conversation!.id}::uuid, 'completed', ${JSON.stringify({ kind: "chat", input: [] })}::jsonb, now())
    RETURNING id
  `;
  await sql`
    INSERT INTO ai.memory_workflow_evidence (user_id, turn_id, conversation_id, capability_id, resource_type, resource_id)
    VALUES (${userId}::uuid, ${turn!.id}::uuid, ${conversation!.id}::uuid, 'mail.conversation.search', 'mail.mailbox', 'BoxLegacy')
  `;
  return turn!.id;
};

const considered = async (turnId: string) => {
  const [row] = await sql<{ learned: boolean; reviewed: boolean }[]>`
    SELECT turn.memory_learned_at IS NOT NULL AS learned, evidence.reviewed_at IS NOT NULL AS reviewed
    FROM ai.turns turn JOIN ai.memory_workflow_evidence evidence ON evidence.turn_id = turn.id
    WHERE turn.id = ${turnId}::uuid
  `;
  return row;
};

databaseSuite()("aiUserPrefs (integration)", () => {
  beforeAll(async () => {
    await migrateCloudAi();
  });
  test("get returns defaults for users without a row", async () => {
    const userId = await insertUser();
    try {
      const prefs = await aiUserPrefs.get(userId);
      expect(prefs.memoryEnabled).toBe(true);
      expect(prefs.memoryLearningEnabled).toBe(true);
    } finally {
      await cleanupUser(userId);
    }
  });

  test("a row written for another preference leaves learning on the default", async () => {
    const userId = await insertUser();
    try {
      expect((await aiUserPrefs.update(userId, { lastModelId: "model-a" })).memoryLearningEnabled).toBe(true);
      expect((await aiUserPrefs.update(userId, { memoryEnabled: false })).memoryLearningEnabled).toBe(true);
      expect(await storedLearning(userId)).toBeNull();
      expect(await learningChosenAt(userId)).toBeNull();
    } finally {
      await cleanupUser(userId);
    }
  });

  test("an explicit choice is stored, kept across other updates, and can be toggled", async () => {
    const userId = await insertUser();
    try {
      expect((await aiUserPrefs.update(userId, { memoryLearningEnabled: false })).memoryLearningEnabled).toBe(false);
      const chosenAt = await learningChosenAt(userId);
      expect(chosenAt).not.toBeNull();
      await aiUserPrefs.update(userId, { lastModelId: "model-a" });
      await aiUserPrefs.update(userId, { memoryEnabled: true });
      expect((await aiUserPrefs.get(userId)).memoryLearningEnabled).toBe(false);
      expect(await storedLearning(userId)).toBe(false);
      // Other preferences never count as a learning choice.
      expect(await learningChosenAt(userId)).toBe(chosenAt);

      expect((await aiUserPrefs.update(userId, { memoryLearningEnabled: true })).memoryLearningEnabled).toBe(true);
      expect((await aiUserPrefs.update(userId, { memoryLearningEnabled: false })).memoryLearningEnabled).toBe(false);
      expect(await storedLearning(userId)).toBe(false);
    } finally {
      await cleanupUser(userId);
    }
  });

  test("migration keeps earlier stored values and does not reach back to earlier chats", async () => {
    // Recreate the earlier shape: NOT NULL with DEFAULT FALSE and no record of
    // explicit choices. NOT NULL can only be restored while no row has made use
    // of the new NULL state.
    await sql`ALTER TABLE ai.user_prefs DROP COLUMN memory_learning_chosen_at`.simple();
    await sql`ALTER TABLE ai.user_prefs ALTER COLUMN memory_learning_enabled SET DEFAULT FALSE`.simple();
    await sql`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM ai.user_prefs WHERE memory_learning_enabled IS NULL) THEN
          ALTER TABLE ai.user_prefs ALTER COLUMN memory_learning_enabled SET NOT NULL;
        END IF;
      END $$
    `.simple();
    const legacyDefault = await insertUser();
    const legacyOn = await insertUser();
    const legacyNoRow = await insertUser();
    const afterMigration = await insertUser();
    try {
      await sql`INSERT INTO ai.user_prefs (user_id, last_model_id) VALUES (${legacyDefault}::uuid, 'model-a')`;
      await sql`INSERT INTO ai.user_prefs (user_id, memory_learning_enabled) VALUES (${legacyOn}::uuid, TRUE)`;
      const defaultTurn = await insertLegacyTurn(legacyDefault);
      const onTurn = await insertLegacyTurn(legacyOn);
      const noRowTurn = await insertLegacyTurn(legacyNoRow);

      await migrateCloudAi();

      const [column] = await sql<{ is_nullable: string; column_default: string | null }[]>`
        SELECT is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'ai' AND table_name = 'user_prefs' AND column_name = 'memory_learning_enabled'
      `;
      expect(column).toEqual({ is_nullable: "YES", column_default: null });
      // A stored FALSE may be an explicit "off"; it is never overridden.
      expect((await aiUserPrefs.get(legacyDefault)).memoryLearningEnabled).toBe(false);
      expect((await aiUserPrefs.get(legacyOn)).memoryLearningEnabled).toBe(true);
      expect((await aiUserPrefs.get(legacyNoRow)).memoryLearningEnabled).toBe(true);
      expect(await learningChosenAt(legacyDefault)).toBeNull();
      // Chats from before the upgrade finished while learning was off for everyone
      // without an explicit "on", so they are never learned from.
      expect(await considered(defaultTurn)).toEqual({ learned: true, reviewed: true });
      expect(await considered(noRowTurn)).toEqual({ learned: true, reviewed: true });
      expect(await considered(onTurn)).toEqual({ learned: false, reviewed: false });

      // The backfill runs once; later starts leave new turns alone.
      const laterTurn = await insertLegacyTurn(legacyNoRow);
      await migrateCloudAi();
      expect(await considered(laterTurn)).toEqual({ learned: false, reviewed: false });

      await sql`INSERT INTO ai.user_prefs (user_id, last_model_id) VALUES (${afterMigration}::uuid, 'model-a')`;
      expect(await storedLearning(afterMigration)).toBeNull();
      expect((await aiUserPrefs.get(afterMigration)).memoryLearningEnabled).toBe(true);
    } finally {
      await Promise.all([legacyDefault, legacyOn, legacyNoRow, afterMigration].map(cleanupUser));
    }
  });

  test("update upserts partial patches", async () => {
    const userId = await insertUser();
    try {
      const first = await aiUserPrefs.update(userId, { memoryEnabled: true });
      expect(first.memoryEnabled).toBe(true);

      const second = await aiUserPrefs.update(userId, { memoryEnabled: false });
      expect(second.memoryEnabled).toBe(false);
      const third = await aiUserPrefs.update(userId, { memoryLearningEnabled: true });
      expect(third.memoryEnabled).toBe(false);
      expect(third.memoryLearningEnabled).toBe(true);
    } finally {
      await cleanupUser(userId);
    }
  });
});
