import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { databaseSuite, useMigratedDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrateCloudAi } from "../ai/migrate";
import { sql } from "../runtime/clients";
import { ensureConcurrentIndexes, settleBackgroundIndexBuilds } from "./concurrent-index";
import { logger } from "./logging";

databaseSuite()("index builds next to live writes", () => {
  let database: Awaited<ReturnType<typeof useMigratedDatabase>>;
  beforeAll(async () => {
    database = await useMigratedDatabase("concurrent_index");
  }, 120_000);
  afterAll(async () => {
    await settleBackgroundIndexBuilds();
    await sql.close();
    await database?.drop();
  });
  const turnIndex = async () => {
    const [index] = await sql<{ valid: boolean }[]>`SELECT indisvalid AS valid FROM pg_catalog.pg_index
      WHERE indexrelid = to_regclass('ai.inference_calls_all_turn')`;
    return index?.valid;
  };
  const buildWaiting = async () => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const [build] = await sql<{ pid: number }[]>`SELECT pid FROM pg_catalog.pg_stat_progress_create_index
        WHERE relid = to_regclass('ai.inference_calls')`;
      if (build) return build.pid;
      await Bun.sleep(25);
    }
    throw new Error("The index build did not start");
  };

  test("the migration returns while an old snapshot holds the index build, which finishes once the snapshot ends", async () => {
    await sql`DROP INDEX IF EXISTS ai.inference_calls_all_turn`.simple();
    // A long transaction, as a nightly dump holds one: CREATE INDEX CONCURRENTLY waits for its snapshot.
    const dump = await sql.reserve();
    try {
      await dump`BEGIN ISOLATION LEVEL REPEATABLE READ`.simple();
      // Its snapshot alone holds the build; it touches no table, so the migration's own DDL does not wait for it.
      await dump`SELECT 1`.simple();
      // Startup awaits the migration; it must not wait for the build.
      await migrateCloudAi();
      await buildWaiting();
      expect(await turnIndex()).toBe(false);
      await dump`COMMIT`.simple();
    } finally {
      await dump`ROLLBACK`.simple();
      dump.release();
    }
    await settleBackgroundIndexBuilds();
    expect(await turnIndex()).toBe(true);
  }, 120_000);

  test("a malformed index never throws: it is logged and nothing is built", async () => {
    const log = logger("concurrent-index-test");
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      expect(
        await ensureConcurrentIndexes([{ name: "x; DROP TABLE ai.conversations", table: "ai.conversations", definition: "(id)" }], {
          log,
          purpose: "test",
        }),
      ).toBe("failed");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
    expect(await sql`SELECT 1 FROM pg_catalog.pg_class WHERE relname = 'ai_conversations_x'`).toHaveLength(0);
  });
});
