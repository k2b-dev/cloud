import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { Hono } from "hono";
import { createDisposableDatabase, databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { person } from "../_internal/define-app.test-fixture";
import { createMeScreenRoutes } from "../api/me-screen";
import { defaultScreenPreferences } from "../contracts/screen-preferences";
import type { AuthContext } from "../server";
import { createScreenPreferencesService } from "./screen-preferences";

const suite = databaseSuite();
suite("Core screen preferences persistence", () => {
  let db: SQL;
  let disposable: Awaited<ReturnType<typeof createDisposableDatabase>>;
  let service: ReturnType<typeof createScreenPreferencesService>;
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  beforeAll(async () => {
    disposable = await createDisposableDatabase("screen_preferences");
    db = new SQL(disposable.url);
    await db`CREATE SCHEMA IF NOT EXISTS auth`.simple();
    await db`CREATE TABLE IF NOT EXISTS auth.users (id UUID PRIMARY KEY, uid TEXT NOT NULL, provider TEXT NOT NULL, profile TEXT NOT NULL)`.simple();
    const { migrate } = await import("../../../core/src/migrate/core/screen-preferences");
    await migrate(db);
    await migrate(db);
    await db`INSERT INTO auth.users(id, uid, provider, profile) VALUES (${first}::uuid, ${first}, 'local', 'user'), (${second}::uuid, ${second}, 'local', 'user')`;
    service = createScreenPreferencesService(db);
  });
  afterAll(async () => {
    if (db) {
      await db`DELETE FROM auth.users WHERE id IN (${first}::uuid, ${second}::uuid)`;
      await db.close();
      await disposable.drop();
    }
  });

  test("defaults to two minutes, saves per person, reads unknown values as the default and cascades account deletion", async () => {
    expect(await service.get(first)).toEqual({ privacyTimerSeconds: 120 });
    expect(await service.save(first, { privacyTimerSeconds: 0 })).toEqual({ privacyTimerSeconds: 0 });
    expect(await service.save(first, { privacyTimerSeconds: 30 })).toEqual({ privacyTimerSeconds: 30 });
    expect(await service.get(first)).toEqual({ privacyTimerSeconds: 30 });
    expect(await service.get(second)).toEqual(defaultScreenPreferences());
    // A value a later release might offer reads as the default here instead of failing the page.
    await db`INSERT INTO auth.screen_preferences (user_id, privacy_timer_seconds) VALUES (${second}::uuid, 900)`;
    expect(await service.get(second)).toEqual(defaultScreenPreferences());
    await db`DELETE FROM auth.users WHERE id = ${first}::uuid`;
    expect(await db`SELECT * FROM auth.screen_preferences WHERE user_id = ${first}::uuid`).toHaveLength(0);
  });

  test("the route saves only the signed-in person's choice and refuses other values", async () => {
    const app = new Hono<AuthContext>()
      .use(async (c, next) => {
        c.set("user", { ...person, id: second });
        await next();
      })
      .route("/", createMeScreenRoutes(service));
    const put = (body: unknown) =>
      app.request("/screen", { method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
    expect((await put({ privacyTimerSeconds: 45 })).status).toBe(400);
    expect((await put({ privacyTimerSeconds: 60, other: true })).status).toBe(400);
    const saved = await put({ privacyTimerSeconds: 60 });
    expect(saved.status).toBe(200);
    expect(saved.headers.get("Cache-Control")).toBe("no-store");
    expect(await saved.json()).toEqual({ privacyTimerSeconds: 60 });
    expect(await (await app.request("/screen")).json()).toEqual({ privacyTimerSeconds: 60 });
  });
});
