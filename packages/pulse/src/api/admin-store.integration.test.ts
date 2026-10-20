import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { serviceAccountCredentials, session } from "@k2b/cloud/services";
import { sql } from "bun";
import { Hono } from "hono";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { app } from "../config";
import { newShortId } from "../lib/short-id";
import { storeAdmin } from "../store/service";
import pulseApi from ".";
import adminRoutes from "./routes/admin";
import baseAdminRoutes from "./routes/base-admin";

const suite = databaseSuite();
const api = new Hono<AuthContext>().route("/api/pulse/admin/store", adminRoutes).route("/api/pulse/admin", baseAdminRoutes);
const password = "obviously-fake-admin-store-fixture-password",
  marker = "REMOTE_CLICKHOUSE_BODY_MUST_NEVER_LEAK";
const asUser = (id: string, admin = false): User => ({
  id,
  uid: "store-fixture",
  provider: "local",
  profile: "user",
  roles: admin ? ["user", "admin"] : ["user"],
  givenname: "Store",
  sn: "Fixture",
  displayName: "Store fixture",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
});
const paths = [
  ["GET", "/api/pulse/admin/store"],
  ["PUT", "/api/pulse/admin/store"],
  ["POST", "/api/pulse/admin/store/check"],
  ["POST", "/api/pulse/admin/store/setup-sql"],
  ["GET", "/api/pulse/admin/policy"],
  ["PUT", "/api/pulse/admin/policy"],
  ["PUT", "/api/pulse/admin/bases/Base01/limits"],
] as const;
suite("Pulse store admin API", () => {
  let server: ReturnType<typeof Bun.serve>;
  let failAuth = false;
  let received = 0;
  // The saved connection is one encrypted tuple; the fixture keeps it as the JSON the service writes.
  const saved = { url: "", user: "fixture_service", password };
  const current = {
    "pulse.clickhouse_connection": "",
    "pulse.base_creation": "everyone",
    "pulse.max_bases": 200,
    "pulse.max_raw_retention_days": 730,
    "pulse.default_profile": "normal",
    "pulse.default_values_per_minute": 2000,
    "pulse.default_bytes_per_minute": 5242880,
    "pulse.default_storage_bytes": 5000000000,
    "pulse.default_max_series": 50000,
    "pulse.default_max_event_kinds": 2000,
    "pulse.default_max_state_keys": 2000,
  };
  const store = () => {
    current["pulse.clickhouse_connection"] = JSON.stringify(saved);
  };
  let personId: string, agentId: string, baseId: string;
  const accessIds: string[] = [];
  let get: ReturnType<typeof spyOn<typeof app.settings, "get">>;
  let set: ReturnType<typeof spyOn<typeof app.settings, "set">>;
  let read: ReturnType<typeof spyOn<typeof app.settings, "read">>;
  // What the stored row looks like to this process; "unreadable" models a changed APP_SECRET.
  let storedState: "readable" | "unreadable" = "readable";
  let sessionLookup: ReturnType<typeof spyOn<typeof session, "authenticateRequest">>;
  let credentialLookup: ReturnType<typeof spyOn<typeof serviceAccountCredentials, "authenticateApiToken">>;
  beforeAll(async () => {
    const [person] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users(uid, provider, profile, display_name) VALUES (${`store-${crypto.randomUUID()}`}, 'local', 'user', 'Store fixture') RETURNING id`;
    personId = person!.id;
    const [agent] = await sql<
      { id: string }[]
    >`INSERT INTO auth.service_accounts(name, kind) VALUES ('Store fixture', 'agent') RETURNING id`;
    agentId = agent!.id;
    const [base] = await sql<
      { id: string }[]
    >`INSERT INTO pulse.bases(short_id, name) VALUES (${newShortId()}, 'Store fixture') RETURNING id`;
    baseId = base!.id;
    for (const service of [false, true]) {
      const [grant] = await sql<
        { id: string }[]
      >`INSERT INTO auth.access(user_id, service_account_id, permission) VALUES (${service ? null : personId}::uuid, ${service ? agentId : null}::uuid, 'admin') RETURNING id`;
      accessIds.push(grant!.id);
      await sql`INSERT INTO pulse.base_access(base_id, access_id) VALUES (${baseId}::uuid, ${grant!.id}::uuid)`;
    }
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        received++;
        return failAuth
          ? new Response(marker, { status: 403, headers: { "X-ClickHouse-Exception-Code": "516" } })
          : Response.json({ data: [{ version: "26.9.19.9" }] }, { headers: { "X-ClickHouse-Query-Id": "fixture" } });
      },
    });
    saved.url = server.url.origin;
    store();
    get = spyOn(app.settings, "get").mockImplementation(async (key) => current[key]);
    read = spyOn(app.settings, "read").mockImplementation(async (key) => ({
      value: current[key],
      stored: storedState === "unreadable" ? "unreadable" : current[key] ? "readable" : "none",
    }));
    set = spyOn(app.settings, "set").mockImplementation(async (key, value) => {
      Object.assign(current, { [key]: value });
    });
    sessionLookup = spyOn(session, "authenticateRequest").mockImplementation(async (_c, token) =>
      token === "person-fixture" || token === "admin-fixture"
        ? {
            user: asUser(personId, token === "admin-fixture"),
            data: { userId: personId, sid: "store-fixture", authEpoch: 0, kind: "web", expiresAt: "2099-01-01T00:00:00Z" },
          }
        : null,
    );
    credentialLookup = spyOn(serviceAccountCredentials, "authenticateApiToken").mockResolvedValue({
      serviceAccount: {
        id: agentId,
        name: "Store agent",
        kind: "agent",
        status: "active",
        delegatedUserId: null,
        appId: null,
        resourceId: null,
        resourceType: null,
        createdBy: null,
        createdAt: "2026-10-17T00:00:00Z",
      },
      credential: {
        id: "11111111-1111-4111-8111-111111111111",
        serviceAccountId: agentId,
        name: "Store fixture",
        kind: "api_token",
        status: "active",
        scopes: ["read", "write", "admin"],
        tokenPrefix: "0123456789abcdef01234567",
        expiresAt: null,
        lastUsedAt: null,
        createdBy: null,
        createdAt: "2026-10-17T00:00:00Z",
        revokedAt: null,
        revokedBy: null,
      },
      delegatedUser: null,
    });
  });
  afterAll(async () => {
    get?.mockRestore();
    read?.mockRestore();
    set?.mockRestore();
    sessionLookup?.mockRestore();
    credentialLookup?.mockRestore();
    await server?.stop(true);
    for (const id of accessIds) await sql`DELETE FROM auth.access WHERE id=${id}::uuid`;
    if (baseId) await sql`DELETE FROM pulse.bases WHERE id=${baseId}::uuid`;
    if (agentId) await sql`DELETE FROM auth.service_accounts WHERE id=${agentId}::uuid`;
    if (personId) await sql`DELETE FROM auth.users WHERE id=${personId}::uuid`;
  });
  const call = (who: "person" | "admin" | "agent", method: string, path: string, body?: unknown) =>
    api.request(path, {
      method,
      headers: {
        ...(who === "agent"
          ? { authorization: "Bearer cld_0123456789abcdef01234567_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" }
          : { cookie: `session_token=${who}-fixture` }),
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  test("base grants never authorize a person or an agent for any admin route", async () => {
    for (const who of ["person", "agent"] as const)
      for (const [method, path] of paths) {
        const response = await call(
          who,
          method,
          path,
          method === "GET" ? undefined : { url: server.url.origin, user: "fixture_service", password },
        );
        expect(response.status).toBe(403);
        expect(response.headers.get("cache-control")).toContain("no-store");
        expect(await response.text()).not.toContain(password);
      }
    await expect(
      storeAdmin.read({ actor: { kind: "user", user: asUser(personId) }, accessSubject: { type: "user", userId: personId } }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED", status: 403 });
    const authenticated = await serviceAccountCredentials.authenticateApiToken("fixture");
    if (!authenticated) throw new Error("Missing agent fixture");
    await expect(
      storeAdmin.read({
        actor: { kind: "service_account", serviceAccount: authenticated.serviceAccount, delegatedUser: null, scopes: ["admin"] },
        accessSubject: { type: "service_account", serviceAccountId: agentId },
      }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED", status: 403 });
  });
  test("GET returns only passwordSet; failed PUT leaves all settings unchanged and hides remote bodies", async () => {
    const read = await call("admin", "GET", "/api/pulse/admin/store");
    expect(read.status).toBe(200);
    const text = await read.text();
    expect(JSON.parse(text)).toMatchObject({ configured: true, passwordSet: true, status: { ok: true, version: "26.9.19.9" } });
    expect(text).not.toContain(password);
    expect(text).not.toContain(marker);
    const before = { ...current };
    failAuth = true;
    const response = await call("admin", "PUT", "/api/pulse/admin/store", {
      url: server.url.origin,
      user: "changed_fixture",
      password: "obviously-fake-replacement-password",
    });
    expect(response.status).toBe(422);
    const failedText = await response.text();
    expect(JSON.parse(failedText)).toMatchObject({ code: "STORE_CHECK_FAILED", status: { ok: false, code: "AUTH_FAILED" } });
    expect(Object.keys(JSON.parse(failedText)).sort()).toEqual(["code", "status"]);
    expect(failedText).not.toContain(marker);
    expect(failedText).not.toContain(password);
    expect(failedText).not.toContain("replacement-password");
    expect(current).toEqual(before);
    expect(set).not.toHaveBeenCalled();
    const checked = await call("admin", "POST", "/api/pulse/admin/store/check");
    expect(checked.status).toBe(200);
    expect(await checked.text()).not.toContain(marker);
  });
  test("a new address or user never receives the saved password", async () => {
    failAuth = false;
    const before = { ...current };
    received = 0;
    for (const body of [
      { url: "http://127.0.0.1:9", user: saved.user },
      { url: saved.url, user: "other_fixture" },
    ]) {
      const response = await call("admin", "PUT", "/api/pulse/admin/store", body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "PASSWORD_REQUIRED" });
    }
    expect(received).toBe(0);
    expect(current).toEqual(before);
  });
  test("a password that the stored row cannot confirm is never reused", async () => {
    // The cache may still hold the old tuple while the stored ciphertext became unreadable.
    storedState = "unreadable";
    received = 0;
    const before = { ...current };
    try {
      const response = await call("admin", "PUT", "/api/pulse/admin/store", { url: saved.url, user: saved.user });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "PASSWORD_REQUIRED" });
      expect(received).toBe(0);
      expect(current).toEqual(before);
    } finally {
      storedState = "readable";
    }
  });
  test("an admin's OAuth token without the admin scope cannot use any store route", async () => {
    // Stands in for the OAuth layer: the caller is a Cloud admin, but the token carries only `read`.
    const scoped = new Hono<AuthContext>()
      .use(async (c, next) => {
        c.set("oauthScopes", ["read"]);
        await next();
      })
      .route("/api/pulse/admin/store", adminRoutes)
      .route("/api/pulse/admin", baseAdminRoutes);
    received = 0;
    for (const [method, path] of paths) {
      const response = await scoped.request(path, {
        method,
        headers: { cookie: "session_token=admin-fixture", "content-type": "application/json" },
        ...(method === "GET" ? {} : { body: JSON.stringify({ url: saved.url, user: saved.user, password }) }),
      });
      expect(response.status).toBe(403);
    }
    expect(received).toBe(0);
  });
  test("setup gate leaves admin store and policy available without a connection", async () => {
    const before = current["pulse.clickhouse_connection"];
    current["pulse.clickhouse_connection"] = "";
    try {
      const scoped = new Hono<AuthContext>().route("/api/pulse", pulseApi);
      const headers = { cookie: "session_token=admin-fixture" };
      for (const path of ["/api/pulse/admin/store", "/api/pulse/admin/policy"]) {
        const response = await scoped.request(path, { headers });
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toContain("no-store");
      }
      const data = await scoped.request("/api/pulse/bases", { headers });
      expect(data.status).toBe(503);
      expect(await data.json()).toMatchObject({ code: "PULSE_STORE_NOT_CONFIGURED" });
    } finally {
      current["pulse.clickhouse_connection"] = before;
    }
  });
  test("the store routes' middleware stays inside /admin/store", async () => {
    // Mounted like production: a read-scoped OAuth caller still reads its bases, uncached rules untouched.
    const scoped = new Hono<AuthContext>()
      .use(async (c, next) => {
        c.set("oauthScopes", ["read"]);
        await next();
      })
      .route("/", pulseApi);
    const bases = await scoped.request("/bases", { headers: { cookie: "session_token=person-fixture" } });
    expect(bases.status).toBe(200);
    expect(bases.headers.get("cache-control")).not.toBe("no-store");
    const store = await scoped.request("/admin/store", { headers: { cookie: "session_token=admin-fixture" } });
    expect(store.status).toBe(403);
  });
});
