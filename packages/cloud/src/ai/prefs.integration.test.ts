import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { migrateCloudAi } from "./migrate";
import { aiUserPrefs } from "./prefs";

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
    } finally {
      await cleanupUser(userId);
    }
  });

  test("an explicit choice is stored, kept across other updates, and can be toggled", async () => {
    const userId = await insertUser();
    try {
      expect((await aiUserPrefs.update(userId, { memoryLearningEnabled: false })).memoryLearningEnabled).toBe(false);
      await aiUserPrefs.update(userId, { lastModelId: "model-a" });
      await aiUserPrefs.update(userId, { memoryEnabled: true });
      expect((await aiUserPrefs.get(userId)).memoryLearningEnabled).toBe(false);
      expect(await storedLearning(userId)).toBe(false);

      expect((await aiUserPrefs.update(userId, { memoryLearningEnabled: true })).memoryLearningEnabled).toBe(true);
      expect((await aiUserPrefs.update(userId, { memoryLearningEnabled: false })).memoryLearningEnabled).toBe(false);
      expect(await storedLearning(userId)).toBe(false);
    } finally {
      await cleanupUser(userId);
    }
  });

  test("migration makes the column nullable without switching existing rows on", async () => {
    // Recreate the earlier shape: NOT NULL with DEFAULT FALSE. NOT NULL can only
    // be restored while no row has made use of the new NULL state.
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
    const afterMigration = await insertUser();
    try {
      await sql`INSERT INTO ai.user_prefs (user_id, last_model_id) VALUES (${legacyDefault}::uuid, 'model-a')`;
      await sql`INSERT INTO ai.user_prefs (user_id, memory_learning_enabled) VALUES (${legacyOn}::uuid, TRUE)`;

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

      await sql`INSERT INTO ai.user_prefs (user_id, last_model_id) VALUES (${afterMigration}::uuid, 'model-a')`;
      expect(await storedLearning(afterMigration)).toBeNull();
      expect((await aiUserPrefs.get(afterMigration)).memoryLearningEnabled).toBe(true);
    } finally {
      await Promise.all([cleanupUser(legacyDefault), cleanupUser(legacyOn), cleanupUser(afterMigration)]);
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
