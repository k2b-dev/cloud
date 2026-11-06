import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { createAdminAppDomainRoutes } from "@k2b/cloud/api";
import type { AppRegistryEntry } from "@k2b/cloud/contracts/registry";
import type { User } from "@k2b/cloud/contracts/shared";
import type { AppDomainStatus } from "@k2b/cloud/services/app-domain-check";
import { createAppDomainService } from "@k2b/cloud/services/app-domains";
import { databaseSuite, useFreshDatabase } from "../../../scripts/fixtures/test-infra";
import { migrate } from "./migrate/core/app-domains";
import { migrate as migrateAudit } from "./migrate/core/audit";

const actor: User = {
  id: "33333333-3333-4333-8333-333333333333",
  uid: "domain-admin",
  provider: "local",
  profile: "user",
  roles: ["admin"],
  givenname: "",
  sn: "",
  displayName: "Admin",
  mail: null,
  avatarHash: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  accountExpires: null,
  lastLoginLocal: null,
  ipa: null,
};
const status: AppDomainStatus = {
  checkedAt: "2026-10-30T12:00:00.000Z",
  dns: { ok: true, detail: "203.0.113.8" },
  certificate: { ok: true, detail: "Valid" },
  reachable: { ok: true, detail: "Gateway" },
};
const registry = new Map<string, AppRegistryEntry>();
const probes: string[] = [];
const service = createAppDomainService({
  getApp: async (id) => registry.get(id) ?? null,
  cloudUrl: () => "https://cloud.example.test:8443",
  probe: async (host) => {
    probes.push(host);
    return status;
  },
});
const routes = createAdminAppDomainRoutes(async (c, next) => {
  c.set("user", actor);
  return next();
}, service);
const request = (path: string, method = "GET", body?: unknown) =>
  routes.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const input = (host: string, appId = "site") => ({ actor, host, appId });
const code = (result: Awaited<ReturnType<typeof service.add>>) => (result.ok ? null : result.error.code);

databaseSuite()("Core app domains and administration API", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  beforeAll(async () => {
    database = await useFreshDatabase("cloud_app_domains");
    await migrate();
    await migrateAudit();
    // The durable package registry is populated by application startup; no live registry lease is needed.
    await sql`CREATE SCHEMA IF NOT EXISTS platform`;
    await sql`CREATE TABLE IF NOT EXISTS platform.application_packages (app_id TEXT PRIMARY KEY, package_name TEXT NOT NULL)`;
    await sql`INSERT INTO platform.application_packages VALUES ('site', 'site'), ('other', 'other'), ('stopped', 'site')`;
    for (const id of ["site", "other"])
      registry.set(id, { id, name: id, description: "Site", icon: "ti ti-world", baseUrl: `http://${id}:3000`, routes: [], public: true });
  });
  afterAll(async () => {
    await sql.close();
    await database?.drop();
  });

  test("migration is repeatable and creates the app lookup index", async () => {
    await migrate();
    const rows = await sql<
      { indexname: string }[]
    >`SELECT indexname FROM pg_indexes WHERE schemaname = 'settings' AND tablename = 'app_domains'`;
    expect(rows.map((row) => row.indexname)).toContain("app_domains_app_id");
  });
  test("normalization, unique ownership, Cloud host and unknown IDs have stable errors; stopped known apps work", async () => {
    const created = await request("/site/domains", "POST", { host: "  BÜCHER.Example.Test.  " });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ host: "xn--bcher-kva.example.test", active: true });
    expect(code(await service.add(input("xn--bcher-kva.example.test", "other")))).toBe("APP_DOMAIN_ASSIGNED");
    expect(code(await service.add(input("cloud.example.test")))).toBe("APP_DOMAIN_CLOUD_HOST");
    expect(code(await service.add(input("unknown.example.test", "typo")))).toBe("APP_DOMAIN_UNKNOWN_APP");
    for (const host of ["site.example.test:443", "*.example.test", "https://site.example.test", "127.0.0.1", "site.example.test\\path"])
      expect(code(await service.add(input(host)))).toBe("APP_DOMAIN_INVALID_HOST");
    expect(await service.add(input("stopped.example.test", "stopped"))).toMatchObject({ ok: true, data: { active: false } });
    registry.delete("site");
    expect(await service.list({ actor, appId: "site" })).toMatchObject({ ok: true, data: { domains: [{ active: false }] } });
    registry.set("site", {
      id: "site",
      name: "Site",
      icon: "ti ti-world",
      description: "Site",
      baseUrl: "http://site:3000",
      routes: [],
      public: true,
    });
  });
  test("redirect targets must be canonical domains of the same app; referenced domains cannot redirect or disappear", async () => {
    await service.add(input("main.example.test"));
    await service.add(input("foreign.example.test", "other"));
    expect(code(await service.add({ ...input("alias.example.test"), redirectTo: "main.example.test" }))).toBeNull();
    expect(code(await service.add({ ...input("chain.example.test"), redirectTo: "alias.example.test" }))).toBe(
      "APP_DOMAIN_REDIRECT_TARGET",
    );
    expect(code(await service.add({ ...input("cross.example.test"), redirectTo: "foreign.example.test" }))).toBe(
      "APP_DOMAIN_REDIRECT_TARGET",
    );
    expect(await service.set({ ...input("main.example.test"), redirectTo: "alias.example.test" })).toMatchObject({
      ok: false,
      error: { code: "APP_DOMAIN_REFERENCED" },
    });
    const referenced = await request("/site/domains/main.example.test", "DELETE");
    expect(referenced.status).toBe(409);
    expect(await referenced.json()).toMatchObject({
      code: "APP_DOMAIN_REFERENCED",
      message: expect.stringContaining("alias.example.test"),
    });
    expect((await request("/site/domains/alias.example.test", "PATCH", { redirectTo: null })).status).toBe(200);
    expect((await request("/site/domains/main.example.test", "DELETE")).status).toBe(200);
  });
  test("concurrent assignments across apps elect one owner", async () => {
    const results = await Promise.all([
      service.add(input("race-owner.example.test")),
      service.add(input("race-owner.example.test", "other")),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok).map(code)).toEqual(["APP_DOMAIN_ASSIGNED"]);
  });
  test("opposite redirects cannot race into a cycle or a chain", async () => {
    for (const host of ["a", "b"]) await service.add(input(`${host}.race.example.test`));
    const opposite = await Promise.all([
      service.set({ ...input("a.race.example.test"), redirectTo: "b.race.example.test" }),
      service.set({ ...input("b.race.example.test"), redirectTo: "a.race.example.test" }),
    ]);
    expect(opposite.filter((result) => result.ok)).toHaveLength(1);
    for (const host of ["c", "d", "e"]) await service.add(input(`${host}.race.example.test`));
    const chain = await Promise.all([
      service.set({ ...input("c.race.example.test"), redirectTo: "d.race.example.test" }),
      service.set({ ...input("d.race.example.test"), redirectTo: "e.race.example.test" }),
    ]);
    expect(chain.filter((result) => result.ok)).toHaveLength(1);
  });
  test("redirect creation racing a target deletion never leaves a dangling reference", async () => {
    await service.add(input("target.race.example.test"));
    const results = await Promise.all([
      service.add({ ...input("alias.race.example.test"), redirectTo: "target.race.example.test" }),
      service.remove(input("target.race.example.test")),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const dangling =
      await sql`SELECT d.host FROM settings.app_domains d LEFT JOIN settings.app_domains t ON t.host = d.redirect_to AND t.app_id = d.app_id WHERE d.redirect_to IS NOT NULL AND (t.host IS NULL OR t.redirect_to IS NOT NULL)`;
    expect(dangling).toHaveLength(0);
  });
  test("checks persist status, elect one probe under concurrency, and respect the exact 60-second window", async () => {
    await service.add(input("check.example.test"));
    const count = () => probes.filter((host) => host === "check.example.test").length;
    const before = count();
    const results = await Promise.all(Array.from({ length: 4 }, () => request("/site/domains/check.example.test/check", "POST")));
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(count() - before).toBe(1);
    expect(await (await request("/site/domains/check.example.test/check", "POST")).json()).toEqual({ status });
    await sql`UPDATE settings.app_domains SET check_started_at = now() - interval '61 seconds' WHERE host = 'check.example.test'`;
    expect((await request("/site/domains/check.example.test/check", "POST")).status).toBe(200);
    expect(count() - before).toBe(2);
    const listed = await service.list({ actor, appId: "site" });
    expect(listed.ok && listed.data.domains.find((domain) => domain.host === "check.example.test")?.status).toEqual(status);
  });
  test("admin mutations leave an audit event in the same database", async () => {
    const [row] = await sql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM audit.events WHERE action LIKE 'app_domain.%' AND actor_uid = ${actor.uid}`;
    expect(row?.count).toBeGreaterThan(0);
  });
});
