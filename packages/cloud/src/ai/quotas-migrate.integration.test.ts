import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { SQL } from "bun";
import { databaseSuite, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateLogging } from "../../../core/src/migrate/core/logging";
import { sql } from "../runtime/clients";
import { ensureAiInferenceTurnIndex, migrateAiQuotas } from "./quotas-migrate";

databaseSuite()("inference turn index migration", () => {
  let fresh: Awaited<ReturnType<typeof useFreshDatabase>>;
  beforeAll(async () => {
    fresh = await useFreshDatabase("ai_quota_indexes");
    await sql`CREATE SCHEMA auth`;
    await sql`CREATE SCHEMA ai`;
    await sql`CREATE TABLE auth.users(id UUID PRIMARY KEY)`;
    await sql`CREATE TABLE auth.service_accounts(id UUID PRIMARY KEY)`;
    await migrateLogging();
    await migrateAiQuotas();
  });
  afterAll(async () => {
    await sql.close();
    await fresh?.drop();
  });
  const valid = async () => {
    const [index] = await sql<{ valid: boolean }[]>`SELECT indisvalid AS valid FROM pg_catalog.pg_index
      WHERE indexrelid = to_regclass('ai.inference_calls_all_turn')`;
    return index?.valid;
  };
  const blockedBuild = async (writerPid: number) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const [build] = await sql<{ pid: number }[]>`SELECT pid FROM pg_catalog.pg_stat_progress_create_index
        WHERE relid = to_regclass('ai.inference_calls') AND ${writerPid}::int = ANY(pg_blocking_pids(pid))`;
      if (build) return build.pid;
      await Bun.sleep(25);
    }
    throw new Error("The inference index build did not wait on the controlled writer");
  };

  test("creates a valid index and accepts it on repeated migration", async () => {
    expect(await valid()).toBe(true);
    await migrateAiQuotas();
    expect(await ensureAiInferenceTurnIndex()).toBe(true);
    expect(await valid()).toBe(true);
  });

  test("leaves an active build alone and replaces its interrupted invalid index", async () => {
    await sql`DROP INDEX ai.inference_calls_all_turn`.simple();
    const writer = await sql.reserve();
    const other = await sql.reserve();
    const impatient = new SQL({ url: fresh.url, max: 2, connection: { lock_timeout: "2000", statement_timeout: "5000" } });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let running: Promise<string> | undefined;
    try {
      const [backend] = await writer<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await writer`BEGIN`.simple();
      await writer`LOCK TABLE ai.inference_calls IN ROW EXCLUSIVE MODE`.simple();
      running = other`CREATE INDEX CONCURRENTLY inference_calls_all_turn ON ai.inference_calls(turn_id)`.simple().then(
        () => "built",
        () => "interrupted",
      );
      const pid = await blockedBuild(backend!.pid);
      expect(await ensureAiInferenceTurnIndex(impatient)).toBe(false);
      expect(warn).not.toHaveBeenCalled();
      await sql`SELECT pg_cancel_backend(${pid}::int)`;
      expect(await running).toBe("interrupted");
      await writer`COMMIT`.simple();
    } finally {
      await writer`ROLLBACK`.simple();
      writer.release();
      await running;
      other.release();
      await impatient.close();
      warn.mockRestore();
    }
    expect(await valid()).toBe(false);
    expect(await ensureAiInferenceTurnIndex()).toBe(true);
    expect(await valid()).toBe(true);
  });

  test("a cancelled build logs without throwing or trapping ordinary pool queries", async () => {
    await sql`DROP INDEX ai.inference_calls_all_turn`.simple();
    const writer = await sql.reserve();
    const pool = new SQL({ url: fresh.url, max: 2, connection: { statement_timeout: "5000" } });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let running: Promise<boolean> | undefined;
    try {
      const [backend] = await writer<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await writer`BEGIN`.simple();
      await writer`LOCK TABLE ai.inference_calls IN ROW EXCLUSIVE MODE`.simple();
      running = ensureAiInferenceTurnIndex(pool);
      const pid = await blockedBuild(backend!.pid);
      const probes = await Promise.all(Array.from({ length: 4 }, () => pool`SELECT 1 AS ready`.execute()));
      expect(probes.every((rows) => rows[0]?.ready === 1)).toBe(true);
      expect(await sql`SELECT 1 FROM pg_catalog.pg_stat_progress_create_index WHERE pid=${pid}::int`).toHaveLength(1);
      await sql`SELECT pg_cancel_backend(${pid}::int)`;
      await writer`COMMIT`.simple();
      expect(await running).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        "[ai:quotas]",
        "Inference turn index build failed; retrying at the next migration",
        expect.objectContaining({ error: expect.any(String) }),
      );
    } finally {
      await writer`ROLLBACK`.simple();
      writer.release();
      await running;
      await pool.close();
      warn.mockRestore();
    }
    expect(await ensureAiInferenceTurnIndex()).toBe(true);
    expect(await valid()).toBe(true);
  });
});
