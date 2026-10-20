// Pins today's reach of real admin routes for each credential kind.
// Step-up for admin routes will deliberately change the session-less rows
// when those routes require session-bound proof.
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import "../../../scripts/fixtures/authorization-preload";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { redis, sql } from "bun";
import { createLocalJWKSet, decodeJwt } from "jose";
import accountsRoutes from "../../../packages/accounts/src/api";
import coreSettingsRoutes from "../../../packages/cloud/src/api/admin-core-settings";
import identityRoutes from "../../../packages/cloud/src/api/admin-identity";
import { AI_INFERENCE_SCOPE } from "../../../packages/cloud/src/contracts/shared";
import { resolveInvocationAuthority } from "../../../packages/cloud/src/services/identity/invocation-actor";
import {
  type InvocationAuthority,
  signInvocationToken,
  verifyInvocationToken,
} from "../../../packages/cloud/src/services/identity/invocation-token";
import { listIdentityJwks } from "../../../packages/cloud/src/services/identity/key-ring";
import { getIdentityRuntimeConfig } from "../../../packages/cloud/src/services/identity/runtime-config";
import { authenticateWorkloadCredential } from "../../../packages/cloud/src/services/identity/workload-auth";
import { verifyAccessToken } from "../../../packages/cloud/src/services/oauth-tokens";
import { toPgTextArray, toPgUuidArray } from "../../../packages/cloud/src/services/postgres";
import { serviceAccountCredentials } from "../../../packages/cloud/src/services/service-account-credentials";
import {
  createTestAppSession,
  createTestBrowserSignIn,
  createTestSession,
} from "../../../packages/cloud/src/services/session/session.test-fixture";
import { loadCurrentUser } from "../../../packages/cloud/src/services/session/user";
import * as settings from "../../../packages/cloud/src/services/settings";
import oauthAdminRoutes from "../../../packages/oauth/src/api";
import type { OAuthScope } from "../../../packages/oauth/src/contracts";
import oauthRoutes from "../../../packages/oauth/src/oauth";
import * as clients from "../../../packages/oauth/src/service/clients";
import * as refreshTokens from "../../../packages/oauth/src/service/refresh-tokens";
import { uniqueCallerAddress } from "../../../scripts/fixtures/caller-address";

const suite = suiteFor("database", "valkey", "nats");
// Modules are called directly without their production prefix; only auth below /pwa/ depends on it.
type Routes = (path: string, init: RequestInit) => Response | Promise<Response>;

const expected = {
  "web session of an admin": {
    createServiceAccount: 201,
    saveSecuritySetting: 204,
    createLoginToken: 200,
    regenerateClientSecret: 200,
  },
  "cld OAuth token of an admin": {
    createServiceAccount: 201,
    saveSecuritySetting: 204,
    createLoginToken: 200,
    regenerateClientSecret: 200,
  },
  // These routes require no OAuth scope today.
  "read-only cld OAuth token of an admin": {
    createServiceAccount: 201,
    saveSecuritySetting: 204,
    createLoginToken: 200,
    regenerateClientSecret: 200,
  },
  "personal API key of an admin": {
    createServiceAccount: 201,
    saveSecuritySetting: 204,
    createLoginToken: 200,
    regenerateClientSecret: 200,
  },
  "mobile-app session of an admin": {
    createServiceAccount: 403,
    saveSecuritySetting: 403,
    createLoginToken: 403,
    regenerateClientSecret: 403,
  },
  "resource-bound API key": {
    createServiceAccount: 403,
    saveSecuritySetting: 403,
    createLoginToken: 403,
    regenerateClientSecret: 403,
  },
  "standalone service-account API key": {
    createServiceAccount: 403,
    saveSecuritySetting: 403,
    createLoginToken: 403,
    regenerateClientSecret: 403,
  },
  "client-credentials OAuth token of a standalone service account": {
    createServiceAccount: 403,
    saveSecuritySetting: 403,
    createLoginToken: 403,
    regenerateClientSecret: 403,
  },
  "personal API key of an expired admin": {
    createServiceAccount: 401,
    saveSecuritySetting: 401,
    createLoginToken: 401,
    regenerateClientSecret: 401,
  },
  "cld OAuth token of an expired admin": {
    createServiceAccount: 401,
    saveSecuritySetting: 401,
    createLoginToken: 401,
    regenerateClientSecret: 401,
  },
  "app workload key": {
    createServiceAccount: 401,
    saveSecuritySetting: 401,
    createLoginToken: 401,
    regenerateClientSecret: 401,
  },
  "models-only personal API key of an admin": {
    createServiceAccount: 401,
    saveSecuritySetting: 401,
    createLoginToken: 401,
    regenerateClientSecret: 401,
  },
  "invocation credential of an admin": {
    createServiceAccount: 401,
    saveSecuritySetting: 401,
    createLoginToken: 401,
    regenerateClientSecret: 401,
  },
  "mandate-backed invocation of an admin": {
    createServiceAccount: 401,
    saveSecuritySetting: 401,
    createLoginToken: 401,
    regenerateClientSecret: 401,
  },
  "no credential": {
    createServiceAccount: 401,
    saveSecuritySetting: 401,
    createLoginToken: 401,
    regenerateClientSecret: 401,
  },
  "web session of a non-admin": {
    createServiceAccount: 403,
    saveSecuritySetting: 403,
    createLoginToken: 403,
    regenerateClientSecret: 403,
  },
};

suite("Admin credential matrix", () => {
  const prefix = `admin-matrix-${crypto.randomUUID()}`;
  const adminId = crypto.randomUUID();
  const expiredAdminId = crypto.randomUUID();
  const targetId = crypto.randomUUID();
  const boundId = crypto.randomUUID();
  const standaloneId = crypto.randomUUID();
  const userIds = toPgUuidArray([adminId, expiredAdminId, targetId]);
  const settingKey = "user.session.expiry_hours";
  let settingExisted: boolean | undefined;
  let settingValue: number;
  let clientId: string;
  const loginTokens: string[] = [];
  const credentials = new Map<string, (appId: string) => Promise<Headers>>();

  const bearer = (token: string) => async () => new Headers({ authorization: `Bearer ${token}` });
  // Fetch metadata keeps pwa_session eligible outside /pwa/; a navigation would ignore it.
  const cookie = (value: string, origin: string) => async () =>
    new Headers({ cookie: value, origin, "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin" });

  beforeAll(async () => {
    const [setting] = await sql<{ key: string }[]>`SELECT key FROM settings.entries WHERE key = ${settingKey}`;
    settingExisted = setting !== undefined;
    settingValue = await settings.get<number>(settingKey);

    await sql`
      INSERT INTO auth.users (id, uid, provider, profile, display_name, mail, given_name, sn, admin)
      VALUES
        (${adminId}::uuid, ${`${prefix}-admin`}, 'local', 'user', 'Matrix admin', ${`${prefix}-admin@example.test`}, 'Matrix', 'Admin', true),
        (${expiredAdminId}::uuid, ${`${prefix}-expired`}, 'local', 'user', 'Matrix expired admin', ${`${prefix}-expired@example.test`}, 'Matrix', 'Admin', true),
        (${targetId}::uuid, ${`${prefix}-target`}, 'local', 'user', 'Matrix target', ${`${prefix}-target@example.test`}, 'Matrix', 'Target', false)
    `;
    const { groupsAdmin, issuer } = await getIdentityRuntimeConfig();
    const admin = await loadCurrentUser({ userId: adminId, groupsAdmin });
    const expiredAdmin = await loadCurrentUser({ userId: expiredAdminId, groupsAdmin });
    if (!admin || !expiredAdmin) throw new Error("Admin fixture projection is missing");

    const webSession = cookie(`session_token=${await createTestSession(adminId)}`, issuer);
    credentials.set("web session of an admin", webSession);
    credentials.set("web session of a non-admin", cookie(`session_token=${await createTestSession(targetId)}`, issuer));
    const mobile = await createTestAppSession(adminId);
    credentials.set("mobile-app session of an admin", cookie(`pwa_session=${mobile.token}`, issuer));

    const cli = await clients.getByClientId({ clientId: "cloud-cli" });
    if (!cli) throw new Error("Seeded cloud-cli client is missing");
    const mintCldToken = async (
      userId: string,
      scopes: OAuthScope[] = ["openid", "profile", "email", "offline_access", "read", "write"],
    ) => {
      const [account] = await sql<{ auth_epoch: string | number }[]>`SELECT auth_epoch FROM auth.users WHERE id = ${userId}::uuid`;
      const refresh = await refreshTokens.reserve({
        userId,
        authEpoch: Number(account!.auth_epoch),
        client: cli,
        scopes,
        expiresAt: new Date(Date.now() + refreshTokens.DEFAULT_LOGIN_LIFETIME_SECONDS * 1000),
      });
      await sql`UPDATE oauth.refresh_token_families SET status = 'active' WHERE id = ${refresh.familyId}::uuid`;
      const exchanged = await oauthRoutes.request("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": uniqueCallerAddress() },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: "cloud-cli", refresh_token: refresh.refreshToken }),
      });
      expect(exchanged.status).toBe(200);
      const body: unknown = await exchanged.json();
      if (!body || typeof body !== "object" || !("access_token" in body) || typeof body.access_token !== "string") {
        throw new Error("CLI refresh did not return an access token");
      }
      const claims = decodeJwt(body.access_token);
      expect(claims.client_id).toBe("cloud-cli");
      expect(claims.sub).toBe(userId);
      return body.access_token;
    };
    credentials.set("cld OAuth token of an admin", bearer(await mintCldToken(adminId)));
    const readOnlyCldToken = await mintCldToken(adminId, ["openid", "read"]);
    const scope = decodeJwt(readOnlyCldToken).scope;
    if (typeof scope !== "string") throw new Error("CLI access token scope is not a string");
    expect(scope.split(/\s+/)).not.toContain("write");
    credentials.set("read-only cld OAuth token of an admin", bearer(readOnlyCldToken));
    const expiredCldToken = await mintCldToken(expiredAdminId);
    credentials.set("cld OAuth token of an expired admin", bearer(expiredCldToken));

    for (const access of ["full", "models"] as const) {
      const created = await serviceAccountCredentials.createUserApiToken({
        user: admin,
        browserSignIn: await createTestBrowserSignIn(admin.id),
        access,
        name: `${prefix}-${access}`,
      });
      if (!created.ok) throw new Error(created.error.message);
      if (access === "models") {
        const authenticated = await serviceAccountCredentials.authenticateApiToken(created.data.token);
        expect(authenticated?.credential.scopes).toContain(AI_INFERENCE_SCOPE);
      }
      credentials.set(
        access === "full" ? "personal API key of an admin" : "models-only personal API key of an admin",
        bearer(created.data.token),
      );
    }
    const expiredKey = await serviceAccountCredentials.createUserApiToken({
      user: expiredAdmin,
      browserSignIn: await createTestBrowserSignIn(expiredAdmin.id),
      access: "full",
      name: `${prefix}-expired-full`,
    });
    if (!expiredKey.ok) throw new Error(expiredKey.error.message);
    expect((await serviceAccountCredentials.authenticateApiToken(expiredKey.data.token))?.delegatedUser?.id).toBe(expiredAdminId);
    credentials.set("personal API key of an expired admin", bearer(expiredKey.data.token));
    const verified = await verifyAccessToken(expiredCldToken);
    expect(verified?.kind).toBe("user");
    expect(verified?.kind === "user" ? verified.user.id : null).toBe(expiredAdminId);
    await sql`UPDATE auth.users SET account_expires = now() - interval '1 day' WHERE id = ${expiredAdminId}::uuid`;
    await sql`
      INSERT INTO auth.service_accounts (id, name, kind, app_id, resource_type, resource_id, created_by)
      VALUES
        (${boundId}::uuid, ${`${prefix}-bound`}, 'resource_bound', 'notebooks', 'notebook', ${crypto.randomUUID()}, ${adminId}::uuid),
        (${standaloneId}::uuid, ${`${prefix}-standalone`}, 'standalone', NULL, NULL, NULL, ${adminId}::uuid)
    `;
    const bound = await serviceAccountCredentials.createResourceApiToken({
      serviceAccountId: boundId,
      actor: admin,
      name: `${prefix}-bound`,
    });
    if (!bound.ok) throw new Error(bound.error.message);
    credentials.set("resource-bound API key", bearer(bound.data.token));
    const standalone = await serviceAccountCredentials.createStandaloneApiToken({
      serviceAccountId: standaloneId,
      actor: admin,
      name: `${prefix}-standalone`,
    });
    if (!standalone.ok) throw new Error(standalone.error.message);
    credentials.set("standalone service-account API key", bearer(standalone.data.token));
    const workloadHeaders = await webSession();
    workloadHeaders.set("content-type", "application/json");
    workloadHeaders.set("x-forwarded-for", uniqueCallerAddress());
    const workload = await identityRoutes.request(`/workloads/${prefix}/credentials`, {
      method: "POST",
      headers: workloadHeaders,
      body: JSON.stringify({ name: `${prefix}-workload`, scopes: ["identity:invoke"] }),
    });
    expect(workload.status).toBe(201);
    const workloadBody: unknown = await workload.json();
    if (!workloadBody || typeof workloadBody !== "object" || !("token" in workloadBody) || typeof workloadBody.token !== "string") {
      throw new Error("Workload issuer did not return a token");
    }
    expect(await authenticateWorkloadCredential({ token: workloadBody.token, appId: prefix, scope: "identity:invoke" })).not.toBeNull();
    credentials.set("app workload key", bearer(workloadBody.token));
    // The platform's own verifier accepts each invocation fixture, so a 401 below comes from the admin route.
    const invocationKey = createLocalJWKSet(await listIdentityJwks("invocation"));
    const invocation = async (label: string, authority: InvocationAuthority) => {
      const sign = (targetAppId: string) =>
        signInvocationToken({ targetAppId, callingAppId: "core", operation: "admin.matrix", schemaHash: null, authority });
      const claims = await verifyInvocationToken(
        (await sign("core")).token,
        { targetAppId: "core", operation: "admin.matrix", schemaHash: null },
        { issuer, key: invocationKey },
      );
      if (!claims) throw new Error(`Invocation fixture does not verify: ${label}`);
      const resolved = await resolveInvocationAuthority(claims);
      expect(resolved?.actor.kind === "user" && resolved.actor.user.roles.includes("admin")).toBe(true);
      credentials.set(label, async (targetAppId) => bearer((await sign(targetAppId)).token)());
    };
    const userAuthority = {
      sub: adminId,
      principal_type: "user",
      access_subject_type: "user",
      access_subject_id: adminId,
      scopes: [],
    } satisfies Partial<InvocationAuthority>;
    await invocation("invocation credential of an admin", { ...userAuthority, credential_kind: "session" });
    await invocation("mandate-backed invocation of an admin", {
      ...userAuthority,
      credential_kind: "mandate",
      mandate_id: crypto.randomUUID(),
      mandate_revision: 1,
      workload_type: "task",
      workload_id: prefix,
    });
    credentials.set("no credential", async () => new Headers());

    const confidential = await clients.create({
      actor: admin,
      data: {
        name: `${prefix}-confidential`,
        redirectUris: [],
        scopes: ["openid"],
        audiences: ["cloud"],
        serviceAccountId: standaloneId,
        allowedProfiles: ["user"],
        accessMode: "profiles",
        allowedUserIds: [],
        allowedGroupIds: [],
        isPublic: false,
      },
    });
    if (!confidential.ok) throw new Error(confidential.error);
    clientId = confidential.data.id;
    const exchanged = await oauthRoutes.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": uniqueCallerAddress() },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: confidential.data.clientId,
        client_secret: confidential.data.clientSecret,
      }),
    });
    expect(exchanged.status).toBe(200);
    const body: unknown = await exchanged.json();
    if (!body || typeof body !== "object" || !("access_token" in body) || typeof body.access_token !== "string") {
      throw new Error("Client credentials did not return an access token");
    }
    expect(decodeJwt(body.access_token).aud).toContain("cloud");
    credentials.set("client-credentials OAuth token of a standalone service account", bearer(body.access_token));
  }, 30_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    try {
      for (const token of loginTokens) await redis.del(`email-login:${token}`);
    } catch (error) {
      errors.push(error);
    }
    try {
      await sql.begin(async (tx) => {
        const accounts = await tx<{ id: string }[]>`
          SELECT id FROM auth.service_accounts
          WHERE created_by = ANY(${userIds}::uuid[]) OR delegated_user_id = ANY(${userIds}::uuid[]) OR name LIKE ${`${prefix}%`}
        `;
        const accountIds = toPgUuidArray(accounts.map((account) => account.id));
        const keys = await tx<{ id: string }[]>`
          SELECT id FROM auth.service_account_credentials WHERE service_account_id = ANY(${accountIds}::uuid[])
        `;
        const oauthClients = await tx<{ id: string }[]>`SELECT id FROM oauth.clients WHERE created_by = ANY(${userIds}::uuid[])`;
        const targetIds = toPgTextArray([
          adminId,
          expiredAdminId,
          targetId,
          ...accounts.map((account) => account.id),
          ...keys.map((key) => key.id),
          ...oauthClients.map((client) => client.id),
        ]);
        await tx`
          DELETE FROM audit.events
          WHERE actor_user_id = ANY(${userIds}::uuid[]) OR target_id = ANY(${targetIds}::text[]) OR target_label LIKE ${`${prefix}%`}
        `;
        await tx`
          DELETE FROM logging.entries
          WHERE message = 'Admin created local login token' AND metadata->>'targetUserId' = ${targetId}
        `;
        await tx`DELETE FROM oauth.refresh_token_families WHERE user_id = ANY(${userIds}::uuid[])`;
        await tx`DELETE FROM oauth.clients WHERE created_by = ANY(${userIds}::uuid[])`;
        await tx`DELETE FROM auth.service_account_credentials WHERE service_account_id = ANY(${accountIds}::uuid[])`;
        await tx`DELETE FROM auth.access WHERE service_account_id = ANY(${accountIds}::uuid[]) OR user_id = ANY(${userIds}::uuid[])`;
        await tx`DELETE FROM auth.service_accounts WHERE id = ANY(${accountIds}::uuid[])`;
        await tx`DELETE FROM auth.session_families WHERE user_id = ANY(${userIds}::uuid[])`;
        await tx`DELETE FROM auth.pwa_devices WHERE user_id = ANY(${userIds}::uuid[])`;
        await tx`DELETE FROM auth.users WHERE id = ANY(${userIds}::uuid[])`;
      });
    } catch (error) {
      errors.push(error);
    }
    try {
      if (settingExisted === false) await settings.remove(settingKey);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw errors[0];
  }, 30_000);

  for (const [label, statuses] of Object.entries(expected)) {
    test(label, async () => {
      const headersFor = credentials.get(label);
      if (!headersFor) throw new Error(`Missing credential fixture: ${label}`);
      const request = async (owner: string, routes: Routes, path: string, method: string, body?: unknown) => {
        const headers = await headersFor(owner);
        headers.set("x-forwarded-for", uniqueCallerAddress());
        if (body !== undefined) headers.set("content-type", "application/json");
        return routes(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      };
      // POST /api/admin/identity/service-accounts
      const created = await request("core", identityRoutes.request, "/service-accounts", "POST", {
        name: `${prefix}-${crypto.randomUUID()}`,
        kind: "standalone",
      });
      // PUT /api/admin/core/settings
      const [settingBefore] = await sql<{ updated_at: number }[]>`
        SELECT extract(epoch FROM updated_at)::double precision AS updated_at FROM settings.entries WHERE key = ${settingKey}
      `;
      const saved = await request("core", coreSettingsRoutes.request, "/", "PUT", { [settingKey]: settingValue });
      const [settingAfter] = await sql<{ updated_at: number }[]>`
        SELECT extract(epoch FROM updated_at)::double precision AS updated_at FROM settings.entries WHERE key = ${settingKey}
      `;
      if (statuses.saveSecuritySetting === 204) {
        if (!settingAfter) throw new Error("Successful settings save did not write a row");
        if (settingBefore) expect(settingAfter.updated_at).toBeGreaterThan(settingBefore.updated_at);
      } else {
        expect(settingAfter).toEqual(settingBefore);
      }
      // POST /api/accounts/users/:id/login-token
      const login = await request("accounts", accountsRoutes.request, `/users/${targetId}/login-token`, "POST");
      // Read only to remove the one-time credential from Valkey; never assert or print it.
      if (login.status === 200) {
        const body: unknown = await login.json();
        if (!body || typeof body !== "object" || !("token" in body) || typeof body.token !== "string") {
          throw new Error("Cannot track login token for cleanup");
        }
        loginTokens.push(body.token);
      }
      // POST /api/oauth/admin/clients/:id/regenerate-secret
      const regenerated = await request("oauth", oauthAdminRoutes.request, `/${clientId}/regenerate-secret`, "POST");
      expect({
        createServiceAccount: created.status,
        saveSecuritySetting: saved.status,
        createLoginToken: login.status,
        regenerateClientSecret: regenerated.status,
      }).toEqual(statuses);
    });
  }
});
