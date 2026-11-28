import { afterAll, expect, spyOn, test } from "bun:test";
import { SQL } from "bun";
import { databaseSuite, testInfra, useMigratedDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAppEvents } from "../../../core/src/migrate/core/app-events";
import { migrate as migrateAudit } from "../../../core/src/migrate/core/audit";
import { migrate as migrateEvents } from "../../../core/src/migrate/core/events";
import { migrate as migrateLogging } from "../../../core/src/migrate/core/logging";
import { migrate as migrateWorkflows } from "../../../core/src/migrate/core/workflows";
import { migrateCloudAi } from "../ai/migrate";
import { sql } from "../runtime/clients";
import { addColumns, createIndexes, MIGRATION_LOCK_WAIT_MS, replaceTrigger } from "./migration-ddl";

const database = testInfra.database ? await useMigratedDatabase("migration_ddl") : undefined;
afterAll(async () => {
  await sql.close();
  await database?.drop();
});

/** A session that holds `mode` on `table` until `release()`, the way a dump (ACCESS SHARE) or an index build does. */
const holdLock = async (table: string, mode: string, application = "pg_dump") => {
  const holder = new SQL({ url: database!.url, max: 1, connection: { application_name: application } });
  await holder.unsafe(`BEGIN; LOCK TABLE ${table} IN ${mode} MODE`).simple();
  return {
    release: async () => {
      await holder`ROLLBACK`.simple();
      await holder.close();
    },
  };
};

const elapsed = async (run: () => Promise<unknown>) => {
  const started = performance.now();
  await run();
  return performance.now() - started;
};

/** Resolves with the time `run` took, or rejects after `limitMs` without waiting for it. */
const within = <T>(limitMs: number, run: Promise<T>) =>
  Promise.race([run, Bun.sleep(limitMs).then(() => Promise.reject(new Error(`still waiting after ${limitMs} ms`)))]);

databaseSuite()("startup migrations next to a dump or an index build", () => {
  // The issue's reproduction: Core's AI migration on an installation that already has every column and index.
  test("migrateCloudAi takes no lock on ai.conversations and lets its writers through", async () => {
    // A writer that keeps one conversation row locked: the start must not rewrite every row (#4515).
    const shortId = `held-${crypto.randomUUID()}`;
    await sql`INSERT INTO ai.conversations (short_id) VALUES (${shortId})`;
    const rowWriter = new SQL({ url: database!.url, max: 1 });
    await rowWriter`BEGIN`.simple();
    await rowWriter`SELECT 1 FROM ai.conversations WHERE short_id = ${shortId} FOR UPDATE`;
    const dump = await holdLock("ai.conversations", "ACCESS SHARE");
    const build = await holdLock("ai.conversations", "SHARE UPDATE EXCLUSIVE", "index build");
    const migration = migrateCloudAi();
    try {
      await Bun.sleep(200);
      const insert = elapsed(() => sql`INSERT INTO ai.conversations (short_id) VALUES (${`lock-${crypto.randomUUID()}`})`);
      expect(await within(MIGRATION_LOCK_WAIT_MS, insert)).toBeLessThan(MIGRATION_LOCK_WAIT_MS);
      await within(30_000, migration);
    } finally {
      await dump.release();
      await build.release();
      await rowWriter`ROLLBACK`.simple();
      await rowWriter.close();
      await migration.catch(() => undefined);
    }
  }, 60_000);

  // A rewrite that fails must not leave its cause behind: the next start sees the change again and rewrites (#4515).
  test("a search rewrite that fails is retried on the next start", async () => {
    const shortId = `stale-${crypto.randomUUID()}`;
    // An older function body, as before an upgrade: rows it wrote carry its stale search text.
    await sql`CREATE OR REPLACE FUNCTION ai.refresh_conversation_search() RETURNS trigger AS $$
      BEGIN NEW.search_text := 'stale'; RETURN NEW; END $$ LANGUAGE plpgsql`.simple();
    await sql`INSERT INTO ai.conversations (short_id, title) VALUES (${shortId}, 'Fresh title')`;
    const searchText = async () =>
      (await sql<{ text: string }[]>`SELECT search_text AS text FROM ai.conversations WHERE short_id = ${shortId}`)[0]?.text;
    expect(await searchText()).toBe("stale");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const rowWriter = new SQL({ url: database!.url, max: 1 });
    try {
      await rowWriter`BEGIN`.simple();
      await rowWriter`SELECT 1 FROM ai.conversations WHERE short_id = ${shortId} FOR UPDATE`;
      await expect(migrateCloudAi()).rejects.toThrow("could not lock ai.conversations");
    } finally {
      await rowWriter`ROLLBACK`.simple();
      await rowWriter.close();
      warn.mockRestore();
    }
    await migrateCloudAi();
    expect(await searchText()).toContain("Fresh title");
  }, 120_000);

  // Tables other processes write all the time: logs, audit, workflow runs and both outboxes.
  test("Core's migrations of the busiest tables take no lock once applied", async () => {
    const tables = [
      "logging.entries",
      "logging.trace_spans",
      "audit.events",
      "workflows.version",
      "workflows.event",
      "workflows.run",
      "workflows.step_outcome",
      "events.outbox",
      "events.app_subscriptions",
      "events.app_deliveries",
    ];
    const holders = await Promise.all(
      tables.flatMap((table) => [holdLock(table, "ACCESS SHARE"), holdLock(table, "SHARE UPDATE EXCLUSIVE", "index build")]),
    );
    const migrations = (async () => {
      await migrateLogging();
      await migrateAudit();
      await migrateWorkflows();
      await migrateEvents();
      await migrateAppEvents();
    })();
    try {
      await within(30_000, migrations);
    } finally {
      for (const holder of holders) await holder.release();
      await migrations.catch(() => undefined);
    }
  }, 60_000);
});

databaseSuite()("migration DDL helpers", () => {
  const table = "ddl_probe.items";
  const setup = async () => {
    await sql`DROP SCHEMA IF EXISTS ddl_probe CASCADE`.simple();
    await sql`CREATE SCHEMA ddl_probe`.simple();
    await sql`CREATE TABLE ddl_probe.items (id INT PRIMARY KEY, name TEXT)`.simple();
  };

  test("adds only missing columns and takes no lock once they exist", async () => {
    await setup();
    expect(await addColumns(sql, table, { name: "TEXT", note: "TEXT NOT NULL DEFAULT ''", rank: "INT" })).toEqual(["note", "rank"]);
    const dump = await holdLock(table, "ACCESS SHARE");
    try {
      expect(await within(1_000, addColumns(sql, table, { note: "TEXT", rank: "INT" }))).toEqual([]);
    } finally {
      await dump.release();
    }
  });

  test("a missing column waits in bounded steps and never queues writers for longer than one step", async () => {
    await setup();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const dump = await holdLock(table, "ACCESS SHARE");
    const adding = addColumns(sql, table, { late: "TEXT" });
    try {
      await Bun.sleep(200);
      const insert = elapsed(() => sql`INSERT INTO ddl_probe.items (id) VALUES (1)`);
      expect(await within(MIGRATION_LOCK_WAIT_MS + 1_000, insert)).toBeLessThan(MIGRATION_LOCK_WAIT_MS + 500);
      // Wait for the first lock timeout, then let the "dump" finish.
      await Bun.sleep(MIGRATION_LOCK_WAIT_MS);
    } finally {
      await dump.release();
    }
    expect(await within(15_000, adding)).toEqual(["late"]);
    const logged = JSON.stringify(warn.mock.calls);
    warn.mockRestore();
    expect(logged).toContain("Migration waits for a lock");
    expect(logged).toContain("pg_dump");
  }, 30_000);

  test("inside a transaction the caller's lock timeout applies once, without retry", async () => {
    await setup();
    const dump = await holdLock(table, "ACCESS SHARE");
    try {
      const attempt = sql.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '200ms'`.simple();
        await addColumns(tx, table, { late: "TEXT" });
      });
      await expect(within(5_000, attempt)).rejects.toMatchObject({ errno: "55P03" });
    } finally {
      await dump.release();
    }
  });

  test("creates only missing indexes and takes no lock once they exist", async () => {
    await setup();
    const indexes = [
      { name: "ddl_probe_items_name", definition: "(name)" },
      { name: "ddl_probe_items_name_unique", definition: "(name) WHERE name IS NOT NULL", unique: true },
    ];
    expect(await createIndexes(sql, table, indexes)).toEqual(["ddl_probe_items_name", "ddl_probe_items_name_unique"]);
    const build = await holdLock(table, "SHARE UPDATE EXCLUSIVE", "index build");
    try {
      expect(await within(1_000, createIndexes(sql, table, indexes))).toEqual([]);
    } finally {
      await build.release();
    }
  });

  test("replaces a trigger only when its definition differs", async () => {
    await setup();
    await sql`CREATE OR REPLACE FUNCTION ddl_probe.touch() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'`.simple();
    const first = "CREATE TRIGGER items_touch BEFORE UPDATE ON ddl_probe.items FOR EACH ROW EXECUTE FUNCTION ddl_probe.touch()";
    const second = "CREATE TRIGGER items_touch BEFORE INSERT OR UPDATE ON ddl_probe.items FOR EACH ROW EXECUTE FUNCTION ddl_probe.touch()";
    expect(await replaceTrigger(sql, table, "items_touch", first)).toBe(true);
    const dump = await holdLock(table, "ACCESS SHARE");
    try {
      expect(await within(1_000, replaceTrigger(sql, table, "items_touch", first))).toBe(false);
    } finally {
      await dump.release();
    }
    expect(await replaceTrigger(sql, table, "items_touch", second)).toBe(true);
    const [trigger] = await sql<{ definition: string }[]>`SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger
      WHERE tgrelid = 'ddl_probe.items'::regclass AND tgname = 'items_touch'`;
    expect(trigger?.definition).toBe(second);
  });

  test("rejects names that are not plain identifiers before any SQL", async () => {
    await expect(addColumns(sql, "ddl_probe.items; DROP TABLE x", { a: "TEXT" })).rejects.toThrow("schema-qualified");
    await expect(addColumns(sql, table, { "a; DROP TABLE x": "TEXT" })).rejects.toThrow("plain lowercase");
    await expect(createIndexes(sql, table, [{ name: "Bad Name", definition: "(id)" }])).rejects.toThrow("plain lowercase");
    await expect(addColumns(sql, table, { a: "TEXT; DROP TABLE x" })).rejects.toThrow("without");
    await expect(addColumns(sql, table, { a: "TEXT -- hidden" })).rejects.toThrow("without");
    await expect(createIndexes(sql, table, [{ name: "i", definition: "(id) /* hidden */" }])).rejects.toThrow("without");
  });
});
