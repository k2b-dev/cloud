import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as settings from "@k2b/cloud/services/settings";
import { sql } from "bun";
import { generateKeyPair, jwtVerify } from "jose";
import { z } from "zod";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
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
  notAfter: null,
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
    authenticate: (token) => {
      authCalls += 1;
      expect(token).toBe("broker");
      return authenticated;
    },
    withActiveSigner: async (_purpose, callback) =>
      callback(
        {
          kid: "70eb97eb-a2a4-4454-aca5-d1d84af1239c",
          key: privateKey,
          signUntil: new Date(Date.now() + 60_000),
          issuer: "https://cloud.example.test",
        },
        sql,
      ),
    issuer: async () => "https://cloud.example.test",
    resolve: async () => state,
    now: () => 1_788_220_800,
  });
  return { routes, publicKey, authCalls: () => authCalls };
};

describe("Core OAuth issuance authority", () => {
  test("authenticates the configured broker secret before any signer or grant access", async () => {
    const previous = process.env.CLOUD_OAUTH_BROKER_SECRET;
    const { privateKey } = await generateKeyPair("RS256");
    let signerCalls = 0;
    const routes = createIdentityOAuthIssuanceRoutes({
      withActiveSigner: async (_purpose, callback) => {
        signerCalls += 1;
        return callback({ kid: "test", key: privateKey, signUntil: new Date(Date.now() + 60_000), issuer: "https://cloud.test" }, sql);
      },
      resolve: async () => {
        throw new Error("Unauthorized request reached grant resolution");
      },
    });
    const secret = "ab".repeat(32);
    try {
      for (const configured of [undefined, "", "invalid", secret]) {
        if (configured === undefined) delete process.env.CLOUD_OAUTH_BROKER_SECRET;
        else process.env.CLOUD_OAUTH_BROKER_SECRET = configured;
        for (const authorization of [
          undefined,
          "Bearer ",
          "Bearer invalid",
          `Bearer ${"cd".repeat(32)}`,
          `Basic ${secret}`,
          ...(configured === secret ? [] : [`Bearer ${secret}`]),
        ]) {
          for (const path of ["/oauth/ready", "/oauth/token"]) {
            const response = await routes.request(path, {
              method: "POST",
              headers: authorization ? { authorization } : {},
              body: "not JSON",
            });
            expect(response.status).toBe(401);
          }
        }
      }
      expect(signerCalls).toBe(0);
      process.env.CLOUD_OAUTH_BROKER_SECRET = secret;
      const ready = await routes.request("/oauth/ready", { method: "POST", headers: { authorization: `Bearer ${secret}` } });
      expect(ready.status).toBe(204);
      expect(signerCalls).toBe(1);
      const malformed = await routes.request("/oauth/token", {
        method: "POST",
        headers: { authorization: `Bearer ${secret}` },
        body: "not JSON",
      });
      expect(malformed.status).toBe(400);
    } finally {
      if (previous === undefined) delete process.env.CLOUD_OAUTH_BROKER_SECRET;
      else process.env.CLOUD_OAUTH_BROKER_SECRET = previous;
    }
  });
  test("derives the user access-token authority from current state", async () => {
    const { routes, publicKey } = await setup();
    const response = await routes.request("/oauth/token", {
      method: "POST",
      headers: { authorization: "Bearer broker", "content-type": "application/json" },
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
      exp: 1_788_224_400,
    });
  });

  test("requires the exact OAuth broker before parsing the body", async () => {
    const { routes, authCalls } = await setup(false);
    const response = await routes.request("/oauth/token", {
      method: "POST",
      headers: { authorization: "Bearer broker", "content-type": "application/json" },
      body: "not-json",
    });
    expect(response.status).toBe(401);
    expect(authCalls()).toBe(1);
    expect(
      (
        await routes.request("/oauth/ready", {
          method: "POST",
          headers: { authorization: "Bearer broker" },
        })
      ).status,
    ).toBe(401);
  });

  test("probes broker and active OAuth signer readiness without consuming a grant", async () => {
    const { routes } = await setup();
    const response = await routes.request("/oauth/ready", {
      method: "POST",
      headers: { authorization: "Bearer broker" },
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
      headers: { authorization: "Bearer broker", "content-type": "application/json" },
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

  test("signs a standalone agent account without a resource binding and refuses a smuggled one", async () => {
    const serviceAccountId = "5b1c9f6e-2c3d-4e5f-8a9b-0c1d2e3f4a5b";
    const grant = {
      kind: "client_credentials" as const,
      grantId: "dd8cc597-4268-43f2-abdf-ec008245ef10",
      nonce: "a771d825-b5d4-44d7-a0c2-17f97f37bd02",
    };
    const account = {
      id: serviceAccountId,
      kind: "agent",
      status: "active",
      delegatedUserId: null,
      appId: null,
      resourceType: null,
      resourceId: null,
    };
    const request = (routes: Awaited<ReturnType<typeof setup>>["routes"]) =>
      routes.request("/oauth/token", {
        method: "POST",
        headers: { authorization: "Bearer broker", "content-type": "application/json" },
        body: JSON.stringify({ tokens: [{ kind: "service_access", grant, expiresIn: 3_600 }] }),
      });

    const agent = await setup(
      true,
      authorityState({
        user: null,
        clientServiceAccountId: serviceAccountId,
        clientScopes: ["read"],
        grantedScopes: ["read"],
        serviceAccount: account,
      }),
    );
    const response = await request(agent.routes);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { tokens: string[] };
    const verified = await jwtVerify(body.tokens[0]!, agent.publicKey, {
      issuer: "https://cloud.example.test",
      audience: "cloud",
      currentDate: new Date(1_788_220_800_000),
    });
    expect(verified.payload).toMatchObject({
      sub: serviceAccountId,
      principal_type: "service_account",
      service_account_id: serviceAccountId,
      service_account_kind: "agent",
      app_id: null,
      resource_type: null,
      resource_id: null,
    });

    for (const invalid of [
      { ...account, appId: "mail" },
      { ...account, status: "disabled" },
      { ...account, kind: "user_delegated", delegatedUserId: "7d2a3b4c-5d6e-4f70-8192-a3b4c5d6e7f8" },
    ]) {
      const denied = await setup(
        true,
        authorityState({
          user: null,
          clientServiceAccountId: serviceAccountId,
          clientScopes: ["read"],
          grantedScopes: ["read"],
          serviceAccount: invalid,
        }),
      );
      expect((await request(denied.routes)).status).toBe(403);
    }
  });

  test("rejects arbitrary claims and expanded lifetimes", async () => {
    const { routes } = await setup();
    for (const token of [
      { ...userAccess, admin: true },
      { ...userAccess, userId: "forged" },
      ...[3601, 0, 1.5].flatMap((expiresIn) => [
        { ...userAccess, expiresIn },
        { ...userAccess, kind: "user_id", expiresIn },
        {
          kind: "service_access",
          grant: {
            kind: "client_credentials",
            grantId: "dd8cc597-4268-43f2-abdf-ec008245ef10",
            nonce: "a771d825-b5d4-44d7-a0c2-17f97f37bd02",
          },
          expiresIn,
        },
      ]),
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
        headers: { authorization: "Bearer broker", "content-type": "application/json" },
        body: JSON.stringify({ tokens: [token] }),
      });
      expect(response.status).toBe(400);
    }
  });

  test("signs access and ID tokens for a shorter requested lifetime", async () => {
    const { routes, publicKey } = await setup();
    const response = await routes.request("/oauth/token", {
      method: "POST",
      headers: { authorization: "Bearer broker", "content-type": "application/json" },
      body: JSON.stringify({
        tokens: [
          { ...userAccess, expiresIn: 600 },
          { ...userAccess, kind: "user_id", expiresIn: 600 },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = z.object({ tokens: z.array(z.string()) }).parse(await response.json());
    for (const token of body.tokens) {
      const verified = await jwtVerify(token, publicKey, { currentDate: new Date(1_788_220_800_000) });
      expect(verified.payload.exp).toBe(1_788_221_400);
    }
  });

  test("independently clamps refreshed access and ID tokens to the family's absolute expiry", async () => {
    const now = 1_788_220_800;
    const grant = { kind: "refresh_token", tokenId: USER_ID, nonce: userAccess.grant.nonce };
    for (const remaining of [120, 0, -1]) {
      const { routes, publicKey } = await setup(true, authorityState({ notAfter: new Date((now + remaining) * 1000) }));
      const response = await routes.request("/oauth/token", {
        method: "POST",
        headers: { authorization: "Bearer broker", "content-type": "application/json" },
        body: JSON.stringify({
          tokens: [
            { kind: "user_access", grant, expiresIn: 3600 },
            { kind: "user_id", grant, expiresIn: 3600 },
          ],
        }),
      });
      expect(response.status).toBe(remaining > 0 ? 200 : 403);
      if (remaining > 0) {
        const body = z.object({ tokens: z.array(z.string()) }).parse(await response.json());
        for (const token of body.tokens) {
          const verified = await jwtVerify(token, publicKey, { currentDate: new Date(now * 1000) });
          expect(verified.payload.exp).toBe(now + remaining);
        }
      } else {
        expect(await response.json()).toEqual({ message: "Forbidden" });
      }
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
        headers: { authorization: "Bearer broker", "content-type": "application/json" },
        body: JSON.stringify({ tokens: [token] }),
      });
      expect(response.status).toBe(403);
    }
  });

  test("checks account expiry after waiting for the signer and resolving authority", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    let now = 1_788_220_800;
    const routes = createIdentityOAuthIssuanceRoutes({
      authenticate: () => true,
      issuer: async () => "https://cloud.example.test",
      now: () => now,
      withActiveSigner: async (_purpose, callback) => {
        now += 10;
        return callback(
          { kid: crypto.randomUUID(), key: privateKey, signUntil: new Date(Date.now() + 60_000), issuer: "https://cloud.example.test" },
          sql,
        );
      },
      resolve: async () => authorityState({ user: { ...authorityState().user, accountExpires: new Date(1_788_220_805_000) } }),
    });
    const response = await routes.request("/oauth/token", {
      method: "POST",
      headers: { authorization: "Bearer broker", "content-type": "application/json" },
      body: JSON.stringify({ tokens: [userAccess] }),
    });
    expect(response.status).toBe(403);
  });
});

const withDatabase = databaseSuite();

withDatabase("Core OAuth issuance authority database resolution", () => {
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
        authenticate: () => true,
        withActiveSigner: async (_purpose, callback) =>
          sql.begin((db) =>
            callback(
              { kid: crypto.randomUUID(), key: privateKey, signUntil: new Date(Date.now() + 60_000), issuer: "https://cloud.example.test" },
              db,
            ),
          ),
        issuer: async () => "https://cloud.example.test",
      });
      const response = await routes.request("/oauth/token", {
        method: "POST",
        headers: { authorization: "Bearer broker", "content-type": "application/json" },
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
        headers: { authorization: "Bearer broker", "content-type": "application/json" },
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
        headers: { authorization: "Bearer broker", "content-type": "application/json" },
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
        authenticate: () => true,
        withActiveSigner: async (_purpose, callback) =>
          sql.begin((db) =>
            callback(
              { kid: crypto.randomUUID(), key: privateKey, signUntil: new Date(Date.now() + 60_000), issuer: "https://cloud.example.test" },
              db,
            ),
          ),
        issuer: async () => "https://cloud.example.test",
      });
      const response = await routes.request("/oauth/token", {
        method: "POST",
        headers: { authorization: "Bearer broker", "content-type": "application/json" },
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
        headers: { authorization: "Bearer broker", "content-type": "application/json" },
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
        headers: { authorization: "Bearer broker", "content-type": "application/json" },
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
    const familyExpiresAt = new Date(Date.now() + 120_000);
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
        VALUES (${familyId}::uuid, ${clientId}, ${userId}::uuid, ARRAY['openid'], ARRAY['cloud', ${clientId}], 'active', ${familyExpiresAt})
      `;
      await sql`
        INSERT INTO oauth.refresh_tokens (
          id, family_id, token_prefix, secret_hash, status, generation, expires_at, authority_nonce, authority_reserved_at,
          authority_scopes, authority_audiences
        ) VALUES (
          ${tokenId}::uuid, ${familyId}::uuid, ${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}, 'not-used', 'issuing', 1,
          ${familyExpiresAt}, ${authorityNonce}::uuid, now(), ARRAY['openid'], ARRAY['cloud', ${clientId}]
        )
      `;
      const routes = createIdentityOAuthIssuanceRoutes({
        authenticate: () => true,
        withActiveSigner: async (_purpose, callback) =>
          sql.begin((db) =>
            callback(
              { kid: crypto.randomUUID(), key: privateKey, signUntil: new Date(Date.now() + 60_000), issuer: "https://cloud.example.test" },
              db,
            ),
          ),
        issuer: async () => "https://cloud.example.test",
      });
      await sql`UPDATE oauth.clients SET audiences = ARRAY['cloud', 'https://new.example.test'] WHERE client_id = ${clientId}`;
      const request = () =>
        routes.request("/oauth/token", {
          method: "POST",
          headers: { authorization: "Bearer broker", "content-type": "application/json" },
          body: JSON.stringify({
            tokens: [
              { kind: "user_access", grant: { kind: "refresh_token", tokenId, nonce: authorityNonce }, expiresIn: 3_600 },
              { kind: "user_id", grant: { kind: "refresh_token", tokenId, nonce: authorityNonce }, expiresIn: 3_600 },
            ],
          }),
        });
      const issued = await request();
      expect(issued.status).toBe(200);
      const issuedBody = (await issued.json()) as { tokens: string[] };
      const verified = await jwtVerify(issuedBody.tokens[0]!, publicKey, { issuer: "https://cloud.example.test" });
      expect(verified.payload.aud).toEqual(["cloud", clientId]);
      expect(verified.payload.exp).toBe(Math.floor(familyExpiresAt.getTime() / 1000));
      const idToken = await jwtVerify(issuedBody.tokens[1]!, publicKey, { issuer: "https://cloud.example.test" });
      expect(idToken.payload.exp).toBe(verified.payload.exp);
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

withDatabase("Core terminal approval issuance boundary", () => {
  const saved = new Map<string, unknown>();
  const configKeys = ["app.url", "user.app_approval.enabled", "user.app_approval.origin"];
  beforeAll(async () => {
    const { migrate } = await import("../migrate/core/app-approval");
    await migrate();
    for (const key of configKeys) saved.set(key, await settings.get(key));
    await settings.set("app.url", "https://cloud.example.test");
    await settings.set("user.app_approval.enabled", true);
    await settings.set("user.app_approval.origin", "https://terminal-login.example.test");
  });
  afterAll(async () => {
    for (const key of configKeys) await settings.set(key, saved.get(key));
  });

  test("issuance waits for the device before locking the login, avoiding a concurrent decide deadlock", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const userId = crypto.randomUUID(),
      deviceId = crypto.randomUUID(),
      authorizationId = crypto.randomUUID(),
      otherAuthorizationId = crypto.randomUUID(),
      loginId = crypto.randomUUID(),
      nonce = crypto.randomUUID(),
      clientId = `issuance-lock-order-${crypto.randomUUID()}`;
    let issuancePid: number | undefined;
    let issuance: Promise<Response> | undefined;
    const routes = createIdentityOAuthIssuanceRoutes({
      authenticate: () => true,
      withActiveSigner: async (_purpose, callback) =>
        sql.begin(async (db) => {
          await db`SET LOCAL statement_timeout='5s'`;
          const [backend] = await db<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          issuancePid = backend!.pid;
          return callback(
            {
              kid: crypto.randomUUID(),
              key: privateKey,
              signUntil: new Date(Date.now() + 60_000),
              issuer: "https://cloud.example.test",
            },
            db,
          );
        }),
      issuer: async () => "https://cloud.example.test",
    });
    try {
      await sql`INSERT INTO auth.users(id,uid,provider,profile)
        VALUES (${userId}::uuid,${`terminal-lock-order-${userId}`},'local','user')`;
      await sql`INSERT INTO oauth.clients(name,client_id,redirect_uris,scopes,audiences,allowed_profiles,access_mode,registration_kind,is_public,allow_device_grant)
        VALUES ('Issuance lock order',${clientId},'{}',ARRAY['openid','profile'],ARRAY['cloud'],ARRAY['user'],'profiles','managed',true,true)`;
      await sql`INSERT INTO oauth.device_authorizations(id,device_code_hash,user_code_hash,client_id,scopes,audiences,status,user_id,expires_at,authority_nonce)
        VALUES (${authorizationId}::uuid,${authorizationId},${authorizationId},${clientId},ARRAY['openid','profile'],ARRAY['cloud'],
          'consumed',${userId}::uuid,now()+interval '10 minutes',${nonce}::uuid)`;
      await sql`INSERT INTO oauth.device_authorizations(id,device_code_hash,user_code_hash,client_id,scopes,audiences,expires_at)
        VALUES (${otherAuthorizationId}::uuid,${otherAuthorizationId},${otherAuthorizationId},${clientId},ARRAY['openid'],ARRAY['cloud'],
          now()+interval '10 minutes')`;
      await sql`INSERT INTO auth.app_devices(id,issuer,user_id,name,public_key,assisted)
        VALUES (${deviceId}::uuid,'https://cloud.example.test',${userId}::uuid,'Phone','{}',false)`;
      await sql`INSERT INTO auth.app_logins(id,issuer,user_id,auth_epoch,category,browser_hash,challenge,comparison,state,approved_by,expires_at,
        kind,device_authorization_id,client_id,scopes,lifetime_seconds)
        SELECT ${loginId}::uuid,'https://cloud.example.test',u.id,u.auth_epoch,'login','unusable','unusable','000123','approved',${deviceId}::uuid,
          now()+interval '5 minutes','terminal',${authorizationId}::uuid,${clientId},ARRAY['openid','profile'],3600
        FROM auth.users u WHERE u.id=${userId}::uuid`;

      // Transaction A models a signed decide: device first, then login.
      await sql.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout='3s'`;
        const [locker] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        await tx`SELECT id FROM auth.app_devices WHERE id=${deviceId}::uuid FOR UPDATE`;
        issuance = Promise.resolve(
          routes.request("/oauth/token", {
            method: "POST",
            headers: { authorization: "Bearer broker", "content-type": "application/json" },
            body: JSON.stringify({
              tokens: [
                { kind: "user_access", grant: { kind: "device_code", deviceAuthorizationId: authorizationId, nonce }, expiresIn: 3600 },
              ],
            }),
          }),
        );
        let blocked = false;
        const deadline = performance.now() + 3000;
        while (performance.now() < deadline) {
          if (issuancePid !== undefined) {
            const [waiting] = await tx<{ blocked: boolean }[]>`
              SELECT ${locker!.pid}=ANY(pg_blocking_pids(${issuancePid})) AS blocked`;
            if (waiting?.blocked) {
              blocked = true;
              break;
            }
          }
          await Bun.sleep(10);
        }
        expect(blocked).toBe(true);
        // The decision hook approves another grant of this user; its foreign key takes a key-share lock on the user.
        await tx`UPDATE oauth.device_authorizations SET status='approved',user_id=${userId}::uuid,decided_at=now()
          WHERE id=${otherAuthorizationId}::uuid`;
        // With the inverted order, issuance already holds this row and A deadlocks.
        const locked = await tx`SELECT id FROM auth.app_logins WHERE id=${loginId}::uuid FOR UPDATE`;
        expect(locked).toHaveLength(1);
      });
      const response = await issuance;
      expect(response?.status).toBe(200);
      expect(z.object({ tokens: z.array(z.string()).length(1) }).parse(await response!.json()).tokens).toHaveLength(1);
      const [login] = await sql`SELECT state FROM auth.app_logins WHERE id=${loginId}::uuid`;
      expect(login.state).toBe("consumed");
      const [grant] = await sql`SELECT authority_issued_at FROM oauth.device_authorizations WHERE id=${authorizationId}::uuid`;
      expect(grant.authority_issued_at).not.toBeNull();
    } finally {
      await issuance;
      await sql`DELETE FROM auth.app_logins WHERE id=${loginId}::uuid`;
      await sql`DELETE FROM oauth.clients WHERE client_id=${clientId}`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  }, 15_000);

  test.each([
    "happy",
    "browser",
    "revoked",
    "epoch",
    "device-owner",
    "login-owner",
    "missing-device",
    "expired-ui",
    "disabled",
    "issuer",
    "device-issuer",
  ] as const)("rechecks terminal approval authority before issuance: %s", async (scenario) => {
    const { privateKey } = await generateKeyPair("RS256");
    const routes = createIdentityOAuthIssuanceRoutes({
      authenticate: () => true,
      withActiveSigner: async (_purpose, callback) =>
        sql.begin((db) =>
          callback(
            {
              kid: crypto.randomUUID(),
              key: privateKey,
              signUntil: new Date(Date.now() + 60_000),
              issuer: "https://cloud.example.test",
            },
            db,
          ),
        ),
      issuer: async () => "https://cloud.example.test",
    });
    const userId = crypto.randomUUID(),
      otherUser = crypto.randomUUID(),
      clientId = `issuance-terminal-${crypto.randomUUID()}`;
    const deviceId = crypto.randomUUID(),
      authorizationId = crypto.randomUUID(),
      loginId = crypto.randomUUID(),
      nonce = crypto.randomUUID();
    try {
      for (const id of [userId, otherUser])
        await sql`INSERT INTO auth.users(id,uid,provider,profile)
          VALUES (${id}::uuid,${`terminal-issuance-${id}`},'local','user')`;
      await sql`INSERT INTO oauth.clients(name,client_id,redirect_uris,scopes,audiences,allowed_profiles,access_mode,registration_kind,is_public,allow_device_grant)
          VALUES ('Issuance test',${clientId},'{}',ARRAY['openid','profile'],ARRAY['cloud'],ARRAY['user'],'profiles','managed',true,true)`;
      await sql`INSERT INTO oauth.device_authorizations(id,device_code_hash,user_code_hash,client_id,scopes,audiences,status,user_id,expires_at,authority_nonce)
          VALUES (${authorizationId}::uuid,${authorizationId},${authorizationId},${clientId},ARRAY['openid','profile'],ARRAY['cloud'],
            'consumed',${userId}::uuid,now()+interval '10 minutes',${nonce}::uuid)`;
      if (scenario !== "browser") {
        await sql`INSERT INTO auth.app_devices(id,issuer,user_id,name,public_key,assisted)
            VALUES (${deviceId}::uuid,'https://cloud.example.test',${scenario === "device-owner" ? otherUser : userId}::uuid,'Phone','{}',false)`;
        await sql`INSERT INTO auth.app_logins(id,issuer,user_id,auth_epoch,category,browser_hash,challenge,comparison,state,approved_by,expires_at,
            kind,device_authorization_id,client_id,scopes,lifetime_seconds)
            SELECT ${loginId}::uuid,'https://cloud.example.test',u.id,u.auth_epoch,'login','unusable','unusable','000123','approved',${deviceId}::uuid,
              now()+interval '5 minutes','terminal',${authorizationId}::uuid,${clientId},ARRAY['openid','profile'],3600
            FROM auth.users u WHERE u.id=${scenario === "login-owner" ? otherUser : userId}::uuid`;
        if (scenario === "revoked") await sql`UPDATE auth.app_devices SET revoked_at=now() WHERE id=${deviceId}::uuid`;
        if (scenario === "epoch") await sql`UPDATE auth.users SET auth_epoch=auth_epoch+1 WHERE id=${userId}::uuid`;
        if (scenario === "missing-device") await sql`DELETE FROM auth.app_devices WHERE id=${deviceId}::uuid`;
        if (scenario === "disabled") await settings.set("user.app_approval.enabled", false);
        if (scenario === "issuer") await settings.set("app.url", "https://other-cloud.example.test");
        if (scenario === "device-issuer")
          await sql`UPDATE auth.app_devices SET issuer='https://other-cloud.example.test' WHERE id=${deviceId}::uuid`;
        if (scenario === "expired-ui") {
          await sql`UPDATE auth.app_logins SET expires_at=now()-interval '1 second' WHERE id=${loginId}::uuid`;
          // Cleanup must retain the evidence needed by issuance after the sign-in UI closes.
          const { appApproval } = await import("@k2b/cloud/services");
          await appApproval.cleanup();
        }
      }
      const response = await routes.request("/oauth/token", {
        method: "POST",
        headers: { authorization: "Bearer broker", "content-type": "application/json" },
        body: JSON.stringify({
          tokens: [{ kind: "user_access", grant: { kind: "device_code", deviceAuthorizationId: authorizationId, nonce }, expiresIn: 3600 }],
        }),
      });
      const allowed = ["happy", "browser", "expired-ui"].includes(scenario);
      expect(response.status).toBe(allowed ? 200 : 403);
      const result = await response.json();
      if (allowed) expect(z.object({ tokens: z.array(z.string()).length(1) }).parse(result).tokens).toHaveLength(1);
      else expect(result).toEqual({ message: "Forbidden" });
      const [grant] = await sql`SELECT authority_issued_at FROM oauth.device_authorizations WHERE id=${authorizationId}::uuid`;
      expect(grant.authority_issued_at !== null).toBe(allowed);
      if (scenario !== "browser") {
        const [login] = await sql`SELECT state FROM auth.app_logins WHERE id=${loginId}::uuid`;
        expect(login.state).toBe(allowed ? "consumed" : "approved");
      }
    } finally {
      await settings.set("user.app_approval.enabled", true);
      await settings.set("app.url", "https://cloud.example.test");
      await sql`DELETE FROM oauth.clients WHERE client_id=${clientId}`;
      for (const id of [userId, otherUser]) await sql`DELETE FROM auth.users WHERE id=${id}::uuid`;
    }
  });
});
