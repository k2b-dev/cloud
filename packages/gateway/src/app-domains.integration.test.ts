import { afterAll, beforeAll, expect, test } from "bun:test";
import { APP_DOMAINS_DDL, readAppDomains } from "@k2b/cloud/contracts/app-domains";
import { SQL } from "bun";
import { createDisposableDatabase, suiteFor } from "../../../scripts/fixtures/test-infra";

suiteFor("database")("durable app domain assignments", () => {
  let db: SQL;
  let database: Awaited<ReturnType<typeof createDisposableDatabase>>;
  beforeAll(async () => {
    database = await createDisposableDatabase("gateway_domains");
    db = new SQL(database.url);
    await db`CREATE SCHEMA settings`;
  });
  afterAll(async () => {
    await db?.close();
    await database?.drop();
  });
  test("a gateway deployed before Core's migration has no assignments", async () => {
    expect(await readAppDomains(db)).toEqual([]);
  });
  test("Core's table preserves assignments independently of application presence", async () => {
    await db.unsafe(APP_DOMAINS_DDL);
    await db`INSERT INTO settings.app_domains (host, app_id, redirect_to, created_at) VALUES
      ('site.test', 'site', NULL, '2026-10-30T00:00:00Z'),
      ('alias.test', 'site', 'site.test', '2026-10-30T00:00:00Z')`;
    expect(await readAppDomains(db)).toEqual([
      { host: "alias.test", appId: "site", redirectTo: "site.test", createdAt: "2026-10-30T00:00:00.000Z" },
      { host: "site.test", appId: "site", redirectTo: null, createdAt: "2026-10-30T00:00:00.000Z" },
    ]);
  });
});
