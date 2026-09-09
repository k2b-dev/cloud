import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { defaultRailPreferences } from "../contracts/rail-preferences";
import { createRailPreferencesService } from "./rail-preferences";

const url = process.env.CLOUD_RAIL_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite("Core rail preferences persistence", () => {
  let db: SQL;
  let service: ReturnType<typeof createRailPreferencesService>;
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  beforeAll(async () => {
    const target = new URL(url!);
    if (target.pathname !== "/cloud_rail_test" || !["localhost", "127.0.0.1"].includes(target.hostname))
      throw new Error("Dedicated local cloud_rail_test database required");
    db = new SQL(url!);
    await db`CREATE SCHEMA IF NOT EXISTS auth`.simple();
    await db`CREATE TABLE IF NOT EXISTS auth.users (id UUID PRIMARY KEY)`.simple();
    const { migrate } = await import("../../../core/src/migrate/core/rail-preferences");
    await migrate(db);
    await migrate(db);
    await db`INSERT INTO auth.users(id) VALUES (${first}::uuid), (${second}::uuid)`;
    service = createRailPreferencesService(db);
  });
  afterAll(async () => {
    if (db) {
      await db`DELETE FROM auth.users WHERE id IN (${first}::uuid, ${second}::uuid)`;
      await db.close();
    }
  });
  test("round trips independently, rejects concurrent stale writes and cascades account deletion", async () => {
    expect(await service.get(first)).toEqual(defaultRailPreferences());
    const input = { ...defaultRailPreferences(), visibility: { mail: false } };
    const writes = await Promise.all([service.save(first, input), service.save(first, input)]);
    expect(writes.filter(Boolean)).toHaveLength(1);
    expect(await service.get(first)).toEqual({ ...input, revision: 1 });
    expect(await service.get(second)).toEqual(defaultRailPreferences());
    expect(await service.save(second, { ...input, revision: 8 })).toBeNull();
    const reset = await service.save(first, { ...defaultRailPreferences(), revision: 1 });
    expect(reset?.revision).toBe(2);
    expect(await service.save(first, { ...input, revision: 1 })).toBeNull();
    await db`DELETE FROM auth.users WHERE id = ${first}::uuid`;
    expect(await db`SELECT * FROM auth.rail_preferences WHERE user_id = ${first}::uuid`).toHaveLength(0);
  });
});
