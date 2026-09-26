import { describe, expect, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import type { MiddlewareHandler } from "hono";
import type { AuthContext } from "../server";
import { createAdminIdentityRoutes } from "./admin-identity";

const pass: MiddlewareHandler<AuthContext> = async (_c, next) => next();
const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const SERVICE_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const CREDENTIAL_ID = "33333333-3333-4333-8333-333333333333";
const admin = { id: ADMIN_ID, roles: ["admin"] } as AuthContext["Variables"]["user"];
const authenticateAdmin: MiddlewareHandler<AuthContext> = async (c, next) => {
  c.set("user", admin);
  await next();
};

type Dependencies = NonNullable<Parameters<typeof createAdminIdentityRoutes>[1]>;
const STANDALONE_ID = "44444444-4444-4444-8444-444444444444";
type StandaloneAccount = Awaited<ReturnType<Dependencies["serviceAccounts"]["listStandalone"]>>["items"][number];
const standaloneAccount = (overrides: Partial<StandaloneAccount> = {}): StandaloneAccount => ({
  id: STANDALONE_ID,
  name: "Release agent",
  kind: "agent",
  status: "active",
  delegatedUserId: null,
  appId: null,
  resourceType: null,
  resourceId: null,
  createdBy: ADMIN_ID,
  createdAt: "2026-09-02T00:00:00.000Z",
  ...overrides,
});

const dependencies = (overrides: Partial<Dependencies> = {}): Dependencies => ({
  apps: async () => [{ id: "inventory", name: "Inventory" }],
  status: async () => [],
  rewrap: async () => 0,
  revoke: async () => false,
  serviceAccounts: {
    getOrCreateResourceBound: async ({ name, appId, resourceType, resourceId, createdBy }) =>
      ok({
        id: SERVICE_ACCOUNT_ID,
        name,
        kind: "resource_bound",
        status: "active",
        delegatedUserId: null,
        appId,
        resourceType,
        resourceId,
        createdBy: createdBy ?? null,
        createdAt: "2026-09-02T00:00:00.000Z",
      }),
    createStandalone: async ({ name, kind, createdBy }) => ok(standaloneAccount({ name, kind, createdBy: createdBy ?? null })),
    listStandalone: async () => ({ items: [standaloneAccount()], page: 1, perPage: 100, total: 1, hasNext: false }),
    get: async ({ id }) => (id === STANDALONE_ID ? standaloneAccount() : null),
    setStatus: async () => ok(),
  },
  credentials: {
    createStandaloneApiToken: async ({ serviceAccountId, name, scopes, expiresAt, actor }) =>
      ok({
        credential: {
          id: CREDENTIAL_ID,
          serviceAccountId,
          name,
          kind: "api_token",
          status: "active",
          tokenPrefix: "cld_standalone_preview",
          scopes: scopes ?? [],
          expiresAt: expiresAt ?? null,
          lastUsedAt: null,
          createdBy: actor.id,
          createdAt: "2026-09-02T00:00:00.000Z",
          revokedAt: null,
          revokedBy: null,
        },
        token: "cld_standalone_preview.only-once-secret",
      }),
    createResourceApiToken: async ({ serviceAccountId, name, scopes, expiresAt, actor }) =>
      ok({
        credential: {
          id: CREDENTIAL_ID,
          serviceAccountId,
          name,
          kind: "api_token",
          status: "active",
          tokenPrefix: "cld_live_preview",
          scopes: scopes ?? [],
          expiresAt: expiresAt ?? null,
          lastUsedAt: null,
          createdBy: actor.id,
          createdAt: "2026-09-02T00:00:00.000Z",
          revokedAt: null,
          revokedBy: null,
        },
        token: "cld_live_preview.only-once-secret",
      }),
    listOverview: async () => ({ items: [], page: 1, perPage: 500, total: 0, hasNext: false }),
    getOverview: async () => null,
    revoke: async () => ok(),
  },
  mandates: {
    list: async ({ pagination }) => ({
      items: [],
      page: pagination?.page ?? 1,
      perPage: pagination?.perPage ?? 50,
      total: 0,
      hasNext: false,
    }),
  },
  audit: { record: async () => undefined },
  ...overrides,
});

describe("identity key administration", () => {
  test("requires an administrator by default", async () => {
    expect((await createAdminIdentityRoutes().request("/keys")).status).toBe(401);
  });

  test("returns only operational key metadata", async () => {
    const routes = createAdminIdentityRoutes(
      pass,
      dependencies({
        status: async () => [
          {
            purpose: "session",
            state: "active",
            kid: "00000000-0000-4000-8000-000000000000",
            alg: "RS256",
            encryptionKeyId: "0123456789abcdef",
            createdAt: "2026-09-01T00:00:00.000Z",
            activateAt: "2026-09-01T00:00:00.000Z",
            signUntil: "2026-10-01T00:00:00.000Z",
            verifyUntil: "2026-10-02T00:00:00.000Z",
            revokedAt: null,
          },
        ],
        rewrap: async () => 0,
        revoke: async () => false,
      }),
    );
    const body = await (await routes.request("/keys")).json();
    expect(body.keys[0]).toEqual(expect.objectContaining({ purpose: "session", state: "active", alg: "RS256" }));
    expect(body.mandateMetrics).toEqual(
      expect.objectContaining({
        issue_allowed: expect.any(Number),
        issue_denied_policy: expect.any(Number),
        issue_denied_subject: expect.any(Number),
      }),
    );
    expect(JSON.stringify(body)).not.toContain("private");
  });

  test("rewraps and revokes through bounded commands", async () => {
    const revoked: Array<{ kid: string; reason: string }> = [];
    const routes = createAdminIdentityRoutes(
      pass,
      dependencies({
        apps: async () => [{ id: "inventory", name: "Inventory" }],
        status: async () => [],
        rewrap: async () => 3,
        revoke: async (input) => {
          revoked.push(input);
          return true;
        },
      }),
    );

    expect(await (await routes.request("/keys/rewrap", { method: "POST" })).json()).toEqual({ rewrapped: 3 });
    const response = await routes.request("/keys/00000000-0000-4000-8000-000000000000/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "suspected exposure" }),
    });
    expect(response.status).toBe(200);
    expect(revoked).toEqual([{ kid: "00000000-0000-4000-8000-000000000000", reason: "suspected exposure" }]);
  });

  test("provisions one app-bound credential with only explicit workload scopes", async () => {
    const accountInputs: Array<Parameters<Dependencies["serviceAccounts"]["getOrCreateResourceBound"]>[0]> = [];
    const credentialInputs: Array<Parameters<Dependencies["credentials"]["createResourceApiToken"]>[0]> = [];
    const base = dependencies();
    const routes = createAdminIdentityRoutes(
      authenticateAdmin,
      dependencies({
        serviceAccounts: {
          ...base.serviceAccounts,
          getOrCreateResourceBound: async (input) => {
            accountInputs.push(input);
            return base.serviceAccounts.getOrCreateResourceBound(input);
          },
        },
        credentials: {
          ...base.credentials,
          createResourceApiToken: async (input) => {
            credentialInputs.push(input);
            return base.credentials.createResourceApiToken(input);
          },
        },
      }),
    );

    const response = await routes.request("/workloads/mail/credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "mail background", scopes: ["identity:invoke"] }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      credential: { id: CREDENTIAL_ID, scopes: ["identity:invoke"], tokenPrefix: "cld_live_preview" },
      token: "cld_live_preview.only-once-secret",
    });
    expect(accountInputs).toEqual([
      {
        name: "mail workload",
        appId: "mail",
        resourceType: "cloud.app",
        resourceId: "mail",
        createdBy: ADMIN_ID,
      },
    ]);
    expect(credentialInputs).toHaveLength(1);
    expect(credentialInputs[0]).toMatchObject({ serviceAccountId: SERVICE_ACCOUNT_ID, actor: admin, scopes: ["identity:invoke"] });
  });

  test("rejects unknown or duplicate scopes before provisioning", async () => {
    let called = false;
    const base = dependencies();
    const routes = createAdminIdentityRoutes(
      authenticateAdmin,
      dependencies({
        serviceAccounts: {
          ...base.serviceAccounts,
          getOrCreateResourceBound: async (input) => {
            called = true;
            return base.serviceAccounts.getOrCreateResourceBound(input);
          },
        },
      }),
    );

    for (const scopes of [["mail:send"], ["identity:oauth-issue"], ["identity:invoke", "identity:invoke"]]) {
      const response = await routes.request("/workloads/mail/credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "invalid", scopes }),
      });
      expect(response.status).toBe(400);
    }
    expect(called).toBeFalse();
  });

  test("lists metadata without secrets and only revokes credentials bound to the requested app", async () => {
    const base = dependencies();
    const credentialResult = await base.credentials.createResourceApiToken({
      serviceAccountId: SERVICE_ACCOUNT_ID,
      actor: admin,
      name: "mail background",
      scopes: ["identity:invoke"],
    });
    if (!credentialResult.ok) throw new Error("Test credential setup failed");
    const serviceAccountResult = await base.serviceAccounts.getOrCreateResourceBound({
      name: "mail workload",
      appId: "mail",
      resourceType: "cloud.app",
      resourceId: "mail",
    });
    if (!serviceAccountResult.ok) throw new Error("Test service account setup failed");
    const overview = {
      ...credentialResult.data.credential,
      serviceAccount: serviceAccountResult.data,
      owner: { type: "resource" as const, appId: "mail", resourceType: "cloud.app", resourceId: "mail" },
    };
    const revoked: string[] = [];
    const routes = createAdminIdentityRoutes(
      authenticateAdmin,
      dependencies({
        credentials: {
          ...base.credentials,
          listOverview: async () => ({ items: [overview], page: 1, perPage: 500, total: 1, hasNext: false }),
          getOverview: async () => overview,
          revoke: async ({ credentialId }) => {
            revoked.push(credentialId);
            return ok();
          },
        },
      }),
    );

    const listed = await routes.request("/workloads/mail/credentials");
    expect(listed.status).toBe(200);
    expect(JSON.stringify(await listed.json())).not.toContain("only-once-secret");

    const wrongApp = await routes.request(`/workloads/oauth/credentials/${CREDENTIAL_ID}`, { method: "DELETE" });
    expect(wrongApp.status).toBe(404);
    expect(revoked).toEqual([]);

    const correctApp = await routes.request(`/workloads/mail/credentials/${CREDENTIAL_ID}`, { method: "DELETE" });
    expect(correctApp.status).toBe(200);
    expect(await correctApp.json()).toEqual({ revoked: true });
    expect(revoked).toEqual([CREDENTIAL_ID]);
  });

  test("lists mandates through a bounded administrator scope", async () => {
    const calls: unknown[] = [];
    const routes = createAdminIdentityRoutes(
      authenticateAdmin,
      dependencies({
        mandates: {
          list: async (input) => {
            calls.push(input);
            return { items: [], page: 2, perPage: 100, total: 0, hasNext: false };
          },
        },
      }),
    );

    const response = await routes.request("/mandates?page=2&perPage=100&ownerAppId=mail&state=paused");
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        scope: { kind: "admin" },
        pagination: { page: 2, perPage: 100 },
        filter: { ownerAppId: "mail", state: "paused" },
      },
    ]);
    expect((await routes.request("/mandates?perPage=101")).status).toBe(400);
  });
});

test("registered workload apps are admin-only and return no credentials", async () => {
  expect((await createAdminIdentityRoutes().request("/workloads")).status).toBe(401);
  const response = await createAdminIdentityRoutes(authenticateAdmin, dependencies()).request("/workloads");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual([{ id: "inventory", name: "Inventory" }]);
});

test("lists app credentials across apps with bounded pagination and admin access", async () => {
  expect((await createAdminIdentityRoutes().request("/workloads/credentials")).status).toBe(401);
  const base = dependencies();
  let received: Parameters<typeof base.credentials.listOverview>[0];
  const routes = createAdminIdentityRoutes(
    authenticateAdmin,
    dependencies({
      credentials: {
        ...base.credentials,
        listOverview: async (input) => {
          received = input;
          return { items: [], page: 2, perPage: 20, total: 0, hasNext: false };
        },
      },
    }),
  );
  const response = await routes.request("/workloads/credentials?page=2&perPage=20");
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(received).toEqual({
    pagination: { page: 2, perPage: 20 },
    filter: { serviceAccountKind: "resource_bound", resourceType: "cloud.app" },
  });
  expect((await routes.request("/workloads/credentials?perPage=501")).status).toBe(400);
});

describe("standalone service accounts", () => {
  test("creates an account with the requested kind, audits it, and starts it without credentials", async () => {
    const base = dependencies();
    const created: Parameters<Dependencies["serviceAccounts"]["createStandalone"]>[0][] = [];
    const audited: Parameters<Dependencies["audit"]["record"]>[0][] = [];
    const routes = createAdminIdentityRoutes(
      authenticateAdmin,
      dependencies({
        serviceAccounts: {
          ...base.serviceAccounts,
          createStandalone: async (input) => {
            created.push(input);
            return base.serviceAccounts.createStandalone(input);
          },
        },
        audit: {
          record: async (event) => {
            audited.push(event);
          },
        },
      }),
    );
    expect((await createAdminIdentityRoutes().request("/service-accounts", { method: "POST" })).status).toBe(401);

    const response = await routes.request("/service-accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Release agent", kind: "agent" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({ id: STANDALONE_ID, kind: "agent", status: "active", delegatedUserId: null, appId: null });
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(created).toEqual([{ name: "Release agent", kind: "agent", createdBy: ADMIN_ID }]);
    expect(audited[0]).toMatchObject({ action: "service_account.create", actor: { userId: ADMIN_ID }, target: { id: STANDALONE_ID } });

    const defaulted = await routes.request("/service-accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Integration" }),
    });
    expect(defaulted.status).toBe(201);
    expect(created[1]?.kind).toBe("standalone");

    const rejected = await routes.request("/service-accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Bound", kind: "resource_bound" }),
    });
    expect(rejected.status).toBe(400);
    expect(created).toHaveLength(2);
  });

  test("lists and reads only standalone kinds", async () => {
    const base = dependencies();
    let received: Parameters<Dependencies["serviceAccounts"]["listStandalone"]>[0] | undefined;
    const routes = createAdminIdentityRoutes(
      authenticateAdmin,
      dependencies({
        serviceAccounts: {
          ...base.serviceAccounts,
          listStandalone: async (input) => {
            received = input;
            return base.serviceAccounts.listStandalone(input);
          },
          get: async ({ id }) =>
            id === STANDALONE_ID
              ? standaloneAccount()
              : id === SERVICE_ACCOUNT_ID
                ? standaloneAccount({ id, kind: "resource_bound", appId: "mail", resourceType: "cloud.app", resourceId: "mail" })
                : null,
        },
      }),
    );
    const list = await routes.request("/service-accounts?kind=agent&status=active&perPage=20");
    expect(list.status).toBe(200);
    expect(received).toEqual({ page: 1, perPage: 20, kind: "agent", status: "active" });
    expect(await list.json()).toMatchObject({ items: [{ id: STANDALONE_ID, kind: "agent" }], total: 1 });
    expect((await routes.request("/service-accounts?kind=user_delegated")).status).toBe(400);

    expect((await routes.request(`/service-accounts/${STANDALONE_ID}`)).status).toBe(200);
    expect((await routes.request(`/service-accounts/${SERVICE_ACCOUNT_ID}`)).status).toBe(404);
    expect((await routes.request(`/service-accounts/${CREDENTIAL_ID}`)).status).toBe(404);
  });

  test("disables an account centrally and mints an API key only for standalone kinds", async () => {
    const base = dependencies();
    const statusChanges: Parameters<Dependencies["serviceAccounts"]["setStatus"]>[0][] = [];
    const audited: string[] = [];
    const routes = createAdminIdentityRoutes(
      authenticateAdmin,
      dependencies({
        serviceAccounts: {
          ...base.serviceAccounts,
          setStatus: async (input) => {
            statusChanges.push(input);
            return ok();
          },
        },
        audit: {
          record: async (event) => {
            audited.push(event.action);
          },
        },
      }),
    );
    const disabled = await routes.request(`/service-accounts/${STANDALONE_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "disabled" }),
    });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ id: STANDALONE_ID, status: "disabled" });
    expect(statusChanges).toEqual([{ id: STANDALONE_ID, status: "disabled" }]);
    expect(audited).toEqual(["service_account.disable"]);
    expect(
      (
        await routes.request(`/service-accounts/${SERVICE_ACCOUNT_ID}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "disabled" }),
        })
      ).status,
    ).toBe(404);
    expect(statusChanges).toHaveLength(1);

    const key = await routes.request(`/service-accounts/${STANDALONE_ID}/api-keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ci" }),
    });
    expect(key.status).toBe(201);
    expect(await key.json()).toMatchObject({ credential: { serviceAccountId: STANDALONE_ID, scopes: [] }, token: expect.any(String) });
  });
});
