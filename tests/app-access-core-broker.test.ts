import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { sql } from "bun";
import { Hono } from "hono";
import { generateKeyPair } from "jose";
import { z } from "zod";
import { compileCapabilities } from "../packages/cloud/src/_internal/capabilities";
import * as registry from "../packages/cloud/src/_internal/registry";
import { createAppAccessRoutes, createOwnedAppAccessRoutes } from "../packages/cloud/src/api/app-access";
import { appDiscoveryRoutes } from "../packages/cloud/src/api/apps";
import { createCapabilityRoutes } from "../packages/cloud/src/api/capabilities";
import { cliPluginListRoutes } from "../packages/cloud/src/api/cli-plugins";
import * as executions from "../packages/cloud/src/capabilities/executions";
import type { CloudRuntime } from "../packages/cloud/src/contracts/app";
import { appAccess } from "../packages/cloud/src/contracts/app-access";
import { defineCapabilities } from "../packages/cloud/src/contracts/capabilities";
import type { AppRegistryEntry, CapabilityRegistryEntry } from "../packages/cloud/src/contracts/registry";
import { requireAppAccess } from "../packages/cloud/src/server/middleware/app-access";
import { type AuthContext, auth, type RequestAuthority } from "../packages/cloud/src/server/middleware/auth";
import { canUseApp } from "../packages/cloud/src/services/app-access";
import * as management from "../packages/cloud/src/services/app-access-management";
import { issueInvocationToken } from "../packages/cloud/src/services/identity/issue-invocation";
import type { withActiveIdentitySigner } from "../packages/cloud/src/services/identity/key-ring";
import {
  type AuthenticatedServiceAccountCredential,
  serviceAccountCredentials,
} from "../packages/cloud/src/services/service-account-credentials";
import { session } from "../packages/cloud/src/services/session";
import { buildProjectedUser } from "../packages/cloud/src/services/session/user";
import * as settings from "../packages/cloud/src/services/settings";
import { app as core } from "../packages/core/src/config";

// Compose the production entry/auth middleware and mounted broker routers. Only
// persistence, live registry, signer storage and the provider transport are fixtures.
const capabilities = compileCapabilities(
  "notebooks",
  defineCapabilities({
    protocolVersion: 2,
    commands: { compose: { title: "Compose", description: "Open a notebook", path: "/app/notebooks", input: z.object({}).strict() } },
    queries: {
      get: {
        title: "Read notebook",
        description: "Read one notebook.",
        input: z.object({ id: z.string().describe("Notebook id.") }).strict(),
        data: z.object({ id: z.string() }).strict(),
        openWorld: false,
        run: async ({ id }) => ok({ data: { id } }),
      },
    },
  }),
);
const entries: AppRegistryEntry[] = ["notebooks", "mail"].map((id) => ({
  id,
  name: id,
  description: `${id} fixture`,
  icon: "ti ti-book",
  baseUrl: `http://${id}:3000`,
  routes: [`/api/${id}`, `/app/${id}`],
  access: appAccess.signedIn(),
  nav: { href: `/app/${id}`, section: "primary" },
  cliModules: [id],
  capabilities: { protocolVersion: 2, manifestHash: capabilities.manifest.manifestHash },
}));
const managed: AppRegistryEntry = {
  ...entries[0]!,
  id: "inventory",
  name: "Inventory",
  routes: ["/api/inventory", "/app/inventory"],
  access: appAccess.grants(),
};
const capability = (id: string): CapabilityRegistryEntry => ({
  appId: id,
  appName: id,
  appIcon: "ti ti-book",
  appDescription: `${id} fixture`,
  endpoint: `http://${id}:3000/api/_internal/capabilities/v1`,
  manifest: { ...capabilities.manifest, appId: id },
});
const token = `cld_${"a".repeat(24)}_${"b".repeat(64)}`;
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const fixture = (): AuthenticatedServiceAccountCredential => ({
  serviceAccount: {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Notebook fixture",
    kind: "resource_bound",
    status: "active",
    delegatedUserId: null,
    appId: "notebooks",
    resourceType: "notebook",
    resourceId: "fixture",
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  delegatedUser: null,
  credential: {
    id: "22222222-2222-4222-8222-222222222222",
    serviceAccountId: "11111111-1111-4111-8111-111111111111",
    name: "Notebook fixture key",
    kind: "api_token",
    status: "active",
    tokenPrefix: "cld_fixture",
    scopes: ["read"],
    expiresAt: null,
    lastUsedAt: null,
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    revokedAt: null,
    revokedBy: null,
  },
});
let current: AuthenticatedServiceAccountCredential | null;
const spies: { mockRestore(): void }[] = [];
const { privateKey } = await generateKeyPair("RS256");
const withActiveSigner: typeof withActiveIdentitySigner = async (_purpose, callback) =>
  callback(
    { kid: "33333333-3333-4333-8333-333333333333", key: privateKey, issuer: "https://cloud.test", signUntil: new Date("2099-01-01") },
    sql,
  );

beforeEach(() => {
  setSystemTime(new Date("2026-10-22T12:00:00Z"));
  current = fixture();
  spies.push(spyOn(session, "getToken").mockReturnValue(null));
  spies.push(spyOn(session, "appSessionFallback").mockReturnValue(null));
  spies.push(spyOn(serviceAccountCredentials, "authenticateApiToken").mockImplementation(async () => current));
  spies.push(spyOn(registry, "listApps").mockResolvedValue(entries));
  spies.push(
    spyOn(registry, "getApp").mockImplementation(async (id) =>
      id === managed.id ? managed : (entries.find((app) => app.id === id) ?? null),
    ),
  );
  spies.push(spyOn(settings, "get").mockResolvedValue("all_users"));
  spies.push(spyOn(executions, "recordCapabilityExecution").mockResolvedValue("44444444-4444-4444-8444-444444444444"));
});
afterEach(() => {
  for (const spy of spies.splice(0).reverse()) spy.mockRestore();
  setSystemTime();
});
const denied = async () => new Response("Core denied", { status: 403 });
const broker = () => {
  const fetched: string[] = [];
  const router = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>()
    .use("*", requireAppAccess(core.meta, denied))
    .use("*", async (c, next) => {
      c.set("runtime", { apps: entries.map((app) => ({ ...app, nav: { href: `/app/${app.id}`, section: "primary" as const } })) });
      await next();
    })
    .route("/api/apps", appDiscoveryRoutes)
    .route("/cli/plugins", cliPluginListRoutes)
    .route("/_cloud/app-access", createAppAccessRoutes())
    .route(
      "/api",
      createCapabilityRoutes({
        listApps: async () => entries,
        getCapability: async (id) => (entries.some((app) => app.id === id) ? capability(id) : null),
        appUrl: async () => "https://cloud.test",
        withActiveSigner,
        // Keep the production issuance check. Canonical identity reload is the
        // auth-store fixture; the original binding/scopes are never widened.
        signInvocation: (params) =>
          issueInvocationToken(params, {
            resolve: async () => {
              let authority: RequestAuthority | null = null;
              const probe = new Hono<AuthContext>().use(auth.requireRole("authenticated")).get("/", (c) => {
                authority = auth.getAuthority(c);
                return c.body(null, 204);
              });
              await probe.request("/", { headers });
              return authority;
            },
          }),
        fetch: async (input) => {
          fetched.push(String(input));
          return Response.json({ data: { id: "fixture" } });
        },
      }),
    );
  return { router, fetched };
};

test("bound, standalone and delegated target-scoped keys cross Core and see only the target app", async () => {
  const { router } = broker();
  for (const kind of ["resource_bound", "standalone", "user_delegated"] as const) {
    current = fixture();
    if (kind !== "resource_bound") {
      current.serviceAccount = { ...current.serviceAccount, kind, appId: null, resourceType: null, resourceId: null };
      current.credential.scopes = ["notebooks:read"];
    }
    if (kind === "user_delegated") {
      current.delegatedUser = buildProjectedUser({
        id: "55555555-5555-4555-8555-555555555555",
        provider: "local",
        profile: "user",
        effective_admin: false,
      });
      current.serviceAccount.delegatedUserId = current.delegatedUser.id;
    }
    const catalog = await router.request("/api/capabilities/v1/catalog", { headers });
    expect(catalog.status).toBe(200);
    expect((await catalog.json()).apps.map((app: { appId: string }) => app.appId)).toEqual(["notebooks"]);
    const apps = await router.request("/api/apps", { headers });
    expect(apps.status).toBe(200);
    expect((await apps.json()).items.map((app: { id: string }) => app.id)).toEqual(["notebooks"]);
    const plugins = await router.request("/cli/plugins", { headers });
    expect(plugins.status).toBe(200);
    expect((await plugins.json()).plugins.map((plugin: { app: string }) => plugin.app)).toEqual(["notebooks"]);
  }
});

test("real invocation issuance allows the bound target and rejects a different target before provider fetch", async () => {
  const { router, fetched } = broker();
  const init = { method: "POST", headers, body: JSON.stringify({ input: { id: "fixture" } }) };
  const allowed = await router.request("/api/capabilities/v1/queries/notebooks/get", init);
  expect(allowed.status).toBe(200);
  expect(await allowed.json()).toEqual({ data: { id: "fixture" } });
  expect(fetched).toHaveLength(1);
  const blocked = await router.request("/api/capabilities/v1/queries/mail/get", init);
  expect(blocked.status).toBe(403);
  expect(await blocked.json()).toMatchObject({ code: "app_access_denied", app: "mail" });
  expect(fetched).toHaveLength(1);
});

test("Command links cross Core only for the currently usable target", async () => {
  const { router, fetched } = broker();
  const init = { method: "POST", headers, body: JSON.stringify({ input: {} }) };
  const allowed = await router.request("/api/capabilities/v1/commands/notebooks/compose", init);
  expect(allowed.status).toBe(200);
  expect(new URL((await allowed.json()).href).pathname).toBe("/app/notebooks");
  const blocked = await router.request("/api/capabilities/v1/commands/mail/compose", init);
  expect(blocked.status).toBe(403);
  expect(await blocked.json()).toMatchObject({ code: "app_access_denied", app: "mail" });
  expect(fetched).toHaveLength(0);
});

test("authentication remains required inside every exempted discovery and management router", async () => {
  current = null;
  const { router } = broker();
  for (const path of ["/api/capabilities/v1/catalog", "/api/apps", "/cli/plugins", "/_cloud/app-access/inventory"]) {
    expect((await router.request(path)).status).toBe(401);
  }
});

test("app-prefixed write survives the stable 307 and reaches the real owner router before its use gate", async () => {
  current = fixture();
  current.serviceAccount = { ...current.serviceAccount, kind: "standalone", appId: null, resourceType: null, resourceId: null };
  current.credential.scopes = ["inventory:write"];
  const changes: Parameters<typeof management.changeAppAccess>[0][] = [];
  // The DB transaction is outside this routing test. Exercise its real
  // authorization guard for credentials rejected before any grant lookup.
  spies.push(
    spyOn(management, "changeAppAccess").mockImplementation(async (params) => {
      changes.push(params);
      if (params.authority.scopes.join() !== "inventory:write") {
        await management.requireAppAccessManager(params.authority, params.app);
        throw new Error("Ineligible credential passed the management guard");
      }
      return { canUse: true };
    }),
  );
  const owner = new Hono<AuthContext>()
    .route("/api/inventory/_cloud/access/inventory", createOwnedAppAccessRoutes(managed))
    .use("*", requireAppAccess(managed, denied));
  const { router } = broker();
  const init = {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "grant", principal: { type: "authenticated" }, permission: "read" }),
  };
  const redirect = await router.request("/_cloud/app-access/inventory", init);
  expect(redirect.status).toBe(307);
  expect(redirect.headers.get("location")).toBe("/api/inventory/_cloud/access/inventory");
  const response = await owner.request(redirect.headers.get("location")!, init);
  expect(response.status).toBe(200);
  expect(changes[0]?.authority).toMatchObject({ credentialKind: "api_key", scopes: ["inventory:write"] });
  expect(changes[0]?.repair).toBeUndefined();
  expect(await canUseApp(changes[0]!.authority, core.meta)).toBe(false);
  const repair = await router.request("/_cloud/app-access/inventory?repair=1", { headers });
  expect(repair.status).toBe(403);
  expect(await repair.json()).toMatchObject({ code: "FORBIDDEN" });
  for (const scopes of [["inventory:read"], ["mail:write"]]) {
    current.credential.scopes = scopes;
    const rejected = await owner.request(redirect.headers.get("location")!, init);
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ code: "FORBIDDEN" });
  }
  current = fixture();
  expect((await owner.request(redirect.headers.get("location")!, init)).status).toBe(403);
});

test("Core-owned neighbors stay behind ordinary entry", async () => {
  const { router } = broker();
  for (const path of ["/me", "/admin", "/api/ai/tasks"]) {
    const response = await router.request(path, { method: "POST", headers, body: "{}" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "app_access_denied", app: "core" });
  }
});

test("models-only and reserved workload keys still fail ordinary broker authentication", async () => {
  const { router } = broker();
  for (const scopes of [["ai:inference"], ["identity:invoke"]]) {
    current = fixture();
    current.credential.scopes = scopes;
    if (scopes[0] === "identity:invoke") {
      current.serviceAccount.resourceType = "cloud.app";
      current.serviceAccount.resourceId = "notebooks";
    }
    for (const path of ["/api/capabilities/v1/catalog", "/api/apps", "/cli/plugins", "/_cloud/app-access/inventory"]) {
      expect((await router.request(path, { headers })).status).toBe(401);
    }
  }
});
