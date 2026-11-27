import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { databaseSuite, useMigratedDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrateAiModelClasses, migrateCloudAi } from "../ai/migrate";
import { migrateAiQuotas } from "../ai/quotas-migrate";
import { sql } from "../runtime/clients";
import { dropConcurrentIndex, ensureConcurrentIndexes, settleBackgroundIndexBuilds } from "./concurrent-index";
import { logger } from "./logging";

databaseSuite()("index builds next to live writes", () => {
  let database: Awaited<ReturnType<typeof useMigratedDatabase>>;
  beforeAll(async () => {
    database = await useMigratedDatabase("concurrent_index");
  }, 120_000);
  // Dropping a migrated database outlasts the 5 s default on a fresh server, as in the other migrated suites.
  afterAll(async () => {
    await settleBackgroundIndexBuilds();
    await sql.close();
    await database?.drop();
  }, 60_000);
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

  test("a migration next to a running build does not wait for it", async () => {
    // A concurrent build holds this lock for as long as it runs, as another replica's build would.
    const build = await sql.reserve();
    const settled = (work: Promise<unknown>) =>
      Promise.race([
        work.then(() => "done"),
        // fixed wait: the deadline that tells "waits behind the build" apart; a passing migration ends long before it.
        new Promise((resolve) => setTimeout(() => resolve("waiting"), 10_000).unref()),
      ]);
    let migration: Promise<unknown> | undefined;
    try {
      await build`BEGIN`.simple();
      await build`LOCK TABLE ai.inference_calls IN SHARE UPDATE EXCLUSIVE MODE`.simple();
      migration = Promise.all([migrateAiQuotas(), migrateAiModelClasses()]);
      expect(await settled(migration)).toBe("done");
    } finally {
      await build`ROLLBACK`.simple();
      build.release();
      await migration?.catch(() => undefined);
    }
  }, 60_000);

  test("a missing column or index is added, an existing one takes no lock", async () => {
    await sql`ALTER TABLE ai.inference_calls DROP COLUMN IF EXISTS code_id`.simple();
    await sql`DROP INDEX IF EXISTS ai.inference_calls_started`.simple();
    await migrateAiQuotas();
    const [column] = await sql<{ present: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
      WHERE attrelid = to_regclass('ai.inference_calls') AND attname = 'code_id' AND NOT attisdropped) AS present`;
    const [index] = await sql<{ present: boolean }[]>`SELECT to_regclass('ai.inference_calls_started') IS NOT NULL AS present`;
    expect([column?.present, index?.present]).toEqual([true, true]);
  });

  test("a unique index is built unique, and a concurrent drop removes it", async () => {
    const log = logger("concurrent-index-test");
    const index = { name: "ai_conversations_unique_test", table: "ai.conversations", definition: "(id)", unique: true };
    expect(await ensureConcurrentIndexes([index], { log, purpose: "test" })).toBe("built");
    const [built] = await sql<{ unique: boolean }[]>`SELECT indisunique AS unique FROM pg_catalog.pg_index
      WHERE indexrelid = to_regclass('ai.ai_conversations_unique_test')`;
    expect(built?.unique).toBeTrue();
    expect(await dropConcurrentIndex(index, { log, purpose: "test" })).toBe("ready");
    expect(await sql`SELECT 1 FROM pg_catalog.pg_class WHERE relname = 'ai_conversations_unique_test'`).toHaveLength(0);
  });

  test("a unique index over duplicate rows fails once, is reported, and is not retried by the same process", async () => {
    const log = logger("concurrent-index-test");
    const error = spyOn(log, "error").mockImplementation(() => {});
    const index = { name: "concurrent_index_duplicates_v", table: "ai.concurrent_index_duplicates", definition: "(v)", unique: true };
    await sql`CREATE TABLE ai.concurrent_index_duplicates (v integer NOT NULL)`.simple();
    await sql`INSERT INTO ai.concurrent_index_duplicates (v) VALUES (1), (1)`;
    try {
      expect(await ensureConcurrentIndexes([index], { log, purpose: "test" })).toBe("failed");
      expect(await ensureConcurrentIndexes([index], { log, purpose: "test" })).toBe("failed");
      expect(error).toHaveBeenCalledTimes(1);
      expect(await sql`SELECT 1 FROM pg_catalog.pg_class WHERE relname = 'concurrent_index_duplicates_v'`).toHaveLength(0);
    } finally {
      error.mockRestore();
      await sql`DROP TABLE ai.concurrent_index_duplicates`.simple();
    }
  });

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
      // The definition reaches SQL as written, so a second statement in it is refused as well.
      expect(
        await ensureConcurrentIndexes(
          [{ name: "ai_conversations_y", table: "ai.conversations", definition: "(id); DROP TABLE ai.conversations" }],
          {
            log,
            purpose: "test",
          },
        ),
      ).toBe("failed");
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
    expect(await sql`SELECT 1 FROM pg_catalog.pg_class WHERE relname = 'ai_conversations_x'`).toHaveLength(0);
  });
});
