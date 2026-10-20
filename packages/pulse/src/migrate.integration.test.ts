import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { createDisposableDatabase, testInfra } from "../../../scripts/fixtures/test-infra";
import { migrate } from "./migrate";

const enabled = testInfra.database !== undefined;
const databaseTest = enabled ? test : test.skip;

let database: Awaited<ReturnType<typeof createDisposableDatabase>> | undefined;

// Installation tests drop whole schemas, so they own a private database. The
// default `sql` connects lazily to `DATABASE_URL`, which only works when this
// file is the first database user in its process (`bun test --isolate`).
beforeAll(async () => {
  if (!enabled) return;
  database = await createDisposableDatabase("pulse_schema");
  process.env.DATABASE_URL = database.url;
  const [row] = await sql`SELECT current_database() AS name`;
  if (row?.name !== database.name) throw new Error("Schema tests need their own database; run this file in its own process");
  await sql`DROP SCHEMA IF EXISTS pulse CASCADE`.simple();
  await sql`DROP SCHEMA IF EXISTS auth CASCADE`.simple();
});

afterAll(async () => {
  if (!database) return;
  await sql.close();
  await database.drop();
});

describe("versioned Pulse migrations", () => {
  databaseTest(
    "rolls back an incomplete installation",
    async () => {
      await expect(migrate()).rejects.toThrow();
      const [row] = await sql`SELECT to_regnamespace('pulse') IS NULL AS absent`;
      expect(row?.absent).toBe(true);
    },
    30_000,
  );

  databaseTest(
    "installs once under concurrent starts and preserves existing data on restart",
    async () => {
      await sql`CREATE SCHEMA auth`.simple();
      await sql`CREATE TABLE auth.users (id UUID PRIMARY KEY)`.simple();
      await sql`CREATE TABLE auth.access (id UUID PRIMARY KEY)`.simple();
      await Promise.all([migrate(), migrate()]);
      expect(await sql<{ version: number; name: string }[]>`SELECT version, name FROM pulse.schema_migrations ORDER BY version`).toEqual([
        { version: 1, name: "baseline" },
        { version: 2, name: "base_stores" },
      ]);
      await sql`INSERT INTO pulse.bases (short_id, name) VALUES ('Test01', 'Preserved')`;
      await migrate();
      const [row] = await sql`SELECT name FROM pulse.bases WHERE short_id = 'Test01'`;
      expect(row?.name).toBe("Preserved");
      const [installation] = await sql`SELECT count(*)::int AS count FROM pulse.installation`;
      expect(installation?.count).toBe(1);
      const [sensitiveIndex] =
        await sql`SELECT indexdef FROM pg_indexes WHERE schemaname='pulse' AND indexname='idx_pulse_events_sensitive_retention'`;
      expect(sensitiveIndex?.indexdef).toContain("(base_id, ts)");
      expect(sensitiveIndex?.indexdef).toContain("WHERE (sensitive <> '{}'::jsonb)");
      const [recentIndex] =
        await sql`SELECT indexdef FROM pg_indexes WHERE schemaname='pulse' AND indexname='idx_pulse_events_base_recent'`;
      expect(recentIndex?.indexdef).toContain("(base_id, ts DESC, recorded_at DESC)");
      await expect(Promise.resolve(sql`SELECT 'histogram'::pulse.metric_type`)).rejects.toThrow();
      await expect(
        Promise.resolve(
          sql`INSERT INTO pulse.sources(short_id,base_id,kind,name,scrape_interval_seconds) SELECT 'Test02',id,'metrics','Invalid interval',90 FROM pulse.bases WHERE short_id='Test01'`,
        ),
      ).rejects.toThrow();
      await expect(Promise.resolve(sql`INSERT INTO pulse.bases (short_id, name) VALUES ('bad', 'Invalid')`)).rejects.toThrow();
      await expect(
        Promise.resolve(sql`INSERT INTO pulse.bases (short_id, name, retention_days) VALUES ('Test02', 'Invalid', 0)`),
      ).rejects.toThrow();
    },
    30_000,
  );

  databaseTest("adopts an old installation without replaying baseline DDL", async () => {
    await sql`DROP TABLE pulse.base_internal_targets,pulse.base_stores,pulse.store_instance`.simple();
    await sql`DROP TABLE pulse.schema_migrations`.simple();
    await sql`INSERT INTO pulse.bases (short_id, name) VALUES ('Old001', 'Sentinel')`;
    await sql`DROP INDEX pulse.idx_pulse_bases_created_by`.simple();
    await migrate();
    expect(await sql<{ version: number; name: string }[]>`SELECT version, name FROM pulse.schema_migrations`).toEqual([
      { version: 1, name: "baseline" },
      { version: 2, name: "base_stores" },
    ]);
    const [row] = await sql`SELECT name FROM pulse.bases WHERE short_id='Old001'`;
    expect(row?.name).toBe("Sentinel");
    const [index] = await sql`SELECT to_regclass('pulse.idx_pulse_bases_created_by') IS NULL AS absent`;
    expect(index?.absent).toBe(true);
  });

  databaseTest("upgrades a version-one ledger without backfilling existing bases", async () => {
    await sql`DROP TABLE pulse.base_internal_targets,pulse.base_stores,pulse.store_instance`.simple();
    await sql`DELETE FROM pulse.schema_migrations WHERE version=2`;
    await migrate();
    expect(await sql<{ version: number; name: string }[]>`SELECT version,name FROM pulse.schema_migrations ORDER BY version`).toEqual([
      { version: 1, name: "baseline" },
      { version: 2, name: "base_stores" },
    ]);
    const [count] = await sql`SELECT count(*)::int AS n FROM pulse.base_stores`;
    expect(count?.n).toBe(0);
  });

  databaseTest("refuses a future ledger version without changing data or the ledger", async () => {
    await sql`INSERT INTO pulse.schema_migrations (version, name) VALUES (99, 'future')`;
    const before = await sql`SELECT * FROM pulse.schema_migrations ORDER BY version`;
    await expect(migrate()).rejects.toThrow("version 99 is unknown: this image is older than the database");
    expect(await sql`SELECT * FROM pulse.schema_migrations ORDER BY version`).toEqual(before);
    const [row] = await sql`SELECT name FROM pulse.bases WHERE short_id='Old001'`;
    expect(row?.name).toBe("Sentinel");
  });

  databaseTest(
    "rejects an existing Alpha schema without changing its data",
    async () => {
      await sql`DROP SCHEMA pulse CASCADE`.simple();
      await sql`CREATE SCHEMA pulse`.simple();
      await sql`CREATE TABLE pulse.alpha_fixture (value TEXT)`.simple();
      await sql`INSERT INTO pulse.alpha_fixture VALUES ('untouched')`;
      await expect(migrate()).rejects.toThrow("requires a fresh schema");
      const [row] = await sql`SELECT value FROM pulse.alpha_fixture`;
      expect(row?.value).toBe("untouched");
    },
    30_000,
  );
});
