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

const dependencies = (overrides: Partial<Dependencies> = {}): Dependencies => ({
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
  },
  credentials: {
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
