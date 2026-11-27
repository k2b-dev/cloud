import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { SQL } from "bun";
import { databaseSuite, testInfra, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { sql } from "../runtime/clients";
import { type ConcurrentIndex, ensureConcurrentIndexes } from "./concurrent-index";
import { logger } from "./logging";

// TimescaleDB is optional for an installation and absent from CI's Postgres: these tests run where the database
// offers the extension and are skipped elsewhere, saying why.
const database = testInfra.database ? await useFreshDatabase("hypertable_index") : null;
const [offered] = database
  ? await sql<{ yes: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb') AS yes`
  : [];
const suite = offered?.yes ? databaseSuite() : describe.skip;
if (!offered?.yes) console.log("hypertable index tests skipped: the test database offers no timescaledb extension");
afterAll(async () => {
  await database?.drop();
}, 60_000);

const VISIBLE: ConcurrentIndex = {
  name: "hyper_events_visible",
  table: "hyper.events",
  definition: "(created_at DESC, id DESC)",
  where: "NOT ((metadata->>'provenance' = 'system') IS TRUE)",
};
const log = logger("concurrent-index-hypertable-test");
const options = { log, purpose: "test" };
const indexState = async () => {
  const [row] = await sql<{ present: boolean; valid: boolean | null; chunks: number; indexed: number }[]>`
    SELECT to_regclass('hyper.hyper_events_visible') IS NOT NULL AS present,
      (SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('hyper.hyper_events_visible')) AS valid,
      (SELECT count(*)::int FROM pg_inherits WHERE inhparent = 'hyper.events'::regclass) AS chunks,
      (SELECT count(*)::int FROM pg_index i JOIN pg_inherits h ON h.inhrelid = i.indrelid
        WHERE h.inhparent = 'hyper.events'::regclass AND i.indisvalid
          AND pg_get_indexdef(i.indexrelid) LIKE '%provenance%') AS indexed`;
  return row!;
};
/** A connection of its own, as a second session holds locks in another process. */
const session = () => new SQL({ url: process.env.DATABASE_URL!, max: 1 });

suite("index builds on a TimescaleDB hypertable", () => {
  beforeAll(async () => {
    await sql`CREATE EXTENSION IF NOT EXISTS timescaledb`.simple();
    await sql`CREATE SCHEMA IF NOT EXISTS hyper`.simple();
    await sql`CREATE TABLE hyper.events (id BIGINT GENERATED ALWAYS AS IDENTITY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb)`.simple();
    await sql`SELECT create_hypertable('hyper.events', 'created_at')`.simple();
    // sixty days of entries, so the table has several chunks; every second one is automatic
    await sql`INSERT INTO hyper.events (created_at, metadata)
      SELECT now() - n * interval '30 seconds', CASE WHEN n % 2 = 0 THEN '{"provenance":"system"}'::jsonb ELSE '{}'::jsonb END
      FROM generate_series(1, 170000) AS n`.simple();
  }, 120_000);

  test("a partial index is built chunk by chunk and is valid on every chunk", async () => {
    expect(await ensureConcurrentIndexes([VISIBLE], options)).toBe("built");
    const state = await indexState();
    expect(state.chunks).toBeGreaterThan(5);
    expect({ valid: state.valid, indexed: state.indexed }).toEqual({ valid: true, indexed: state.chunks });
    expect(await ensureConcurrentIndexes([VISIBLE], options)).toBe("ready");
  }, 60_000);

  test("a build that runs elsewhere is left alone; its invalid leftover is built again once it is gone", async () => {
    // what an interrupted chunk-by-chunk build leaves: the index on the hypertable, marked invalid
    await sql`UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'hyper.hyper_events_visible'::regclass`.simple();
    const [chunk] = await sql<{ name: string }[]>`SELECT inhrelid::regclass::text AS name FROM pg_inherits
      WHERE inhparent = 'hyper.events'::regclass ORDER BY inhrelid LIMIT 1`;
    // another session indexes a chunk: TimescaleDB reports no progress for it, only its share lock on the chunk
    const other = session();
    try {
      await other`BEGIN`.simple();
      await other.unsafe(`LOCK TABLE ${chunk!.name} IN SHARE MODE`).simple();
      expect(await ensureConcurrentIndexes([VISIBLE], options)).toBe("busy");
      expect((await indexState()).present).toBe(true);
      await other`COMMIT`.simple();
    } finally {
      await other.close();
    }
    expect(await ensureConcurrentIndexes([VISIBLE], options)).toBe("built");
    expect((await indexState()).valid).toBe(true);
  }, 60_000);

  test("a build that waits for a lock gives way within its timeout instead of queuing writes behind it", async () => {
    await sql`DROP INDEX hyper.hyper_events_visible`.simple();
    const info = spyOn(log, "info").mockImplementation(() => {});
    const holder = session();
    const writer = session();
    try {
      // a write still open, as a long request holds one: the build cannot take its lock on the table
      await holder`BEGIN`.simple();
      await holder`INSERT INTO hyper.events (metadata) VALUES ('{}'::jsonb)`.simple();
      const started = performance.now();
      const building = ensureConcurrentIndexes([VISIBLE], options);
      // a write that arrives while the build waits finishes once the build gives way, not when the holder ends
      await Bun.sleep(100);
      const write = writer`INSERT INTO hyper.events (metadata) VALUES ('{}'::jsonb)`.simple();
      expect(await building).toBe("busy");
      await write;
      expect(performance.now() - started).toBeLessThan(10_000);
      expect((await indexState()).present).toBe(false);
      await holder`COMMIT`.simple();
    } finally {
      info.mockRestore();
      await holder.close();
      await writer.close();
    }
    expect(await ensureConcurrentIndexes([VISIBLE], options)).toBe("built");
  }, 60_000);

  test("the lock timeout of a hypertable build stays with that build: the connection goes back without it", async () => {
    // a pool of one connection: the build's reserved connection is the one the next query gets
    const pool = session();
    try {
      await sql`DROP INDEX IF EXISTS hyper.hyper_events_visible`.simple();
      expect(await ensureConcurrentIndexes([VISIBLE], { ...options, db: pool })).toBe("built");
      const [setting] = await pool<{ lock_timeout: string }[]>`SHOW lock_timeout`;
      expect(setting!.lock_timeout).toBe("0");
    } finally {
      await pool.close();
    }
  }, 60_000);

  test("a predicate written into the definition is refused on a hypertable, logged, and nothing is built", async () => {
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      const inline = { name: "hyper_events_inline", table: "hyper.events", definition: "(created_at) WHERE id > 0" };
      expect(await ensureConcurrentIndexes([inline], options)).toBe("failed");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
    const [row] = await sql<{ present: boolean }[]>`SELECT to_regclass('hyper.hyper_events_inline') IS NOT NULL AS present`;
    expect(row!.present).toBe(false);
  });
});
