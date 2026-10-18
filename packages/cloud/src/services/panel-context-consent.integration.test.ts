import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { createDisposableDatabase, databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { createPanelContextConsentService, PanelConsentCancelled } from "./panel-context-consent";

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
  test("answers are per person/provider, insert only once and cascade on account deletion", async () => {
    expect(await service.get(first, "fixture")).toBeNull();
    expect(await service.list(first, [])).toEqual({});
    expect(await service.set(first, "fixture", true, 1)).toBeNull();
    expect(await service.get(first, "fixture")).toBeNull();
    const inserted = await Promise.all([service.set(first, "fixture", true, 0), service.set(first, "fixture", true, 0)]);
    expect(inserted.filter(Boolean)).toEqual([{ allowed: true, revision: 1 }]);
    expect(inserted.filter((answer) => answer === null)).toHaveLength(1);
    expect(await service.set(first, "other", false, 0)).toEqual({ allowed: false, revision: 1 });
    expect(await service.get(second, "fixture")).toBeNull();
    expect(await service.list(first, ["fixture", "other"])).toEqual({
      fixture: { allowed: true, revision: 1 },
      other: { allowed: false, revision: 1 },
    });
    expect(await service.list(second, ["fixture", "other"])).toEqual({});
    expect(await db`SELECT * FROM auth.panel_context_consent WHERE user_id = ${first}::uuid AND provider = 'fixture'`).toHaveLength(1);
    expect(await service.set(first, "fixture", false, 1)).toEqual({ allowed: false, revision: 2 });
    expect(await service.set(first, "fixture", true, 1)).toBeNull();
    expect(await service.get(first, "fixture")).toEqual({ allowed: false, revision: 2 });
    expect(await service.set(second, "fixture", true, 0)).toEqual({ allowed: true, revision: 1 });
    await db`DELETE FROM auth.users WHERE id = ${first}::uuid`;
    expect(await service.list(first, ["fixture", "other"])).toEqual({});
    expect(await service.get(second, "fixture")).toEqual({ allowed: true, revision: 1 });
    await expect(
      db`INSERT INTO auth.panel_context_consent (user_id, provider, allowed, revision) VALUES (${second}::uuid, ${"a".repeat(81)}, true, 1)`,
    ).rejects.toThrow();
    await expect(
      db`INSERT INTO auth.panel_context_consent (user_id, provider, allowed, revision) VALUES (${second}::uuid, 'invalid', true, 0)`,
    ).rejects.toThrow();
  });
  test("a delayed withdrawal cannot overwrite a newer Allow saved from the same revision", async () => {
    expect(await service.set(second, "delayed", true, 0)).toEqual({ allowed: true, revision: 1 });
    expect(await service.set(second, "delayed", true, 1)).toEqual({ allowed: true, revision: 2 });
    const [before] = await db`SELECT updated_at FROM auth.panel_context_consent WHERE user_id = ${second}::uuid AND provider = 'delayed'`;
    expect(await service.set(second, "delayed", false, 1)).toBeNull();
    expect(await service.get(second, "delayed")).toEqual({ allowed: true, revision: 2 });
    const [after] = await db`SELECT updated_at FROM auth.panel_context_consent WHERE user_id = ${second}::uuid AND provider = 'delayed'`;
    expect(after.updated_at).toEqual(before.updated_at);
  });
  test("a save whose request was cancelled is rolled back, so it cannot land after the browser gave up", async () => {
    expect(await service.set(second, "cancelled", true, 0)).toEqual({ allowed: true, revision: 1 });
    const gaveUp = new AbortController();
    gaveUp.abort();
    await expect(service.set(second, "cancelled", false, 1, gaveUp.signal)).rejects.toBeInstanceOf(PanelConsentCancelled);
    expect(await service.get(second, "cancelled")).toEqual({ allowed: true, revision: 1 });
  });
});
