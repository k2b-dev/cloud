import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import { compileCapabilities } from "../../packages/cloud/src/_internal/capabilities";
import { type ProcessSync, startProcessSync } from "../../packages/cloud/src/_internal/process-sync";
import { appRegistry } from "../../packages/cloud/src/_internal/registry";
import type { CapabilityExecutionContext } from "../../packages/cloud/src/contracts";
import { type AppRegistryDetail, sql } from "../../packages/cloud/src/index";
import { closePlatformClients } from "../../packages/cloud/src/runtime/clients";
import type { AuthContext, RequestAuthority } from "../../packages/cloud/src/server";
import { createAdminAppListingRoutes } from "../../packages/core/src/api/admin-app-listing";
import { removeAppListing } from "../../packages/core/src/app-listing";
import {
  hideKnownApp,
  keepAppListingVisible,
  listAppListing,
  listingStatusProviders,
  listKnownApps,
  rememberAppStatusReports,
  rememberApps,
} from "../../packages/core/src/known-apps";
import { migrate as migrateAppEvents } from "../../packages/core/src/migrate/core/app-events";
import { migrate as migrateAuth } from "../../packages/core/src/migrate/core/auth";
import { migrate as migrateEvents } from "../../packages/core/src/migrate/core/events";
import { migrateKnownApps } from "../../packages/core/src/migrate/core/known-apps";
import { forgetGatewayAppStatus, readGatewayAppStatusDetail, readGatewayAppStatusSummary } from "../../packages/gateway-ops/src/app-status";
import { gatewayOpsCapabilities } from "../../packages/gateway-ops/src/capabilities";
import { migrate as migrateGateway } from "../../packages/gateway-ops/src/migrate";
import { listRegisteredApps, upsertRegisteredApps } from "../../packages/gateway-ops/src/registered-apps";
import { adminAuthority } from "../../scripts/fixtures/app-status";
import { suiteFor, useFreshDatabase } from "../../scripts/fixtures/test-infra";

const authority = adminAuthority();
const context = (auth: RequestAuthority = authority): CapabilityExecutionContext => ({
  authority: auth,
  actor: auth.actor,
  accessSubject: auth.accessSubject,
  user: auth.actor.kind === "user" ? auth.actor.user : auth.actor.delegatedUser,
  locale: "de",
  requestId: "app-status-test",
  origin: "app",
  signal: new AbortController().signal,
});
const app = (id: string): AppRegistryDetail => ({
  id,
  name: `App ${id}`,
  description: "Known application",
  icon: "ti ti-app",
  appearance: { accent: "#123456" },
  runtime: { release: "test", version: "0.1.0", syncVersion: "6" },
  baseUrl: "http://example.test",
  routes: [`/app/${id}`],
  nav: { href: `/app/${id}`, section: "primary", adminHref: `/admin/${id}` },
  createdAt: Date.parse("2026-01-01T00:00:00Z"),
  updatedAt: Date.parse("2026-01-02T00:00:00Z"),
  expiresAt: Date.parse("2026-01-02T00:05:00Z"),
  version: "one",
});
const authenticate =
  (auth = authority): MiddlewareHandler<AuthContext> =>
  async (c, next) => {
    c.set("actor", auth.actor);
    c.set("accessSubject", auth.accessSubject);
    c.set("credentialKind", auth.credentialKind);
    c.set("credentialScopes", auth.scopes);
    if (auth.actor.kind === "user") c.set("user", auth.actor.user);
    if (auth.credentialKind === "oauth") c.set("oauthScopes", auth.scopes);
    return next();
  };
const router = (remove: typeof removeAppListing, auth = authority) =>
  new Hono<AuthContext>().route("/api/admin/apps", createAdminAppListingRoutes(authenticate(auth), remove));
let database: Awaited<ReturnType<typeof useFreshDatabase>> | undefined;
let processSync: ProcessSync | undefined;

suiteFor(
  "database",
  "nats",
  "valkey",
)("Core app memory, listing removal and the Gateway app-status provider", () => {
  beforeAll(async () => {
    database = await useFreshDatabase("app_status");
    await migrateAuth();
    await migrateEvents();
    await migrateAppEvents();
    await migrateKnownApps();
    await migrateGateway();
    processSync = await startProcessSync({ application: "app-status-test" });
  }, 30_000);
  afterAll(async () => {
    try {
      await processSync?.stop();
    } finally {
      await closePlatformClients();
      await database?.drop();
    }
  });

  test("remembers registry metadata, un-hides a fresh lease, and includes retained keys, grants and event subscriptions", async () => {
    const live = app("remembered");
    await rememberApps([live]);
    await rememberApps([{ ...live, name: "Stale", updatedAt: live.updatedAt - 1 }]);
    let known = (await listKnownApps()).find((row) => row.id === live.id);
    expect(known?.name).toBe(live.name);
    expect(known?.release).toBe("0.1.0");
    expect(known?.routes).toEqual([...live.routes]);
    expect(known?.adminHref).toBe("/admin/remembered");
    const withProvider = await listAppListing({
      liveApps: [],
      otherApps: [{ appId: live.id, provider: { appId: "monitor", name: "Monitor" }, lastSeenAt: "2026-01-02T01:00:00+02:00" }],
    });
    expect(withProvider.find((row) => row.id === live.id)?.lastSeenAt).toBe("2026-01-02T00:00:00.000Z");
    await hideKnownApp(live.id);
    expect((await listKnownApps()).find((row) => row.id === live.id)?.hidden).toBe(true);
    await rememberApps([{ ...live, updatedAt: Date.now() + 1000 }]);
    expect((await listKnownApps()).find((row) => row.id === live.id)?.hidden).toBe(false);
    await sql`INSERT INTO auth.app_access_state(app_id) VALUES ('grants-only')`;
    await sql`INSERT INTO auth.service_accounts(id, name, kind, app_id, resource_type, resource_id)
      VALUES ('00000000-0000-4000-8000-000000000010', 'App token', 'resource_bound', 'tokens-only', 'cloud.app', 'tokens-only')`;
    await sql`INSERT INTO events.app_subscriptions(id, app_id, event_type, version, state) VALUES ('listing-test', 'events-only', 'test.event', 1, 'active')`;
    const listing = await listAppListing({ liveApps: [] });
    for (const id of ["grants-only", "tokens-only", "events-only"])
      expect(listing.find((row) => row.id === id)?.source).toContain("core-data");
    await hideKnownApp("tokens-only");
    expect((await listAppListing({ liveApps: [] })).some((row) => row.id === "tokens-only")).toBe(false);
    expect(await sql`SELECT id FROM auth.service_accounts WHERE app_id = 'tokens-only'`).toHaveLength(1);
    known = (await listKnownApps()).find((row) => row.id === live.id);
    expect(known?.firstSeenAt).toBeTruthy();
  });

  test("Gateway role compiles, returns null for absent data, localizes links, and pages tied failures without dropping microseconds", async () => {
    expect(compileCapabilities("monitor", gatewayOpsCapabilities).manifest.appStatus).toBeTruthy();
    const registered = app("traffic");
    await upsertRegisteredApps([registered, app("provider-only")]);
    await sql`INSERT INTO gateway.telemetry_rollups_minute(bucket, app_id, route_prefix, method, status_code, request_count, error_count, total_duration_ms)
      VALUES (date_trunc('minute', now()), 'traffic', '/app/traffic', 'GET', 503, 51, 51, 102)`;
    await sql`INSERT INTO gateway.telemetry_events(event_id, cursor, kind, app_id, route_prefix, method, status_code, status_class, duration_ms, occurred_at)
      SELECT 'status-event-' || n, 'cursor-' || n, 'request', 'traffic', '/app/traffic', 'GET', 503, 5, 2,
        date_trunc('second', now()) - interval '5 minutes' + interval '123456 microseconds' FROM generate_series(1, 51) AS n`;
    const result = await readGatewayAppStatusSummary({ appIds: ["traffic", "no-measurements"], window: "24h" }, context());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("summary failed");
    expect(result.data.data.apps.find((row) => row.appId === "traffic")?.traffic).toEqual({ requests: 51, errors: 51, avgMs: 2 });
    expect(result.data.data.apps.find((row) => row.appId === "no-measurements")?.traffic).toBeNull();
    expect(result.data.data.otherApps).toContain("provider-only");
    expect(result.data.data.apps[0]?.links[0]?.label).toBe("Protokolle");
    const first = await readGatewayAppStatusDetail({ appId: "traffic", window: "24h" }, context());
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("detail failed");
    expect(first.data.data.routes[0]).toEqual({ prefix: "/app/traffic", requests: 51, errors: 51 });
    expect(first.data.data.failedRequests).toHaveLength(50);
    expect(first.data.data.totalFailedRequests).toBe(51);
    const cursor = first.data.data.nextCursor;
    expect(cursor).toBeTruthy();
    const second = await readGatewayAppStatusDetail({ appId: "traffic", window: "24h", cursor: cursor ?? undefined }, context());
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("next page failed");
    expect(second.data.data.failedRequests).toHaveLength(1);
    expect(second.data.data.nextCursor).toBeNull();
    const denied = adminAuthority();
    if (denied.actor.kind === "user") denied.actor.user.roles = [];
    expect((await readGatewayAppStatusSummary({ appIds: ["traffic"], window: "24h" }, context(denied))).ok).toBe(false);
    expect((await readGatewayAppStatusDetail({ appId: "traffic", window: "24h" }, context(denied))).ok).toBe(false);
    expect((await forgetGatewayAppStatus({ appId: "traffic" }, context(denied))).ok).toBe(false);
  });

  test("remove route refuses live apps, keeps failed forgets visible, and hides only after provider forget succeeds", async () => {
    const target = app("remove-me");
    await rememberApps([target]);
    await upsertRegisteredApps([target]);
    const registry = () => Promise.resolve({ apps: [] as AppRegistryDetail[], issues: [] });
    const service = {
      registry,
      hide: hideKnownApp,
      keepVisible: keepAppListingVisible,
      providers: listingStatusProviders,
      forget: async () => {
        const result = await forgetGatewayAppStatus({ appId: target.id }, context());
        return { failures: result.ok ? [] : [result.error] };
      },
    };
    const liveRoute = router((params) => removeAppListing(params, { ...service, registry: async () => ({ apps: [target], issues: [] }) }));
    const running = await liveRoute.request(`/api/admin/apps/${target.id}/listing`, { method: "DELETE" });
    expect(running.status).toBe(409);
    expect((await running.json()).code).toBe("app_running");
    const failing = router((params) => removeAppListing(params, { ...service, forget: async () => ({ failures: ["offline"] }) }));
    const failure = await failing.request(`/api/admin/apps/${target.id}/listing`, { method: "DELETE" });
    expect(failure.status).toBe(503);
    expect((await failure.json()).code).toBe("forget_failed");
    expect((await listKnownApps()).find((row) => row.id === target.id)?.hidden).toBe(false);
    await appRegistry().upsert({ key: `apps/${target.id}`, value: target });
    expect((await forgetGatewayAppStatus({ appId: target.id }, context())).ok).toBe(false);
    await appRegistry().delete({ key: `apps/${target.id}` });
    const success = await router((params) => removeAppListing(params, service)).request(`/api/admin/apps/${target.id}/listing`, {
      method: "DELETE",
    });
    expect(success.status).toBe(200);
    expect(success.headers.get("Cache-Control")).toContain("no-transform");
    expect((await listKnownApps()).find((row) => row.id === target.id)?.hidden).toBe(true);
    expect((await listRegisteredApps()).some((row) => row.id === target.id)).toBe(false);
    expect((await forgetGatewayAppStatus({ appId: target.id }, context())).ok).toBe(true);
    const readOnly = { ...adminAuthority(), credentialKind: "oauth" as const, scopes: ["read"] };
    expect(
      (
        await router((params) => removeAppListing(params, service), readOnly).request(`/api/admin/apps/${target.id}/listing`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(403);
    const anonymous = new Hono().route("/api/admin/apps", createAdminAppListingRoutes());
    expect((await anonymous.request(`/api/admin/apps/${target.id}/listing`, { method: "DELETE" })).status).toBe(401);
  });

  test("provider-only hints remain visible after partial forget and retain unavailable reporting providers", async () => {
    const provider = { appId: "offline-monitor", name: "Offline monitor" };
    await rememberAppStatusReports({
      byApp: new Map(),
      otherApps: [{ appId: "provider-hint", provider, lastSeenAt: null }],
      failures: [],
      truncated: [],
    });
    expect(await listingStatusProviders("provider-hint")).toEqual([provider]);
    const failure = await removeAppListing(
      { authority, appId: "provider-hint", locale: "de" },
      {
        registry: async () => ({ apps: [], issues: [] }),
        hide: hideKnownApp,
        keepVisible: keepAppListingVisible,
        providers: listingStatusProviders,
        forget: async (params) => ({ failures: params.requiredProviders ?? [] }),
      },
    );
    expect(failure.ok).toBe(false);
    expect((await listAppListing({ liveApps: [] })).some((row) => row.id === "provider-hint")).toBe(true);
  });
});
