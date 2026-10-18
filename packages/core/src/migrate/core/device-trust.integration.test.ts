import { afterAll, afterEach, beforeAll, expect, setSystemTime, test } from "bun:test";
import { trustState } from "@k2b/cloud/services/known-browsers";
import { sql } from "bun";
import { databaseSuite, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { migrate } from "./device-trust";

const suite = databaseSuite();
const DAY = 86_400_000;

suite("Core device-trust migration", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  beforeAll(async () => {
    database = await useFreshDatabase("device_trust");
    // This migration needs only the auth schema and the referenced account key.
    await sql`CREATE SCHEMA auth`.simple();
    await sql`CREATE TABLE auth.users (id uuid PRIMARY KEY)`.simple();
  });
  afterEach(() => setSystemTime());
  afterAll(async () => {
    await database?.drop();
  });

  test("concurrent first migrations create one immutable installation start and all tables", async () => {
    await Promise.all(Array.from({ length: 5 }, () => migrate()));
    const [initial] = await sql<{ started_at: Date }[]>`SELECT started_at FROM auth.device_trust_state`;
    expect(initial).toBeDefined();
    const startedAt = initial!.started_at;
    // Postgres owns migration now(); freeze JS relative to that exact stored value.
    setSystemTime(new Date(startedAt.getTime() + 13 * DAY));
    expect(await trustState(sql, new Date())).toEqual({ startedAt, geoipSince: null, introActive: true });
    setSystemTime(new Date(startedAt.getTime() + 14 * DAY));
    expect((await trustState(sql, new Date())).introActive).toBe(false);
    setSystemTime(new Date(startedAt.getTime() + 40 * DAY));
    await Promise.all([migrate(), migrate(), migrate()]);
    expect(await sql<{ started_at: Date }[]>`SELECT started_at FROM auth.device_trust_state`).toEqual([{ started_at: startedAt }]);
    expect((await trustState(sql, new Date())).introActive).toBe(false);
    expect(await sql`SELECT * FROM auth.known_browsers`).toHaveLength(0);
    expect(await sql`SELECT * FROM auth.sign_in_countries`).toHaveLength(0);
  });

  test("missing installation state keeps the introduction active without writing", async () => {
    await sql
      .begin(async (tx) => {
        await tx`DELETE FROM auth.device_trust_state`;
        setSystemTime(new Date("2026-10-18T12:00:00Z"));
        expect(await trustState(tx, new Date())).toEqual({ startedAt: null, geoipSince: null, introActive: true });
        expect(await tx`SELECT * FROM auth.device_trust_state`).toHaveLength(0);
        throw new Error("rollback missing state");
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== "rollback missing state") throw error;
      });
  });
});
