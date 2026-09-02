import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { generateKeyPair, jwtVerify } from "jose";
import { createIdentityOAuthIssuanceRoutes } from "./identity-oauth-issuance";

const USER_ID = "68df7d96-aaab-420a-ab1e-62a67e44d3be";
const userAccess = {
  kind: "user_access" as const,
  grant: { kind: "authorization_code" as const, code: "opaque-code", nonce: "a5ae9b9c-94f4-49a8-a954-c87839affc3d" },
  expiresIn: 3_600 as const,
};

const authorityState = (overrides: Record<string, unknown> = {}) => ({
  clientId: "test-client",
  clientScopes: ["openid", "profile"],
  clientAudiences: [],
  clientServiceAccountId: null,
  registrationKind: "managed",
  allowedProfiles: ["user"],
  accessMode: "profiles",
  specificAccess: false,
  grantedScopes: ["openid", "profile"],
  grantedAudiences: ["cloud", "test-client"],
  resource: null,
  nonce: null,
  user: {
    id: USER_ID,
    uid: "alice",
    profile: "user",
    displayName: "Alice Current",
    givenName: "Alice",
    familyName: "Current",
    email: "alice@example.test",
    accountExpires: null,
    groups: ["current-group"],
  },
  serviceAccount: null,
  ...overrides,
});

const setup = async (authenticated = true, state = authorityState()) => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  let authCalls = 0;
  const routes = createIdentityOAuthIssuanceRoutes({
    authenticate: async (params) => {
      authCalls += 1;
      expect(params).toMatchObject({ token: "workload", appId: "oauth", scope: "identity:oauth-issue" });
      return authenticated
        ? { appId: "oauth", serviceAccountId: crypto.randomUUID(), credentialId: crypto.randomUUID(), scope: "identity:oauth-issue" }
        : null;
    },
    withActiveSigner: async (_purpose, callback) =>
      callback({ kid: "70eb97eb-a2a4-4454-aca5-d1d84af1239c", key: privateKey, signUntil: new Date(Date.now() + 60_000) }),
    issuer: async () => "https://cloud.example.test",
    resolve: async () => state,
    transaction: async (callback) => callback(sql),
    now: () => 1_788_220_800,
  });
  return { routes, publicKey, authCalls: () => authCalls };
};

describe("Core OAuth issuance authority", () => {
  test("derives the user access-token authority from current state", async () => {
    const { routes, publicKey } = await setup();
    const response = await routes.request("/oauth/token", {
      method: "POST",
      headers: { authorization: "Bearer workload", "content-type": "application/json" },
      body: JSON.stringify({ tokens: [userAccess] }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { tokens: string[] };
    const verified = await jwtVerify(body.tokens[0]!, publicKey, {
      issuer: "https://cloud.example.test",
      audience: "cloud",
      currentDate: new Date(1_788_220_800_000),
    });
    expect(verified.protectedHeader).toMatchObject({ alg: "RS256", kid: "70eb97eb-a2a4-4454-aca5-d1d84af1239c" });
    expect(verified.payload).toMatchObject({
      sub: authorityState().user?.id,
      uid: "alice",
      id: authorityState().user?.id,
      token_use: "access",
      principal_type: "user",
      client_id: "test-client",
      scope: "openid profile",
    });
  });

  test("requires the exact OAuth workload before parsing the body", async () => {
    const { routes, authCalls } = await setup(false);
    const response = await routes.request("/oauth/token", {
      method: "POST",
      headers: { authorization: "Bearer workload", "content-type": "application/json" },
      body: "not-json",
    });
    expect(response.status).toBe(401);
    expect(authCalls()).toBe(1);
    expect(
      (
        await routes.request("/oauth/ready", {
          method: "POST",
          headers: { authorization: "Bearer workload" },
        })
      ).status,
    ).toBe(401);
  });

  test("probes workload and active OAuth signer readiness without consuming a grant", async () => {
    const { routes } = await setup();
    const response = await routes.request("/oauth/ready", {
      method: "POST",
      headers: { authorization: "Bearer workload" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("derives service-account binding from current state", async () => {
    const serviceAccountId = "cce0b815-8f75-4dad-b28f-ab40c0967718";
    const state = authorityState({
      user: null,
      clientServiceAccountId: serviceAccountId,
      clientScopes: ["read"],
      grantedScopes: ["read"],
      serviceAccount: {
        id: serviceAccountId,
        kind: "resource_bound",
        status: "active",
        delegatedUserId: null,
        appId: "mail",
        resourceType: "mailbox",
        resourceId: "inbox",
      },
    });
    const { routes, publicKey } = await setup(true, state);
    const response = await routes.request("/oauth/token", {
      method: "POST",
      headers: { authorization: "Bearer workload", "content-type": "application/json" },
      body: JSON.stringify({
        tokens: [
          {
            kind: "service_access",
            grant: {
              kind: "client_credentials",
              grantId: "dd8cc597-4268-43f2-abdf-ec008245ef10",
              nonce: "a771d825-b5d4-44d7-a0c2-17f97f37bd02",
            },
            expiresIn: 3_600,
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { tokens: string[] };
    const verified = await jwtVerify(body.tokens[0]!, publicKey, {
      issuer: "https://cloud.example.test",
      audience: "cloud",
      currentDate: new Date(1_788_220_800_000),
    });
    expect(verified.payload).toMatchObject({
      sub: serviceAccountId,
      service_account_id: serviceAccountId,
      service_account_kind: "resource_bound",
      app_id: "mail",
      resource_type: "mailbox",
      resource_id: "inbox",
    });
  });

  test("rejects arbitrary claims and expanded lifetimes", async () => {
    const { routes } = await setup();
    for (const token of [
      { ...userAccess, admin: true },
      { ...userAccess, userId: "forged" },
      { ...userAccess, expiresIn: 7_200 },
      { ...userAccess, kind: "arbitrary" },
      {
        kind: "service_access",
        grant: {
          kind: "client_credentials",
          grantId: "dd8cc597-4268-43f2-abdf-ec008245ef10",
          nonce: "a771d825-b5d4-44d7-a0c2-17f97f37bd02",
        },
        requestedScope: "admin",
        expiresIn: 3_600,
      },
    ]) {
      const response = await routes.request("/oauth/token", {
        method: "POST",
        headers: { authorization: "Bearer workload", "content-type": "application/json" },
        body: JSON.stringify({ tokens: [token] }),
      });
      expect(response.status).toBe(400);
    }
  });

  test("rejects stale principal, scope, audience, and access authority", async () => {
    for (const [token, state] of [
      [userAccess, authorityState({ grantedScopes: ["openid", "write"] })],
      [userAccess, authorityState({ resource: "https://attacker.example.test" })],
      [userAccess, authorityState({ allowedProfiles: ["guest"] })],
      [userAccess, authorityState({ accessMode: "specific", specificAccess: false })],
      [userAccess, authorityState({ user: { ...authorityState().user!, accountExpires: new Date(1_788_220_799_000) } })],
    ] as const) {
      const { routes } = await setup(true, state);
      const response = await routes.request("/oauth/token", {
        method: "POST",
        headers: { authorization: "Bearer workload", "content-type": "application/json" },
        body: JSON.stringify({ tokens: [token] }),
      });
      expect(response.status).toBe(403);
    }
  });
});

const canUseDatabase = async (): Promise<boolean> => {
  try {
    const [row] = await sql<{ users: string | null; clients: string | null; groups: string | null }[]>`
      SELECT to_regclass('auth.users')::text AS users,
        to_regclass('oauth.clients')::text AS clients,
        to_regclass('auth.groups')::text AS groups
    `;
    return Boolean(row?.users && row.clients && row.groups);
  } catch {
    return false;
  }
};

const databaseSuite = (await canUseDatabase()) ? describe : describe.skip;

databaseSuite("Core OAuth issuance authority database resolution", () => {
  test("loads current principal and client authority in the issuance request", async () => {
    const userId = crypto.randomUUID();
    const clientId = `core-authority-${crypto.randomUUID()}`;
    const code = crypto.randomUUID();
    const authorityNonce = crypto.randomUUID();
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    try {
      await sql`
        INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn, mail)
        VALUES (${userId}::uuid, ${`user-${userId}`}, 'local', 'user', 'Current User', 'Current', 'User', 'current@example.test')
      `;
      await sql`
        INSERT INTO oauth.clients (name, client_id, redirect_uris, scopes, audiences, allowed_profiles, access_mode, registration_kind, is_public)
        VALUES (${`Core authority ${userId}`}, ${clientId}, ARRAY['https://client.example.test/callback'],
          ARRAY['openid', 'profile'], ARRAY['cloud'], ARRAY['user'], 'profiles', 'managed', false)
      `;
      await sql`
        INSERT INTO oauth.codes (code, client_id, user_id, redirect_uri, scopes, audiences, used, authority_nonce)
        VALUES (${code}, ${clientId}, ${userId}::uuid, 'https://client.example.test/callback', ARRAY['openid', 'profile'],
          ARRAY['cloud', ${clientId}], true, ${authorityNonce}::uuid)
      `;
      const routes = createIdentityOAuthIssuanceRoutes({
        authenticate: async () => ({
          appId: "oauth",
          serviceAccountId: crypto.randomUUID(),
          credentialId: crypto.randomUUID(),
          scope: "identity:oauth-issue",
        }),
        withActiveSigner: async (_purpose, callback) =>
          callback({ kid: crypto.randomUUID(), key: privateKey, signUntil: new Date(Date.now() + 60_000) }),
        issuer: async () => "https://cloud.example.test",
      });
      const response = await routes.request("/oauth/token", {
        method: "POST",
        headers: { authorization: "Bearer workload", "content-type": "application/json" },
        body: JSON.stringify({
          tokens: [
            {
              kind: "user_access",
              grant: { kind: "authorization_code", code, nonce: authorityNonce },
              expiresIn: 3_600,
            },
          ],
        }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { tokens: string[] };
      expect(
        (await jwtVerify(body.tokens[0]!, publicKey, { issuer: "https://cloud.example.test", audience: clientId })).payload,
      ).toMatchObject({
        sub: userId,
        uid: `user-${userId}`,
      });
      const replay = await routes.request("/oauth/token", {
        method: "POST",
        headers: { authorization: "Bearer workload", "content-type": "application/json" },
        body: JSON.stringify({
          tokens: [{ kind: "user_access", grant: { kind: "authorization_code", code, nonce: authorityNonce }, expiresIn: 3_600 }],
        }),
      });
      expect(replay.status).toBe(403);
      const legacyCode = crypto.randomUUID();
      const legacyNonce = crypto.randomUUID();
      await sql`
        INSERT INTO oauth.codes (
          code, client_id, user_id, redirect_uri, scopes, audiences, used, authority_nonce, authority_issued_at
        ) VALUES (
          ${legacyCode}, ${clientId}, ${userId}::uuid, 'https://client.example.test/callback', ARRAY['openid'],
          ARRAY['cloud', ${clientId}], true, ${legacyNonce}::uuid, now()
        )
      `;
      const legacyReplay = await routes.request("/oauth/token", {
        method: "POST",
        headers: { authorization: "Bearer workload", "content-type": "application/json" },
        body: JSON.stringify({
          tokens: [
            {
              kind: "user_access",
              grant: { kind: "authorization_code", code: legacyCode, nonce: legacyNonce },
              expiresIn: 3_600,
            },
          ],
        }),
      });
      expect(legacyReplay.status).toBe(403);
    } finally {
      await sql`DELETE FROM oauth.codes WHERE code = ${code}`;
      await sql`DELETE FROM oauth.clients WHERE client_id = ${clientId}`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("derives client-credentials authority from the current bound service account", async () => {
    const serviceAccountId = crypto.randomUUID();
    const clientId = `service-authority-${crypto.randomUUID()}`;
    const grantId = crypto.randomUUID();
    const grantNonce = crypto.randomUUID();
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    try {
      await sql`
        INSERT INTO auth.service_accounts (id, name, kind, status, app_id, resource_type, resource_id)
        VALUES (${serviceAccountId}::uuid, 'OAuth authority test', 'resource_bound', 'active', 'mail', 'mailbox', 'inbox')
      `;
      await sql`
        INSERT INTO oauth.clients (name, client_id, redirect_uris, scopes, audiences, service_account_id, allowed_profiles, access_mode, registration_kind, is_public)
        VALUES (${`Service authority ${serviceAccountId}`}, ${clientId}, ARRAY[]::text[], ARRAY['read'], ARRAY['cloud'],
          ${serviceAccountId}::uuid, ARRAY['user'], 'profiles', 'managed', false)
      `;
      await sql`
        INSERT INTO oauth.client_credentials_authority_grants (id, nonce, client_id, scopes, audiences)
        VALUES (${grantId}::uuid, ${grantNonce}::uuid, ${clientId}, ARRAY['read'], ARRAY['cloud', ${clientId}])
      `;
      const routes = createIdentityOAuthIssuanceRoutes({
        authenticate: async () => ({
          appId: "oauth",
          serviceAccountId: crypto.randomUUID(),
          credentialId: crypto.randomUUID(),
          scope: "identity:oauth-issue",
        }),
        withActiveSigner: async (_purpose, callback) =>
          callback({ kid: crypto.randomUUID(), key: privateKey, signUntil: new Date(Date.now() + 60_000) }),
        issuer: async () => "https://cloud.example.test",
      });
      const response = await routes.request("/oauth/token", {
        method: "POST",
        headers: { authorization: "Bearer workload", "content-type": "application/json" },
        body: JSON.stringify({
          tokens: [{ kind: "service_access", grant: { kind: "client_credentials", grantId, nonce: grantNonce }, expiresIn: 3_600 }],
        }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { tokens: string[] };
      expect(
        (await jwtVerify(body.tokens[0]!, publicKey, { issuer: "https://cloud.example.test", audience: clientId })).payload,
      ).toMatchObject({
        sub: serviceAccountId,
        service_account_id: serviceAccountId,
        app_id: "mail",
        resource_type: "mailbox",
        resource_id: "inbox",
        scope: "read",
      });
      const replay = await routes.request("/oauth/token", {
        method: "POST",
        headers: { authorization: "Bearer workload", "content-type": "application/json" },
        body: JSON.stringify({
          tokens: [{ kind: "service_access", grant: { kind: "client_credentials", grantId, nonce: grantNonce }, expiresIn: 3_600 }],
        }),
      });
      expect(replay.status).toBe(403);
      const staleGrantId = crypto.randomUUID();
      const staleGrantNonce = crypto.randomUUID();
      await sql`
        INSERT INTO oauth.client_credentials_authority_grants (id, nonce, client_id, scopes, audiences)
        VALUES (${staleGrantId}::uuid, ${staleGrantNonce}::uuid, ${clientId}, ARRAY['read'], ARRAY['cloud', ${clientId}])
      `;
      await sql`UPDATE oauth.clients SET scopes = ARRAY[]::text[] WHERE client_id = ${clientId}`;
      const stale = await routes.request("/oauth/token", {
        method: "POST",
        headers: { authorization: "Bearer workload", "content-type": "application/json" },
        body: JSON.stringify({
          tokens: [
            {
              kind: "service_access",
              grant: { kind: "client_credentials", grantId: staleGrantId, nonce: staleGrantNonce },
              expiresIn: 3_600,
            },
          ],
        }),
      });
      expect(stale.status).toBe(403);
      const [staleGrant] = await sql<{ consumed_at: Date | null }[]>`
        SELECT consumed_at FROM oauth.client_credentials_authority_grants WHERE id = ${staleGrantId}::uuid
      `;
      expect(staleGrant?.consumed_at).toBeNull();
    } finally {
      await sql`DELETE FROM oauth.clients WHERE client_id = ${clientId}`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${serviceAccountId}::uuid`;
    }
  });

  test("consumes one reserved refresh issuance exactly once", async () => {
    const userId = crypto.randomUUID();
    const clientId = `refresh-authority-${crypto.randomUUID()}`;
    const familyId = crypto.randomUUID();
    const tokenId = crypto.randomUUID();
    const authorityNonce = crypto.randomUUID();
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    try {
      await sql`
        INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
        VALUES (${userId}::uuid, ${`refresh-${userId}`}, 'local', 'user', 'Refresh User', 'Refresh', 'User')
      `;
      await sql`
        INSERT INTO oauth.clients (name, client_id, redirect_uris, scopes, audiences, allowed_profiles, access_mode, registration_kind, is_public)
        VALUES (${`Refresh authority ${userId}`}, ${clientId}, ARRAY['https://client.example.test/callback'],
          ARRAY['openid'], ARRAY['cloud'], ARRAY['user'], 'profiles', 'managed', false)
      `;
      await sql`
        INSERT INTO oauth.refresh_token_families (id, client_id, user_id, scopes, audiences, status, expires_at)
        VALUES (${familyId}::uuid, ${clientId}, ${userId}::uuid, ARRAY['openid'], ARRAY['cloud', ${clientId}], 'active', now() + INTERVAL '1 day')
      `;
      await sql`
        INSERT INTO oauth.refresh_tokens (
          id, family_id, token_prefix, secret_hash, status, generation, expires_at, authority_nonce, authority_reserved_at,
          authority_scopes, authority_audiences
        ) VALUES (
          ${tokenId}::uuid, ${familyId}::uuid, ${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}, 'not-used', 'issuing', 1,
          now() + INTERVAL '1 day', ${authorityNonce}::uuid, now(), ARRAY['openid'], ARRAY['cloud', ${clientId}]
        )
      `;
      const routes = createIdentityOAuthIssuanceRoutes({
        authenticate: async () => ({
          appId: "oauth",
          serviceAccountId: crypto.randomUUID(),
          credentialId: crypto.randomUUID(),
          scope: "identity:oauth-issue",
        }),
        withActiveSigner: async (_purpose, callback) =>
          callback({ kid: crypto.randomUUID(), key: privateKey, signUntil: new Date(Date.now() + 60_000) }),
        issuer: async () => "https://cloud.example.test",
      });
      await sql`UPDATE oauth.clients SET audiences = ARRAY['cloud', 'https://new.example.test'] WHERE client_id = ${clientId}`;
      const request = () =>
        routes.request("/oauth/token", {
          method: "POST",
          headers: { authorization: "Bearer workload", "content-type": "application/json" },
          body: JSON.stringify({
            tokens: [{ kind: "user_access", grant: { kind: "refresh_token", tokenId, nonce: authorityNonce }, expiresIn: 3_600 }],
          }),
        });
      const issued = await request();
      expect(issued.status).toBe(200);
      const issuedBody = (await issued.json()) as { tokens: string[] };
      const verified = await jwtVerify(issuedBody.tokens[0]!, publicKey, { issuer: "https://cloud.example.test" });
      expect(verified.payload.aud).toEqual(["cloud", clientId]);
      const [token] = await sql<{ authority_issued_at: Date | null }[]>`
        SELECT authority_issued_at FROM oauth.refresh_tokens WHERE id = ${tokenId}::uuid
      `;
      expect(token?.authority_issued_at).toBeInstanceOf(Date);
      expect((await request()).status).toBe(403);
    } finally {
      await sql`DELETE FROM oauth.refresh_token_families WHERE id = ${familyId}::uuid`;
      await sql`DELETE FROM oauth.clients WHERE client_id = ${clientId}`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
});
