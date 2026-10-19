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

  test("adds the notice column once, marks old rows announced, and bounds JSONB to 1024 bytes", async () => {
    await migrate();
    // Model the schema shipped before the notice, in this file's fresh database only.
    await sql`ALTER TABLE auth.known_browsers DROP COLUMN notice`.simple();
    const id = crypto.randomUUID();
    const firstSeen = new Date("2026-10-16T07:14:00.000Z");
    setSystemTime(firstSeen);
    await sql`INSERT INTO auth.users (id) VALUES (${id}::uuid)`;
    await sql`INSERT INTO auth.known_browsers (user_id, browser_hash, browser, os, first_seen_at, last_seen_at)
      VALUES (${id}::uuid, ${Buffer.alloc(32, 1)}, 'chrome', 'macos', ${firstSeen}, ${firstSeen})`;
    await migrate();
    expect(
      await sql<
        { notified_at: Date | null; notice: unknown }[]
      >`SELECT notified_at, notice FROM auth.known_browsers WHERE user_id = ${id}::uuid`,
    ).toEqual([{ notified_at: firstSeen, notice: null }]);
    const snapshot = { signedInAt: firstSeen.toISOString() };
    await sql`INSERT INTO auth.known_browsers (user_id, browser_hash, browser, os, first_seen_at, last_seen_at, notice)
      VALUES (${id}::uuid, ${Buffer.alloc(32, 2)}, 'chrome', 'macos', ${firstSeen}, ${firstSeen}, ${JSON.stringify(snapshot)}::text::jsonb)`;
    const before = await sql`SELECT id, notified_at, notice FROM auth.known_browsers WHERE user_id = ${id}::uuid ORDER BY browser_hash`;
    await migrate();
    expect(await sql`SELECT id, notified_at, notice FROM auth.known_browsers WHERE user_id = ${id}::uuid ORDER BY browser_hash`).toEqual(
      before,
    );
    expect(before[1]).toMatchObject({ notified_at: null, notice: snapshot });
    // A Bun SQL query runs once awaited; `expect().rejects` alone would never start it.
    await expect(
      (async () =>
        await sql`UPDATE auth.known_browsers SET notice = ${JSON.stringify({ value: "界".repeat(400) })}::text::jsonb WHERE user_id = ${id}::uuid`)(),
    ).rejects.toThrow();
    expect(await sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'auth' AND indexname = 'known_browsers_unnotified'`).toHaveLength(
      1,
    );
    await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });
});
