import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { createDisposableDatabase, databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { createPanelContextConsentService } from "./panel-context-consent";

const suite = databaseSuite();
suite("Core panel consent persistence", () => {
  let db: SQL;
  let disposable: Awaited<ReturnType<typeof createDisposableDatabase>>;
  let service: ReturnType<typeof createPanelContextConsentService>;
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  beforeAll(async () => {
    disposable = await createDisposableDatabase("panel_context_consent");
    db = new SQL(disposable.url);
    await db`CREATE SCHEMA auth`.simple();
    await db`CREATE TABLE auth.users (id UUID PRIMARY KEY)`.simple();
    const { migrate } = await import("../../../core/src/migrate/core/panel-context-consent");
    await migrate(db);
    await migrate(db);
    await db`INSERT INTO auth.users (id) VALUES (${first}::uuid), (${second}::uuid)`;
    service = createPanelContextConsentService(db);
  });
  afterAll(async () => {
    await db?.close();
    await disposable?.drop();
  });
  test("answers are per person/provider, unique, idempotent and cascade on account deletion", async () => {
    expect(await service.get(first, "fixture")).toBeNull();
    expect(await service.list(first, [])).toEqual({});
    await Promise.all([service.set(first, "fixture", true), service.set(first, "fixture", true)]);
    expect(await service.set(first, "other", false)).toBe(false);
    expect(await service.get(second, "fixture")).toBeNull();
    expect(await service.list(first, ["fixture", "other"])).toEqual({ fixture: true, other: false });
    expect(await service.list(second, ["fixture", "other"])).toEqual({});
    expect(await db`SELECT * FROM auth.panel_context_consent WHERE user_id = ${first}::uuid AND provider = 'fixture'`).toHaveLength(1);
    expect(await service.set(first, "fixture", false)).toBe(false);
    expect(await service.get(first, "fixture")).toBe(false);
    await service.set(second, "fixture", true);
    await db`DELETE FROM auth.users WHERE id = ${first}::uuid`;
    expect(await service.list(first, ["fixture", "other"])).toEqual({});
    expect(await service.get(second, "fixture")).toBe(true);
    await expect(
      db`INSERT INTO auth.panel_context_consent (user_id, provider, allowed) VALUES (${second}::uuid, ${"a".repeat(81)}, true)`,
    ).rejects.toThrow();
  });
});
