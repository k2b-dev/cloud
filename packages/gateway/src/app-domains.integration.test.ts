import { afterAll, beforeAll, expect, test } from "bun:test";
import { APP_DOMAINS_DDL, readAppDomains } from "@k2b/cloud/contracts/app-domains";
import { SQL } from "bun";
import { createDisposableDatabase, suiteFor } from "../../../scripts/fixtures/test-infra";
import { cloudHostSet } from "./app-domains";
import { createGatewayHandler } from "./handler";
import { createProxyStats } from "./proxy";
import { buildRouteTable } from "./trie";

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
  test("the anonymous Geo internal route is refused before Core's root fallback", async () => {
    const handle = createGatewayHandler({
      snapshot: () => ({
        cloudHosts: cloudHostSet("https://cloud.test", [], false),
        domainsReady: true,
        domains: new Map(),
        apps: new Map(),
        development: false,
      }),
      table: () => buildRouteTable([{ prefix: "/", appId: "core", baseUrl: "http://127.0.0.1:1" }]),
      stats: createProxyStats(),
      log: () => {},
      health: () => new Response(),
      storage: async () => new Response(),
    });
    const response = await handle(
      new Request("https://cloud.test/api/_internal/geo/v1/autocomplete", {
        method: "POST",
        headers: {
          Host: "cloud.test",
          "X-Forwarded-Host": "core.internal",
          "X-Forwarded-Proto": "http",
          "X-Forwarded-For": "127.0.0.1",
          Forwarded: "host=core.internal;proto=http",
        },
        body: JSON.stringify({ text: "Orle" }),
      }),
      { timeout: () => {}, upgrade: () => false },
      { address: "203.0.113.7", forwardedFor: "203.0.113.7" },
    );
    expect(response?.status).toBe(404);
  });
});
