import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { initializeSchema } from "./schema";

const enabled = process.env.PULSE_SCHEMA_DB_TEST === "1";
const databaseTest = enabled ? test : test.skip;

const assertDisposableDatabase = async () => {
  const [row] = await sql`SELECT current_database() AS name`;
  if (row?.name !== "pulse_schema_test") throw new Error("Schema tests require the dedicated pulse_schema_test database");
};

beforeAll(async () => {
  if (!enabled) return;
  await assertDisposableDatabase();
  await sql`DROP SCHEMA IF EXISTS pulse CASCADE`.simple();
  await sql`DROP SCHEMA IF EXISTS auth CASCADE`.simple();
});

afterAll(async () => {
  if (!enabled) return;
  await assertDisposableDatabase();
  await sql`DROP SCHEMA IF EXISTS pulse CASCADE`.simple();
  await sql`DROP SCHEMA IF EXISTS auth CASCADE`.simple();
  await sql.close();
});

describe("fresh Pulse installation", () => {
  databaseTest(
    "rolls back an incomplete installation",
    async () => {
      await assertDisposableDatabase();
      await expect(initializeSchema()).rejects.toThrow();
      const [row] = await sql`SELECT to_regnamespace('pulse') IS NULL AS absent`;
      expect(row?.absent).toBe(true);
    },
    30_000,
  );

  databaseTest(
    "installs once under concurrent starts and preserves existing data on restart",
    async () => {
      await assertDisposableDatabase();
      await sql`CREATE SCHEMA auth`.simple();
      await sql`CREATE TABLE auth.users (id UUID PRIMARY KEY)`.simple();
      await sql`CREATE TABLE auth.access (id UUID PRIMARY KEY)`.simple();
      await Promise.all([initializeSchema(), initializeSchema()]);
      await sql`INSERT INTO pulse.bases (short_id, name) VALUES ('Test01', 'Preserved')`;
      await initializeSchema();
      const [row] = await sql`SELECT name FROM pulse.bases WHERE short_id = 'Test01'`;
      expect(row?.name).toBe("Preserved");
      const [installation] = await sql`SELECT count(*)::int AS count FROM pulse.installation`;
      expect(installation?.count).toBe(1);
      await expect(Promise.resolve(sql`INSERT INTO pulse.bases (short_id, name) VALUES ('bad', 'Invalid')`)).rejects.toThrow();
      await expect(
        Promise.resolve(sql`INSERT INTO pulse.bases (short_id, name, retention_days) VALUES ('Test02', 'Invalid', 0)`),
      ).rejects.toThrow();
    },
    30_000,
  );

  databaseTest(
    "rejects an existing Alpha schema without changing its data",
    async () => {
      await assertDisposableDatabase();
      await sql`DROP SCHEMA pulse CASCADE`.simple();
      await sql`CREATE SCHEMA pulse`.simple();
      await sql`CREATE TABLE pulse.alpha_fixture (value TEXT)`.simple();
      await sql`INSERT INTO pulse.alpha_fixture VALUES ('untouched')`;
      await expect(initializeSchema()).rejects.toThrow("requires a fresh schema");
      const [row] = await sql`SELECT value FROM pulse.alpha_fixture`;
      expect(row?.value).toBe("untouched");
    },
    30_000,
  );
});
