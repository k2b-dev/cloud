import { afterAll, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { migrateCloudCapabilities } from "@k2b/cloud/capabilities/store";
import type { AuthContext } from "@k2b/cloud/server";
import { requireAppAccess } from "@k2b/cloud/server/middleware/app-access";
import { sessionOriginGuard } from "@k2b/cloud/server/middleware/session-origin";
import { createGeoBucket } from "@k2b/cloud/services/geo/bucket";
import autocomplete from "@k2b/cloud/services/geo/fixtures/autocomplete.json";
import { GEO_TEST_NOW, geoTestConfig } from "@k2b/cloud/services/geo/geo.test-fixture";
import { GeoapifyAdapter } from "@k2b/cloud/services/geo/geoapify";
import { createGeoLedger } from "@k2b/cloud/services/geo/ledger";
import { migrate } from "@k2b/cloud/services/geo/migrate";
import { createGeoService } from "@k2b/cloud/services/geo/service";
import { RedisClient } from "bun";
import { Hono } from "hono";
import { initializeTestPlatform, suiteFor, testInfra, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { app } from "../config";
import { createAnonymousGeoRoutes } from "./geo-anonymous";

suiteFor("database", "valkey")("anonymous internal Geo autocomplete", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  let redis: RedisClient;
  let prefix: string;
  const original = process.env.CLOUD_CORE_INTERNAL_ORIGIN;
  let month = 10;
  let rps = 100;
  let sent = 0;
  let service: ReturnType<typeof createGeoService>;
  const route = () =>
    new Hono<AuthContext>()
      .use(
        "*",
        sessionOriginGuard([], async () => "https://cloud.test"),
      )
      .use(
        "*",
        requireAppAccess(app.meta, async (_c, message) => new Response(message, { status: 403 })),
      )
      .route(
        "/api/_internal/geo/v1",
        createAnonymousGeoRoutes({ autocomplete: (input, context) => service.autocompleteAnonymous(input, context) }),
      );
  const call = (text = "Orle", origin = "http://core.internal", headers?: HeadersInit) =>
    route().request(`${origin}/api/_internal/geo/v1/autocomplete`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ text }),
    });
  beforeAll(async () => {
    setSystemTime(GEO_TEST_NOW);
    process.env.CLOUD_CORE_INTERNAL_ORIGIN = "http://core.internal";
    database = await useFreshDatabase("geo_anonymous");
    prefix = `geo:anonymous-test:${database.name}`;
    redis = new RedisClient(testInfra.valkey!, { enableOfflineQueue: false });
    await redis.connect();
    await migrate(sql);
    await sql`CREATE SCHEMA auth`;
    await sql`CREATE TABLE auth.users (id uuid PRIMARY KEY)`;
    await migrateCloudCapabilities();
    await sql`CREATE SCHEMA audit`;
    await sql`CREATE TABLE audit.events (
      id bigserial PRIMARY KEY, created_at timestamptz DEFAULT now(), action text, outcome text,
      actor_user_id uuid, actor_uid text, actor_provider text, actor_roles text[],
      target_type text, target_id text, target_label text, target_provider text,
      reason text, error_code text, error_message text, request_id text, metadata jsonb
    )`;
  });
  beforeEach(async () => {
    month = 10;
    rps = 100;
    sent = 0;
    await sql`TRUNCATE geo.shares, geo.usage, geo.audit_transitions, audit.events, capabilities.executions`;
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    service = createGeoService({
      now: () => GEO_TEST_NOW,
      config: async () => ({ ...geoTestConfig, monthlyCredits: month, plan: "custom", customRps: rps }),
      ledger: createGeoLedger(),
      bucket: createGeoBucket({ redis: async () => redis, prefix }),
      cache: { get: async () => null, put: async () => {} },
      adapter: new GeoapifyAdapter({
        now: () => GEO_TEST_NOW,
        fetch: async () => {
          sent++;
          return Response.json(autocomplete);
        },
      }),
    });
  });
  afterAll(async () => {
    setSystemTime();
    if (original === undefined) delete process.env.CLOUD_CORE_INTERNAL_ORIGIN;
    else process.env.CLOUD_CORE_INTERNAL_ORIGIN = original;
    if (redis) {
      const keys = await redis.keys(`${prefix}*`);
      if (keys.length) await redis.del(...keys);
      redis.close();
    }
    await sql.close();
    await database?.drop();
    await initializeTestPlatform();
  });
  test("no session or app key is needed and the execution has no actor or subject", async () => {
    expect((await call()).status).toBe(200);
    expect(sent).toBe(1);
    const [row] =
      await sql`SELECT origin,actor_kind,actor_id,actor_app_id,actor_key_id,user_id,access_subject_type,access_subject_id FROM capabilities.executions`;
    expect(row).toEqual({
      origin: "app",
      actor_kind: null,
      actor_id: null,
      actor_app_id: null,
      actor_key_id: null,
      user_id: null,
      access_subject_type: null,
      access_subject_id: null,
    });
  });
  test("TLS termination can preserve the internal host without forwarding-header trust", async () => {
    process.env.CLOUD_CORE_INTERNAL_ORIGIN = "https://core.internal";
    try {
      expect((await call()).status).toBe(200);
    } finally {
      process.env.CLOUD_CORE_INTERNAL_ORIGIN = "http://core.internal";
    }
  });
  test("malformed JSON fails validation before provider admission", async () => {
    const response = await route().request("http://core.internal/api/_internal/geo/v1/autocomplete", {
      method: "POST",
      body: "{",
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "GEO_UNSUPPORTED_OPTION" });
    expect(sent).toBe(0);
  });
  test("monthly exhaustion returns the existing 429 and month-boundary retry", async () => {
    month = 1;
    expect((await call()).status).toBe(200);
    const response = await call("Other");
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: "GEO_BUDGET_EXHAUSTED", details: { scope: "cloud" } });
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(1);
    expect(sent).toBe(1);
    const [row] = await sql`SELECT actor_user_id,actor_uid,metadata FROM audit.events WHERE action='core.geo.monthly_budget_exhausted'`;
    expect(row.actor_user_id).toBeNull();
    expect(row.actor_uid).toBeNull();
    expect(row.metadata).toMatchObject({ caller: "anonymous", internal: true });
  });
  test("all instances share installation rate admission", async () => {
    rps = 1;
    const results = await Promise.all([call(), call("Other")]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 429]);
    const refused = results.find((response) => response.status === 429)!;
    expect(await refused.json()).toMatchObject({ code: "GEO_BUSY" });
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(sent).toBe(1);
  });
  test("forwarding headers do not override the configured internal host", async () => {
    expect(
      (
        await call("Orle", "https://cloud.test", {
          "x-forwarded-host": "core.internal",
          "x-forwarded-proto": "http",
          "x-forwarded-for": "127.0.0.1",
          forwarded: "host=core.internal;proto=http",
        })
      ).status,
    ).toBe(404);
    expect(sent).toBe(0);
  });
});
