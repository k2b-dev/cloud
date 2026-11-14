import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { meterSql, type SqlMeter } from "../../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
import { sql } from "../../runtime/clients";
import "../../../../../scripts/fixtures/authorization-preload";
import { appRegistry } from "../../_internal/registry";
import type { AppRegistryEntry } from "../../contracts/registry";
import { session } from "../../services/session";
import { createTestSession } from "../../services/session/session.test-fixture";
import { requireAppAccess } from "./app-access";
import { type AuthContext, auth } from "./auth";

const suite = suiteFor("database", "nats", "valkey");
const appId = "requestbudget";
const entry: AppRegistryEntry = {
  id: appId,
  name: "Request budget",
  icon: "ti ti-test-pipe",
  description: "Fixture",
  baseUrl: "http://requestbudget:3000",
  routes: ["/api/requestbudget"],
  access: { kind: "grants", publicRoutes: [] },
};
let userId = "";
let token = "";
let accessId = "";
let meter: SqlMeter | undefined;

suite("statement budget of an ordinary signed-in request", () => {
  beforeAll(async () => {
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
      VALUES (${`budget-${crypto.randomUUID()}`}, 'local', 'user', 'Request budget') RETURNING id`;
    userId = user!.id;
    token = await createTestSession(userId);
    await sql`INSERT INTO auth.app_access_state (app_id, configured_at) VALUES (${appId}, now())`;
    const [access] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access (user_id, permission) VALUES (${userId}::uuid, 'read') RETURNING id`;
    accessId = access!.id;
    await sql`INSERT INTO auth.app_access (app_id, access_id) VALUES (${appId}, ${accessId}::uuid)`;
    await appRegistry().upsert({ key: `apps/${appId}`, value: entry });
    meter = await meterSql();
  });

  afterAll(async () => {
    await meter?.close();
    if (token) await session.revokeAllForUser(userId);
    await appRegistry().delete({ key: `apps/${appId}` });
    await sql`DELETE FROM auth.app_access WHERE app_id = ${appId}`;
    await sql`DELETE FROM auth.app_access_state WHERE app_id = ${appId}`;
    if (accessId) await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
    if (userId) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });

  test("session, actor and application access cost a fixed number of statements per request", async () => {
    const app = new Hono<AuthContext>()
      .use(requireAppAccess(entry, async (_c, message) => new Response(message, { status: 403 })))
      .get("/private", auth.requireRole("authenticated"), (c) => c.body(null, 204));
    const call = () => app.request("/private", { headers: { cookie: `session_token=${token}` } });
    // The first request fills the process caches; the budget is for every request after it.
    expect((await call()).status).toBe(204);
    const requests = 5;
    const statements = await meter!.during(async () => {
      for (let index = 0; index < requests; index++) expect((await call()).status).toBe(204);
    });
    // One statement resolves session and actor, one the application grant (identity-performance.md).
    expect({ perRequest: statements.length / requests, statements }).toEqual({ perRequest: 2, statements: expect.any(Array) });
  });
});
