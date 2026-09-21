import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { createDisposableDatabase, databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { defaultRailPreferences } from "../contracts/rail-preferences";
import { createRailPreferencesService } from "./rail-preferences";

const suite = databaseSuite();
suite("Core rail preferences persistence", () => {
  let db: SQL;
  let disposable: Awaited<ReturnType<typeof createDisposableDatabase>>;
  let service: ReturnType<typeof createRailPreferencesService>;
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  beforeAll(async () => {
    disposable = await createDisposableDatabase("rail_preferences");
    db = new SQL(disposable.url);
    await db`CREATE SCHEMA IF NOT EXISTS auth`.simple();
    await db`CREATE TABLE IF NOT EXISTS auth.users (id UUID PRIMARY KEY, uid TEXT NOT NULL, provider TEXT NOT NULL, profile TEXT NOT NULL)`.simple();
    const { migrate } = await import("../../../core/src/migrate/core/rail-preferences");
    await migrate(db);
    await migrate(db);
    await db`INSERT INTO auth.users(id, uid, provider, profile) VALUES (${first}::uuid, ${first}, 'local', 'user'), (${second}::uuid, ${second}, 'local', 'user')`;
    service = createRailPreferencesService(db);
  });
  afterAll(async () => {
    if (db) {
      await db`DELETE FROM auth.users WHERE id IN (${first}::uuid, ${second}::uuid)`;
      await db.close();
      await disposable.drop();
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
