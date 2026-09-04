import { describe, expect, test } from "bun:test";
import { createMcpRoutes } from "@valentinkolb/cloud/api";
import { type AuthContext, auth, v } from "@valentinkolb/cloud/server";
import { oauthTokens, serviceAccounts } from "@valentinkolb/cloud/services";
import { clearOAuthVerifierCachesForTest } from "@valentinkolb/cloud/services/oauth-tokens";
import { sql } from "bun";
import { Hono } from "hono";
import * as jose from "jose";
import { createTestSession } from "../../../cloud/src/services/session/test-fixture";
import adminApiRoutes from "../api";
import type { OAuthClient } from "../contracts";
import { ConsentDecisionSchema, completeConsent } from "../frontend/consent-action";
import { migrate } from "../migrate";
import oauthRoutes from "../oauth";
import { oauthService } from "../service";
import { oauth } from "./oauth";

const canUseDatabase = async () => {
  try {
    const [row] = await sql<
      {
        users: string | null;
        service_accounts: string | null;
        groups: string | null;
        user_groups: string | null;
        group_groups: string | null;
        signing_keys: string | null;
      }[]
    >`
      SELECT
        to_regclass('auth.users')::text AS users,
        to_regclass('auth.service_accounts')::text AS service_accounts,
        to_regclass('auth.groups')::text AS groups,
        to_regclass('auth.user_groups_v2')::text AS user_groups,
        to_regclass('auth.group_groups_v2')::text AS group_groups,
        to_regclass('auth.signing_keys')::text AS signing_keys
    `;
    if (!row?.users || !row.service_accounts || !row.groups || !row.user_groups || !row.group_groups || !row.signing_keys) return false;
    await migrate();
    return true;
  } catch {
    return false;
  }
};

/** Reported as skipped rather than silently passing when the backing service is absent. */
const suite = (await canUseDatabase()) ? describe : describe.skip;

const insertUser = async (options: { admin?: boolean } = {}) => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn, admin)
    VALUES (${`oauth-token-${suffix}`}, 'local', 'user', 'OAuth Token Test', ${`oauth-token-${suffix}@example.test`}, 'OAuth', 'Token', ${options.admin ?? false})
    RETURNING id
  `;
  return row!.id;
};

const insertGroup = async (name: string) => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.groups (cn, provider, name, description)
    VALUES (${`${name}-${suffix}`}, 'local', ${`${name}-${suffix}`}, ${`${name} group`})
    RETURNING id
  `;
  return row!.id;
};

const adminActor = (id: string) => ({ id, uid: `oauth-admin-${id}`, provider: "local", roles: ["admin"] });

const createSessionToken = createTestSession;

const waitForAdvisoryWaiter = async (key: number): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await sql<{ waiting: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_locks
        WHERE locktype = 'advisory' AND granted = false AND objid = ${key}::oid
      ) AS waiting
    `;
    if (row?.waiting) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for the deterministic OAuth issuance interleaving");
};

const requestClientCredentialsToken = async (params: { clientId: string; clientSecret: string; scope?: string; resource?: string }) => {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: params.clientId,
    client_secret: params.clientSecret,
  });
  if (params.scope) body.set("scope", params.scope);
  if (params.resource) body.set("resource", params.resource);

  return oauthRoutes.request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
};

const actorProbe = () =>
  new Hono<AuthContext>().use(auth.requireRole("authenticated")).get("/probe", (c) => {
    const actor = c.get("actor");
    return c.json({
      actorKind: actor.kind,
      userId: actor.kind === "user" ? actor.user.id : (actor.delegatedUser?.id ?? null),
      serviceAccountId: actor.kind === "service_account" ? actor.serviceAccount.id : null,
      accessSubject: c.get("accessSubject"),
    });
  });

const consentActionRoutes = () =>
  new Hono<AuthContext>().post(
    "/oauth/consent",
    auth.requireRole("authenticated"),
    auth.requireUser(),
    v("form", ConsentDecisionSchema),
    (c) => completeConsent(c, c.req.valid("form")),
  );

suite("OAuth resource access tokens", () => {
  test("authorization-code access tokens resolve as user actors in Core auth", async () => {
    const userId = await insertUser();
    let clientId: string | null = null;

    try {
      const created = await oauth.clients.create({
        actor: adminActor(userId),
        data: {
          name: `User token client ${crypto.randomUUID()}`,
          redirectUris: ["https://client.example.test/callback"],
          scopes: ["openid", "profile", "email"],
          audiences: ["cloud", "test-api"],
          allowedProfiles: ["user"],
          accessMode: "profiles",
          allowedUserIds: [],
          allowedGroupIds: [],
          isPublic: false,
        },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      clientId = created.data.id;

      const tokens = await oauth.tokens.createTokens({
        userId,
        client: created.data,
        issuer: "http://localhost:3000",
      });

      const verified =
        (await oauthTokens.verifyAccessToken(tokens.accessToken)) ?? (await oauthTokens.verifyAccessToken(tokens.accessToken));
      expect(verified?.kind).toBe("user");
      expect(verified?.kind === "user" ? verified.user.id : null).toBe(userId);
      expect(jose.decodeJwt(tokens.accessToken)).toMatchObject({ sub: userId, id: userId });

      let response = await actorProbe().request("/probe", {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      });
      if (response.status !== 200) {
        response = await actorProbe().request("/probe", { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
      }
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        actorKind: "user",
        userId,
        serviceAccountId: null,
        accessSubject: { type: "user", userId },
      });
    } finally {
      if (clientId) await sql`DELETE FROM oauth.clients WHERE id = ${clientId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("rotates signing keys while old one-hour JWTs remain verifiable during grace", async () => {
    const userId = await insertUser();
    let clientId: string | null = null;

    try {
      const created = await oauth.clients.create({
        actor: adminActor(userId),
        data: {
          name: `Rotation client ${crypto.randomUUID()}`,
          redirectUris: ["https://client.example.test/callback"],
          scopes: ["openid", "read"],
          audiences: ["cloud"],
          allowedProfiles: ["user"],
          accessMode: "profiles",
          allowedUserIds: [],
          allowedGroupIds: [],
          isPublic: false,
        },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      clientId = created.data.id;

      const first = await oauth.tokens.createTokens({ userId, client: created.data, issuer: "http://localhost:3000" });
      const firstKid = jose.decodeProtectedHeader(first.accessToken).kid!;
      await sql`UPDATE oauth.keys SET created_at = now() - INTERVAL '31 days' WHERE kid = ${firstKid}`;

      const second = await oauth.tokens.createTokens({ userId, client: created.data, issuer: "http://localhost:3000" });
      const secondKid = jose.decodeProtectedHeader(second.accessToken).kid!;
      expect(secondKid).not.toBe(firstKid);
      expect(jose.decodeJwt(second.accessToken).sub).toBe(userId);
      const [retired] = await sql<{ private_key: string }[]>`SELECT private_key FROM oauth.keys WHERE kid = ${firstKid}`;
      expect(retired?.private_key).toBe("");

      expect(await oauth.tokens.verifyAccessToken({ token: first.accessToken, issuer: "http://localhost:3000" })).not.toBeNull();
      expect(await oauth.tokens.verifyAccessToken({ token: second.accessToken, issuer: "http://localhost:3000" })).not.toBeNull();
      const jwks = await oauth.tokens.getJwks();
      expect(jwks.keys.map((key) => key.kid)).toEqual(expect.arrayContaining([firstKid, secondKid]));

      await sql`UPDATE oauth.keys SET retired_at = now() - INTERVAL '3 hours' WHERE kid = ${firstKid}`;
      expect(await oauth.tokens.cleanupSigningKeys()).toBeGreaterThanOrEqual(1);
      oauth.tokens.clearOAuthVerifierCacheForTest();
      expect(await oauth.tokens.verifyAccessToken({ token: first.accessToken, issuer: "http://localhost:3000" })).toBeNull();
      expect(await oauth.tokens.verifyAccessToken({ token: second.accessToken, issuer: "http://localhost:3000" })).not.toBeNull();
    } finally {
      if (clientId) await sql`DELETE FROM oauth.clients WHERE id = ${clientId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("cuts every replica over only after Core readiness and the database issuance lock", async () => {
    const originalMode = process.env.CLOUD_OAUTH_ISSUANCE_MODE;
    let releaseLock = () => {};
    let lockHolder: Promise<unknown> = Promise.resolve();
    try {
      process.env.CLOUD_OAUTH_ISSUANCE_MODE = "legacy";
      await sql`UPDATE oauth.issuance_state SET mode = 'legacy', cutover_at = NULL, updated_at = now() WHERE singleton = true`;
      clearOAuthVerifierCachesForTest();
      oauth.tokens.clearOAuthVerifierCacheForTest();
      const legacyKey = await oauth.tokens.getOrCreateKeyPair();

      process.env.CLOUD_OAUTH_ISSUANCE_MODE = "core";
      await expect(
        oauth.tokens.ensureConfiguredIssuanceMode({
          probe: async () => {
            throw new Error("Core OAuth signer unavailable");
          },
        }),
      ).rejects.toThrow("Core OAuth signer unavailable");
      expect(await oauth.tokens.getOAuthIssuanceMode()).toBe("legacy");

      let lockReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        lockReady = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      lockHolder = sql.begin(async (tx) => {
        await tx`SELECT mode FROM oauth.issuance_state WHERE singleton = true FOR SHARE`;
        lockReady();
        await release;
      });
      await ready;

      let probes = 0;
      const cutover = oauth.tokens.ensureConfiguredIssuanceMode({
        probe: async () => {
          probes += 1;
        },
      });
      await Bun.sleep(50);
      expect(await oauth.tokens.getOAuthIssuanceMode()).toBe("legacy");
      releaseLock();
      await lockHolder;
      lockHolder = Promise.resolve();
      await expect(cutover).resolves.toBe("core");
      expect(probes).toBe(1);
      const [retired] = await sql<{ private_key: string; retired_at: Date | null }[]>`
        SELECT private_key, retired_at FROM oauth.keys WHERE kid = ${legacyKey.kid}
      `;
      expect(retired?.private_key).toBe("");
      expect(retired?.retired_at).toBeInstanceOf(Date);
      await expect(oauth.tokens.getOrCreateKeyPair()).rejects.toThrow("disabled by the database cutover");
    } finally {
      releaseLock();
      await lockHolder.catch(() => undefined);
      await sql`UPDATE oauth.issuance_state SET mode = 'legacy', cutover_at = NULL, updated_at = now() WHERE singleton = true`;
      clearOAuthVerifierCachesForTest();
      oauth.tokens.clearOAuthVerifierCacheForTest();
      if (originalMode === undefined) delete process.env.CLOUD_OAUTH_ISSUANCE_MODE;
      else process.env.CLOUD_OAUTH_ISSUANCE_MODE = originalMode;
    }
  });

  test("lets an in-flight legacy authorization code finish before the global cutover", async () => {
    const userId = await insertUser();
    const originalMode = process.env.CLOUD_OAUTH_ISSUANCE_MODE;
    const lockKey = 1_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const functionName = `test_code_cutover_${suffix}`;
    const triggerName = `test_code_cutover_trigger_${suffix}`;
    let releaseLock = () => {};
    let lockHolder: Promise<unknown> = Promise.resolve();
    let clientId: string | null = null;
    try {
      process.env.CLOUD_OAUTH_ISSUANCE_MODE = "legacy";
      await sql`UPDATE oauth.issuance_state SET mode = 'legacy', cutover_at = NULL, updated_at = now() WHERE singleton = true`;
      const created = await oauth.clients.create({
        actor: adminActor(userId),
        data: {
          name: `Code cutover ${crypto.randomUUID()}`,
          redirectUris: ["https://client.example.test/callback"],
          scopes: ["openid"],
          audiences: ["cloud"],
          allowedProfiles: ["user"],
          accessMode: "profiles",
          allowedUserIds: [],
          allowedGroupIds: [],
          isPublic: false,
        },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      clientId = created.data.id;
      const code = await oauth.codes.create({
        clientId: created.data.clientId,
        userId,
        redirectUri: "https://client.example.test/callback",
        scopes: ["openid"],
      });
      const consumed = await oauth.codes.consume({
        code,
        clientId: created.data.clientId,
        client: created.data,
        redirectUri: "https://client.example.test/callback",
      });
      expect(consumed).not.toBeNull();
      if (!consumed) return;

      await sql.unsafe(`
        CREATE FUNCTION oauth.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${lockKey});
          RETURN NEW;
        END $$
      `);
      await sql.unsafe(`
        CREATE TRIGGER ${triggerName}
        BEFORE UPDATE OF authority_issued_at ON oauth.codes
        FOR EACH ROW WHEN (NEW.code = '${code}')
        EXECUTE FUNCTION oauth.${functionName}()
      `);
      let lockReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        lockReady = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      lockHolder = sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(${lockKey})`;
        lockReady();
        await release;
      });
      await ready;

      const issuance = oauth.tokens.createTokens({
        userId,
        client: created.data,
        issuer: "http://localhost:3000",
        scopes: consumed.scopes,
        authorityGrant: consumed.authorityGrant,
      });
      await waitForAdvisoryWaiter(lockKey);
      process.env.CLOUD_OAUTH_ISSUANCE_MODE = "core";
      const cutover = oauth.tokens.ensureConfiguredIssuanceMode({ probe: async () => {} });
      await Bun.sleep(50);
      expect(await oauth.tokens.getOAuthIssuanceMode()).toBe("legacy");
      releaseLock();
      await lockHolder;
      lockHolder = Promise.resolve();
      const [issued] = await Promise.all([issuance, cutover]);
      expect(issued.authorityMode).toBe("legacy");
      expect(jose.decodeProtectedHeader(issued.accessToken).alg).toBe("RS256");
      expect(await oauth.tokens.getOAuthIssuanceMode()).toBe("core");
      const [grant] = await sql<{ authority_issued_at: Date | null }[]>`
        SELECT authority_issued_at FROM oauth.codes WHERE code = ${code}
      `;
      expect(grant?.authority_issued_at).toBeInstanceOf(Date);
    } finally {
      releaseLock();
      await lockHolder.catch(() => undefined);
      await sql.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON oauth.codes`).catch(() => undefined);
      await sql.unsafe(`DROP FUNCTION IF EXISTS oauth.${functionName}()`).catch(() => undefined);
      await sql`UPDATE oauth.issuance_state SET mode = 'legacy', cutover_at = NULL, updated_at = now() WHERE singleton = true`;
      clearOAuthVerifierCachesForTest();
      oauth.tokens.clearOAuthVerifierCacheForTest();
      if (originalMode === undefined) delete process.env.CLOUD_OAUTH_ISSUANCE_MODE;
      else process.env.CLOUD_OAUTH_ISSUANCE_MODE = originalMode;
      if (clientId) await sql`DELETE FROM oauth.clients WHERE id = ${clientId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("routes a client-credentials grant to Core when cutover wins before signing", async () => {
    const userId = await insertUser();
    const originalMode = process.env.CLOUD_OAUTH_ISSUANCE_MODE;
    const originalCredential = process.env.CLOUD_APP_CREDENTIAL;
    const originalCoreOrigin = process.env.CLOUD_CORE_INTERNAL_ORIGIN;
    const originalFetch = globalThis.fetch;
    const lockKey = 1_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const functionName = `test_service_cutover_${suffix}`;
    const triggerName = `test_service_cutover_trigger_${suffix}`;
    let releaseLock = () => {};
    let lockHolder: Promise<unknown> = Promise.resolve();
    let clientId: string | null = null;
    let serviceAccountId: string | null = null;
    try {
      process.env.CLOUD_OAUTH_ISSUANCE_MODE = "legacy";
      process.env.CLOUD_APP_CREDENTIAL = "test-workload";
      process.env.CLOUD_CORE_INTERNAL_ORIGIN = "http://core.internal:3000";
      await sql`UPDATE oauth.issuance_state SET mode = 'legacy', cutover_at = NULL, updated_at = now() WHERE singleton = true`;
      const serviceAccount = await serviceAccounts.createResourceBound({
        name: `Cutover service ${crypto.randomUUID()}`,
        appId: "oauth-test",
        resourceType: "fixture",
        resourceId: crypto.randomUUID(),
        createdBy: userId,
      });
      expect(serviceAccount.ok).toBe(true);
      if (!serviceAccount.ok) return;
      serviceAccountId = serviceAccount.data.id;
      const created = await oauth.clients.create({
        actor: adminActor(userId),
        data: {
          name: `Service cutover ${crypto.randomUUID()}`,
          redirectUris: [],
          scopes: ["read"],
          audiences: ["cloud"],
          serviceAccountId,
          allowedProfiles: ["user"],
          accessMode: "profiles",
          allowedUserIds: [],
          allowedGroupIds: [],
          isPublic: false,
        },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      clientId = created.data.id;

      await sql.unsafe(`
        CREATE FUNCTION oauth.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${lockKey});
          RETURN NEW;
        END $$
      `);
      await sql.unsafe(`
        CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON oauth.client_credentials_authority_grants
        FOR EACH ROW WHEN (NEW.client_id = '${created.data.clientId}')
        EXECUTE FUNCTION oauth.${functionName}()
      `);
      let lockReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        lockReady = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      lockHolder = sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(${lockKey})`;
        lockReady();
        await release;
      });
      await ready;

      let coreGrantId: string | null = null;
      globalThis.fetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          const body = (await request.json()) as {
            tokens: Array<{ kind: string; grant: { grantId: string; nonce: string } }>;
          };
          coreGrantId = body.tokens[0]!.grant.grantId;
          await sql`
            UPDATE oauth.client_credentials_authority_grants
            SET consumed_at = now()
            WHERE id = ${coreGrantId}::uuid AND nonce = ${body.tokens[0]!.grant.nonce}::uuid AND consumed_at IS NULL
          `;
          return Response.json({ tokens: ["core.jwt"] });
        },
        { preconnect: originalFetch.preconnect },
      );
      const issuance = oauth.tokens.createClientCredentialsToken({
        client: created.data,
        issuer: "http://localhost:3000",
      });
      await waitForAdvisoryWaiter(lockKey);
      process.env.CLOUD_OAUTH_ISSUANCE_MODE = "core";
      await expect(oauth.tokens.ensureConfiguredIssuanceMode({ probe: async () => {} })).resolves.toBe("core");
      process.env.CLOUD_OAUTH_ISSUANCE_MODE = "legacy";
      releaseLock();
      await lockHolder;
      lockHolder = Promise.resolve();
      const issued = await issuance;
      expect(issued.accessToken).toBe("core.jwt");
      expect(coreGrantId).not.toBeNull();
      const [grant] = await sql<{ consumed_at: Date | null }[]>`
        SELECT consumed_at FROM oauth.client_credentials_authority_grants WHERE id = ${coreGrantId}::uuid
      `;
      expect(grant?.consumed_at).toBeInstanceOf(Date);
      await expect(oauth.tokens.getOrCreateKeyPair()).rejects.toThrow("disabled by the database cutover");
    } finally {
      releaseLock();
      await lockHolder.catch(() => undefined);
      globalThis.fetch = originalFetch;
      await sql.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON oauth.client_credentials_authority_grants`).catch(() => undefined);
      await sql.unsafe(`DROP FUNCTION IF EXISTS oauth.${functionName}()`).catch(() => undefined);
      await sql`UPDATE oauth.issuance_state SET mode = 'legacy', cutover_at = NULL, updated_at = now() WHERE singleton = true`;
      if (originalMode === undefined) delete process.env.CLOUD_OAUTH_ISSUANCE_MODE;
      else process.env.CLOUD_OAUTH_ISSUANCE_MODE = originalMode;
      if (originalCredential === undefined) delete process.env.CLOUD_APP_CREDENTIAL;
      else process.env.CLOUD_APP_CREDENTIAL = originalCredential;
      if (originalCoreOrigin === undefined) delete process.env.CLOUD_CORE_INTERNAL_ORIGIN;
      else process.env.CLOUD_CORE_INTERNAL_ORIGIN = originalCoreOrigin;
      if (clientId) await sql`DELETE FROM oauth.clients WHERE id = ${clientId}::uuid`;
      if (serviceAccountId) await sql`DELETE FROM auth.service_accounts WHERE id = ${serviceAccountId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("publishes and verifies Core authority keys while revoked kids fail closed", async () => {
    const issuer = "http://localhost:3000";
    const kid = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const { privateKey, publicKey } = await jose.generateKeyPair("RS256", { extractable: true });
    const publicJwk = { ...(await jose.exportJWK(publicKey)), alg: "RS256", kid, use: "sig" };

    try {
      await sql`
        INSERT INTO oauth.keys (id, private_key, public_key, kid, retired_at)
        VALUES (${crypto.randomUUID()}, ${await jose.exportPKCS8(privateKey)}, ${await jose.exportSPKI(publicKey)}, ${kid}, now())
      `;
      await sql`
        INSERT INTO auth.signing_keys (
          purpose, state, kid, alg, public_jwk, encrypted_private_jwk, encryption_key_id,
          created_at, activate_at, activated_at, sign_until, retired_at, verify_until
        ) VALUES (
          'oauth', 'retired', ${kid}, 'RS256', ${JSON.stringify(publicJwk)}::jsonb, 'not-used-by-oauth', 'test',
          now() - INTERVAL '2 hours', now() - INTERVAL '2 hours', now() - INTERVAL '2 hours',
          now() - INTERVAL '1 hour', now() - INTERVAL '30 minutes', now() + INTERVAL '1 hour'
        )
      `;
      const token = await new jose.SignJWT({
        token_use: "access",
        principal_type: "user",
        uid: "authority-user",
        id: userId,
        client_id: "authority-client",
        azp: "authority-client",
        scope: "openid",
      })
        .setProtectedHeader({ alg: "RS256", kid })
        .setIssuer(issuer)
        .setSubject(userId)
        .setAudience(["cloud", "authority-client"])
        .setIssuedAt()
        .setExpirationTime("1h")
        .setJti(crypto.randomUUID())
        .sign(privateKey);

      expect(await oauth.tokens.verifyAccessToken({ token, issuer })).toMatchObject({ id: userId, token_use: "access" });
      expect((await oauth.tokens.getJwks()).keys.map((key) => key.kid)).toContain(kid);

      await sql`UPDATE auth.signing_keys SET state = 'revoked', revoked_at = now() WHERE kid = ${kid}`;
      expect(await oauth.tokens.verifyAccessToken({ token, issuer })).not.toBeNull();
      oauth.tokens.clearOAuthVerifierCacheForTest();
      expect(await oauth.tokens.verifyAccessToken({ token, issuer })).toBeNull();
      expect((await oauth.tokens.getJwks()).keys.map((key) => key.kid)).not.toContain(kid);
    } finally {
      await sql`DELETE FROM auth.signing_keys WHERE kid = ${kid}`;
      await sql`DELETE FROM oauth.keys WHERE kid = ${kid}`;
    }
  });

  test("authorization codes can only be consumed once under concurrent exchange", async () => {
    const userId = await insertUser();
    let clientId: string | null = null;

    try {
      const created = await oauth.clients.create({
        actor: adminActor(userId),
        data: {
          name: `Authorization code race client ${crypto.randomUUID()}`,
          redirectUris: ["https://client.example.test/callback"],
          scopes: ["openid", "profile", "email"],
          audiences: ["cloud"],
          allowedProfiles: ["user"],
          accessMode: "profiles",
          allowedUserIds: [],
          allowedGroupIds: [],
          isPublic: false,
        },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      clientId = created.data.id;

      const code = await oauth.codes.create({
        clientId: created.data.clientId,
        userId,
        redirectUri: "https://client.example.test/callback",
        scopes: created.data.scopes,
      });

      const results = await Promise.all([
        oauth.codes.consume({
          code,
          clientId: created.data.clientId,
          redirectUri: "https://client.example.test/callback",
        }),
        oauth.codes.consume({
          code,
          clientId: created.data.clientId,
          redirectUri: "https://client.example.test/callback",
        }),
      ]);

      expect(results.filter((result) => result !== null)).toHaveLength(1);
      const [consumedCode] = await sql<{ authority_issued_at: Date | null }[]>`
        SELECT authority_issued_at FROM oauth.codes WHERE code = ${code}
      `;
      expect(consumedCode?.authority_issued_at).toBeNull();
      expect(results.filter((result) => result === null)).toHaveLength(1);
    } finally {
      if (clientId) await sql`DELETE FROM oauth.clients WHERE id = ${clientId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("authorization codes cannot outlive current client scope or resource policy", async () => {
    const userId = await insertUser();
    const oldResource = "https://old.example.test/api";
    let clientId: string | null = null;

    try {
      const created = await oauth.clients.create({
        actor: adminActor(userId),
        data: {
          name: `Code policy client ${crypto.randomUUID()}`,
          redirectUris: ["https://client.example.test/callback"],
          scopes: ["openid", "write"],
          audiences: [oldResource],
          allowedProfiles: ["user"],
          accessMode: "profiles",
          allowedUserIds: [],
          allowedGroupIds: [],
          isPublic: false,
        },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      clientId = created.data.id;

      const exchange = (code: string, resource?: string) => {
        const body = new URLSearchParams({
          grant_type: "authorization_code",
          client_id: created.data.clientId,
          client_secret: created.data.clientSecret,
          code,
          redirect_uri: "https://client.example.test/callback",
        });
        if (resource) body.set("resource", resource);
        return oauthRoutes.request("/oauth/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        });
      };

      const scopedCode = await oauth.codes.create({
        clientId: created.data.clientId,
        userId,
        redirectUri: "https://client.example.test/callback",
        scopes: ["write"],
      });
      await oauth.clients.update({ id: clientId, data: { scopes: ["openid"] }, actor: adminActor(userId) });
      expect(await (await exchange(scopedCode)).json()).toMatchObject({ error: "invalid_grant" });

      await oauth.clients.update({ id: clientId, data: { scopes: ["openid", "write"] }, actor: adminActor(userId) });
      const resourceCode = await oauth.codes.create({
        clientId: created.data.clientId,
        userId,
        redirectUri: "https://client.example.test/callback",
        scopes: ["openid"],
        resource: oldResource,
      });
      await oauth.clients.update({
        id: clientId,
        data: { audiences: ["https://new.example.test/api"] },
        actor: adminActor(userId),
      });
      expect(await (await exchange(resourceCode, oldResource)).json()).toMatchObject({ error: "invalid_grant" });
    } finally {
      if (clientId) await sql`DELETE FROM oauth.clients WHERE id = ${clientId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("authorization-code audience snapshots also bound the refresh family", async () => {
    const userId = await insertUser();
    let clientId: string | null = null;
    try {
      const created = await oauth.clients.create({
        actor: adminActor(userId),
        data: {
          name: `Audience snapshot client ${crypto.randomUUID()}`,
          redirectUris: ["https://client.example.test/callback"],
          scopes: ["openid", "offline_access"],
          audiences: ["cloud"],
          allowedProfiles: ["user"],
          accessMode: "profiles",
          allowedUserIds: [],
          allowedGroupIds: [],
          isPublic: false,
        },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      clientId = created.data.id;
      const code = await oauth.codes.create({
        clientId: created.data.clientId,
        userId,
        redirectUri: "https://client.example.test/callback",
        scopes: ["openid", "offline_access"],
      });
      await oauth.clients.update({
        id: clientId,
        actor: adminActor(userId),
        data: { audiences: ["cloud", "https://new.example.test/api"] },
      });
      const exchange = (body: Record<string, string>) =>
        oauthRoutes.request("/oauth/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: created.data.clientId,
            client_secret: created.data.clientSecret!,
            ...body,
          }),
        });
      const response = await exchange({ grant_type: "authorization_code", code, redirect_uri: "https://client.example.test/callback" });
      expect(response.status).toBe(200);
      const issued = (await response.json()) as { access_token: string; refresh_token: string };
      const expected = ["cloud", created.data.clientId];
      expect(jose.decodeJwt(issued.access_token).aud).toEqual(expected);
      const [family] = await sql<{ audiences: string[] }[]>`
        SELECT audiences FROM oauth.refresh_token_families WHERE client_id = ${created.data.clientId}
      `;
      expect(family?.audiences).toEqual(expected);
      const refreshed = await exchange({ grant_type: "refresh_token", refresh_token: issued.refresh_token });
      expect(refreshed.status).toBe(200);
      expect(jose.decodeJwt(((await refreshed.json()) as { access_token: string }).access_token).aud).toEqual(expected);
      const widerCode = await oauth.codes.create({
        clientId: created.data.clientId,
        userId,
        redirectUri: "https://client.example.test/callback",
        scopes: ["openid", "offline_access"],
      });
      await oauth.clients.update({ id: clientId, actor: adminActor(userId), data: { audiences: ["cloud"] } });
      const rejected = await exchange({
        grant_type: "authorization_code",
        code: widerCode,
        redirect_uri: "https://client.example.test/callback",
      });
      expect(await rejected.json()).toMatchObject({ error: "invalid_grant" });
    } finally {
      if (clientId) await sql`DELETE FROM oauth.clients WHERE id = ${clientId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("authorization requests without scope use conservative default scopes", async () => {
    const userId = await insertUser();
    const sessionToken = await createSessionToken(userId);
    let clientId: string | null = null;

    try {
      const created = await oauth.clients.create({
        actor: adminActor(userId),
        data: {
          name: `Authorization scope default client ${crypto.randomUUID()}`,
          redirectUris: ["https://client.example.test/callback"],
          scopes: ["openid", "profile", "email", "offline_access", "read", "write"],
          audiences: ["cloud"],
          allowedProfiles: ["user"],
          accessMode: "profiles",
          allowedUserIds: [],
          allowedGroupIds: [],
          isPublic: false,
        },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      clientId = created.data.id;

      const authorizeResponse = await oauthRoutes.request(
        `/oauth/authorize?${new URLSearchParams({
          client_id: created.data.clientId,
          redirect_uri: "https://client.example.test/callback",
          response_type: "code",
        })}`,
        {
          headers: { cookie: `session_token=${sessionToken}` },
          redirect: "manual",
        },
      );
      expect(authorizeResponse.status).toBe(302);
      const location = authorizeResponse.headers.get("location");
      expect(location).toBeTruthy();
      const authorizationResult = new URL(location!);
      expect(authorizationResult.searchParams.get("iss")).toBe("http://localhost:3000");
      const code = authorizationResult.searchParams.get("code");
      expect(code).toBeTruthy();

      const consumed = await oauth.codes.consume({
        code: code!,
        clientId: created.data.clientId,
        redirectUri: "https://client.example.test/callback",
      });
      expect(consumed?.scopes).toEqual(["openid"]);
    } finally {
      await auth.session.revoke(sessionToken);
      if (clientId) await sql`DELETE FROM oauth.clients WHERE id = ${clientId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("refresh tokens rotate and reused tokens revoke the token family", async () => {
    const userId = await insertUser();
    let clientId: string | null = null;

    try {
      const created = await oauth.clients.create({
        actor: adminActor(userId),
        data: {
          name: `Refresh token client ${crypto.randomUUID()}`,
          redirectUris: ["https://client.example.test/callback"],
          scopes: ["openid", "profile", "email", "offline_access"],
          audiences: ["cloud"],
          allowedProfiles: ["user"],
          accessMode: "profiles",
          allowedUserIds: [],
          allowedGroupIds: [],
          isPublic: false,
        },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      clientId = created.data.id;

      const code = await oauth.codes.create({
        clientId: created.data.clientId,
        userId,
        redirectUri: "https://client.example.test/callback",
        scopes: created.data.scopes,
      });
      const codeBody = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: created.data.clientId,
        client_secret: created.data.clientSecret,
        code,
        redirect_uri: "https://client.example.test/callback",
      });
      const codeResponse = await oauthRoutes.request("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: codeBody,
      });
      expect(codeResponse.status).toBe(200);
      expect(codeResponse.headers.get("cache-control")).toBe("no-store");
      expect(codeResponse.headers.get("pragma")).toBe("no-cache");
      const codeToken = (await codeResponse.json()) as { refresh_token: string; scope: string };
      expect(codeToken.scope.split(" ")).toContain("offline_access");
      expect(codeToken.refresh_token.startsWith("cld_rt_")).toBe(true);

      const refreshBody = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: created.data.clientId,
        client_secret: created.data.clientSecret,
        refresh_token: codeToken.refresh_token,
        scope: "openid offline_access",
      });
      const refreshResponse = await oauthRoutes.request("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: refreshBody,
      });
      expect(refreshResponse.status).toBe(200);
      const refreshed = (await refreshResponse.json()) as { refresh_token: string; scope: string };
      expect(refreshed.refresh_token.startsWith("cld_rt_")).toBe(true);
      expect(refreshed.refresh_token).not.toBe(codeToken.refresh_token);
      expect(refreshed.scope).toBe("openid offline_access");

      const durableDownscopeResponse = await oauthRoutes.request("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: created.data.clientId,
          client_secret: created.data.clientSecret,
          refresh_token: refreshed.refresh_token,
        }),
      });
      expect(durableDownscopeResponse.status).toBe(200);
      const durableDownscope = (await durableDownscopeResponse.json()) as { refresh_token: string; scope: string };
      expect(durableDownscope.scope).toBe("openid offline_access");

      const reuseResponse = await oauthRoutes.request("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: refreshBody,
      });
      expect(reuseResponse.status).toBe(400);
      expect(reuseResponse.headers.get("cache-control")).toBe("no-store");
      expect(await reuseResponse.json()).toMatchObject({ error: "invalid_grant" });

      const revokedFamilyResponse = await oauthRoutes.request("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: created.data.clientId,
          client_secret: created.data.clientSecret,
          refresh_token: durableDownscope.refresh_token,
        }),
      });
      expect(revokedFamilyResponse.status).toBe(400);
    } finally {
      if (clientId) await sql`DELETE FROM oauth.clients WHERE id = ${clientId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("refresh issuance reservations release unclaimed failures and fail closed after issuance", async () => {
    const userId = await insertUser();
    let clientId: string | null = null;
    const originalMode = process.env.CLOUD_OAUTH_ISSUANCE_MODE;
    try {
      const created = await oauth.clients.create({
        actor: adminActor(userId),
        data: {
          name: `Refresh authority client ${crypto.randomUUID()}`,
          redirectUris: ["https://client.example.test/callback"],
          scopes: ["openid", "offline_access"],
          audiences: ["cloud"],
          allowedProfiles: ["user"],
          accessMode: "profiles",
          allowedUserIds: [],
          allowedGroupIds: [],
          isPublic: false,
        },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      clientId = created.data.id;

      const createGrant = () =>
        oauth.refreshTokens.create({
          userId,
          client: created.data,
          scopes: ["openid", "offline_access"],
          audiences: ["cloud", created.data.clientId],
        });

      const knownFailure = await createGrant();
      await expect(
        oauth.refreshTokens.rotate(knownFailure.refreshToken, created.data, undefined, undefined, async () => {
          throw new Error("definite signing failure");
        }),
      ).rejects.toThrow("definite signing failure");
      const [knownFamily] = await sql<{ status: string; revoked_reason: string | null }[]>`
        SELECT status, revoked_reason FROM oauth.refresh_token_families WHERE id = ${knownFailure.familyId}::uuid
      `;
      expect(knownFamily).toMatchObject({ status: "active", revoked_reason: null });

      const successful = await createGrant();
      process.env.CLOUD_OAUTH_ISSUANCE_MODE = "core";
      const rotated = await oauth.refreshTokens.rotate(successful.refreshToken, created.data, undefined, undefined, async (grant) => {
        await sql`
          UPDATE oauth.refresh_tokens SET authority_issued_at = now()
          WHERE id = ${grant.authorityGrant.tokenId}::uuid AND authority_nonce = ${grant.authorityGrant.nonce}::uuid
        `;
        return "core";
      });
      expect(rotated.ok).toBe(true);
      if (rotated.ok) expect(rotated.refreshToken).not.toBe(successful.refreshToken);

      const replayRace = await createGrant();
      const firstRotation = await oauth.refreshTokens.rotate(replayRace.refreshToken, created.data, undefined, undefined, async (grant) => {
        await sql`
          UPDATE oauth.refresh_tokens SET authority_issued_at = now()
          WHERE id = ${grant.authorityGrant.tokenId}::uuid AND authority_nonce = ${grant.authorityGrant.nonce}::uuid
        `;
        return "core";
      });
      expect(firstRotation.ok).toBe(true);
      if (!firstRotation.ok) return;
      let entered!: () => void;
      let release!: () => void;
      const callbackEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const callbackRelease = new Promise<void>((resolve) => {
        release = resolve;
      });
      const inFlight = oauth.refreshTokens.rotate(firstRotation.refreshToken, created.data, undefined, undefined, async () => {
        entered();
        await callbackRelease;
        return "legacy";
      });
      await callbackEntered;
      expect(await oauth.refreshTokens.rotate(replayRace.refreshToken, created.data)).toMatchObject({
        ok: false,
        error: "reuse_detected",
      });
      release();
      await expect(inFlight).rejects.toThrow("could not be finalized");
      const [racedFamily] = await sql<{ status: string; revoked_reason: string | null }[]>`
        SELECT status, revoked_reason FROM oauth.refresh_token_families WHERE id = ${replayRace.familyId}::uuid
      `;
      expect(racedFamily).toMatchObject({ status: "revoked", revoked_reason: "refresh_token_reuse" });
      const [issuingAfterReplay] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM oauth.refresh_tokens
        WHERE family_id = ${replayRace.familyId}::uuid AND status = 'issuing'
      `;
      expect(issuingAfterReplay?.count).toBe(0);

      const unknownFailure = await createGrant();
      await expect(
        oauth.refreshTokens.rotate(unknownFailure.refreshToken, created.data, undefined, undefined, async (grant) => {
          await sql`
            UPDATE oauth.refresh_tokens SET authority_issued_at = now()
            WHERE id = ${grant.authorityGrant.tokenId}::uuid AND authority_nonce = ${grant.authorityGrant.nonce}::uuid
          `;
          throw new Error("unknown response outcome");
        }),
      ).rejects.toThrow("unknown response outcome");
      const [unknownFamily] = await sql<{ status: string; revoked_reason: string | null }[]>`
        SELECT status, revoked_reason FROM oauth.refresh_token_families WHERE id = ${unknownFailure.familyId}::uuid
      `;
      expect(unknownFamily).toMatchObject({ status: "revoked", revoked_reason: "authority_issuance_failed" });
      expect((await oauth.refreshTokens.rotate(unknownFailure.refreshToken, created.data)).ok).toBe(false);

      const stranded = await createGrant();
      await sql`
        UPDATE oauth.refresh_tokens
        SET status = 'issuing', authority_nonce = gen_random_uuid(), authority_reserved_at = now() - INTERVAL '10 minutes'
        WHERE family_id = ${stranded.familyId}::uuid
      `;
      await oauth.refreshTokens.cleanup();
      const [strandedFamily] = await sql<{ status: string; revoked_reason: string | null }[]>`
        SELECT status, revoked_reason FROM oauth.refresh_token_families WHERE id = ${stranded.familyId}::uuid
      `;
      expect(strandedFamily).toMatchObject({ status: "revoked", revoked_reason: "authority_issuance_stranded" });
    } finally {
      if (originalMode === undefined) delete process.env.CLOUD_OAUTH_ISSUANCE_MODE;
      else process.env.CLOUD_OAUTH_ISSUANCE_MODE = originalMode;
      if (clientId) await sql`DELETE FROM oauth.clients WHERE id = ${clientId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("loopback redirect validation allows ephemeral native app ports only for matching paths", async () => {
    const client = {
      id: crypto.randomUUID(),
      name: "Loopback client",
      description: null,
      clientId: "loopback-client",
      redirectUris: ["http://127.0.0.1/callback"],
      logoutUri: null,
      scopes: ["openid", "offline_access"],
      audiences: ["cloud"],
      serviceAccountId: null,
      allowedProfiles: ["user"],
      accessMode: "profiles",
      accessUsers: [],
      accessGroups: [],
      registrationKind: "managed",
      isPublic: true,
      createdAt: new Date().toISOString(),
      createdBy: null,
    } satisfies OAuthClient;

    expect(oauth.clients.validateRedirectUri(client, "http://127.0.0.1:49152/callback")).toBe(true);
    expect(oauth.clients.validateRedirectUri(client, "http://[::1]:49152/callback")).toBe(false);
    expect(oauth.clients.validateRedirectUri(client, "http://127.0.0.1:49152/other")).toBe(false);
    expect(oauth.clients.validateRedirectUri(client, "https://127.0.0.1/callback")).toBe(false);
    expect(oauth.clients.validateRedirectUri(client, "http://example.test/callback")).toBe(false);
    expect(
      oauth.clients.validateRedirectUri({ ...client, redirectUris: ["http://localhost/callback"] }, "http://localhost:49152/callback"),
    ).toBe(false);
  });

  test("OAuth discovery advertises native-client and RFC 8707 capabilities", async () => {
    const configuration = oauth.tokens.getOpenIdConfiguration("https://cloud.example.test");

    expect(configuration.grant_types_supported).toContain("authorization_code");
    expect(configuration.grant_types_supported).toContain("refresh_token");
    expect(configuration.scopes_supported).toContain("offline_access");
    expect(configuration.scopes_supported).not.toContain("groups");
    expect(configuration.scopes_supported).not.toContain("admin");
    expect(configuration.token_endpoint_auth_methods_supported).toContain("none");
    expect(configuration.registration_endpoint).toBe("https://cloud.example.test/oauth/register");
    expect(configuration.revocation_endpoint).toBe("https://cloud.example.test/oauth/revoke");
    expect(configuration.code_challenge_methods_supported).toEqual(["S256"]);
    expect(configuration.resource_parameter_supported).toBe(true);
    const response = await oauthRoutes.request("/.well-known/oauth-authorization-server");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      issuer: "http://localhost:3000",
      registration_endpoint: "http://localhost:3000/oauth/register",
      resource_parameter_supported: true,
    });
    const jwks = await oauthRoutes.request("/.well-known/jwks.json");
    expect(jwks.status).toBe(200);
    expect(jwks.headers.get("cache-control")).toBe("public, max-age=300, must-revalidate");
    const etag = jwks.headers.get("etag");
    expect(etag).toBeTruthy();
    if (!etag) throw new Error("JWKS response did not include an ETag");
    const unchanged = await oauthRoutes.request("/.well-known/jwks.json", { headers: { "if-none-match": etag } });
    expect(unchanged.status).toBe(304);
  });

  test("dynamically registers repeatable public client names without credentials", async () => {
    const clientIds: string[] = [];
    try {
      for (const redirectUri of ["http://127.0.0.1:49152/callback", "http://localhost:49153/callback"]) {
        const response = await oauthRoutes.request("/oauth/register", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": crypto.randomUUID() },
          body: JSON.stringify({
            client_name: "MCP test client",
            application_type: "native",
            redirect_uris: [redirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          }),
        });
        expect(response.status).toBe(201);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const registered = (await response.json()) as {
          application_type?: string;
          client_id: string;
          client_secret?: string;
          scope: string;
        };
        expect(registered.client_id).toBeTruthy();
        expect(registered.application_type).toBe("native");
        expect(registered.client_secret).toBeUndefined();
        expect(registered.scope.split(" ")).toEqual(["openid", "profile", "email", "offline_access", "read", "write"]);
        clientIds.push(registered.client_id);

        const client = await oauth.clients.getByClientId({ clientId: registered.client_id });
        expect(client).toMatchObject({
          name: "MCP test client",
          audiences: [],
          registrationKind: "dynamic",
          isPublic: true,
          createdBy: null,
        });
      }
      expect(new Set(clientIds).size).toBe(2);
    } finally {
      for (const clientId of clientIds) await sql`DELETE FROM oauth.clients WHERE client_id = ${clientId}`;
    }
  });

  test("paginates and filters OAuth clients in PostgreSQL", async () => {
    const marker = `pagination-${crypto.randomUUID()}`;
    const clients = await Promise.all(
      ["one", "two", "three"].map((suffix) =>
        oauth.clients.registerDynamic({
          name: `${marker}-${suffix}`,
          redirectUris: [`http://127.0.0.1:${49160 + suffix.length}/callback`],
          scopes: ["read"],
        }),
      ),
    );

    try {
      const first = await oauthService.client.list({ pagination: { page: 1, perPage: 2 }, filter: { query: marker } });
      const second = await oauthService.client.list({ pagination: { page: 2, perPage: 2 }, filter: { query: marker } });
      expect(first).toMatchObject({ page: 1, perPage: 2, total: 3, hasNext: true });
      expect(first.items).toHaveLength(2);
      expect(second).toMatchObject({ page: 2, perPage: 2, total: 3, hasNext: false });
      expect(second.items).toHaveLength(1);
      expect(new Set([...first.items, ...second.items].map((client) => client.id))).toEqual(new Set(clients.map((client) => client.id)));
    } finally {
      for (const client of clients) await sql`DELETE FROM oauth.clients WHERE id = ${client.id}::uuid`;
    }
  });

  test("returns the bounded OAuth client page contract from the admin API", async () => {
    const userId = await insertUser({ admin: true });
    const sessionToken = await createSessionToken(userId);
    const marker = `api-pagination-${crypto.randomUUID()}`;
    const clients = await Promise.all(
      ["one", "two", "three"].map((suffix) =>
        oauth.clients.registerDynamic({
          name: `${marker}-${suffix}`,
          redirectUris: [`http://127.0.0.1:${49200 + suffix.length}/callback`],
          scopes: ["read"],
        }),
      ),
    );

    try {
      const response = await adminApiRoutes.request(`/?page=2&per_page=2&search=${encodeURIComponent(marker)}`, {
        headers: { cookie: `session_token=${sessionToken}` },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        clients: OAuthClient[];
        pagination: { page: number; per_page: number; total: number; total_pages: number; has_next: boolean };
      };
      expect(body.clients).toHaveLength(1);
      expect(body.pagination).toEqual({ page: 2, per_page: 2, total: 3, total_pages: 2, has_next: false });
    } finally {
      await auth.session.revoke(sessionToken);
      for (const client of clients) await sql`DELETE FROM oauth.clients WHERE id = ${client.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("dynamic registration preserves an explicitly restricted scope", async () => {
    let clientId: string | null = null;
    try {
      const response = await oauthRoutes.request("/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": crypto.randomUUID() },
        body: JSON.stringify({
          client_name: "Read-only MCP client",
          application_type: "native",
          redirect_uris: ["http://127.0.0.1:49154/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope: "read",
        }),
      });
      expect(response.status).toBe(201);
      const registered = (await response.json()) as { client_id: string; scope: string };
      clientId = registered.client_id;
      expect(registered.scope).toBe("read");
      expect((await oauth.clients.getByClientId({ clientId }))?.scopes).toEqual(["read"]);
    } finally {
      if (clientId) await sql`DELETE FROM oauth.clients WHERE client_id = ${clientId}`;
    }
  });

  test("rejects unsafe dynamic client metadata before persistence", async () => {
    const response = await oauthRoutes.request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": crypto.randomUUID() },
      body: JSON.stringify({
        client_name: "Unsafe client",
        redirect_uris: ["http://attacker.example/callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_redirect_uri" });
  });

  test("bounds dynamic registration transport input", async () => {
    const wrongType = await oauthRoutes.request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "text/plain", "x-forwarded-for": crypto.randomUUID() },
      body: "not json",
    });
    expect(wrongType.status).toBe(415);
    expect(wrongType.headers.get("cache-control")).toBe("no-store");

    const tooLarge = await oauthRoutes.request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": crypto.randomUUID() },
      body: JSON.stringify({ client_name: "x".repeat(9_000), redirect_uris: ["http://127.0.0.1/callback"] }),
    });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ error: "invalid_client_metadata" });
  });

  test("rate-limits anonymous dynamic registration attempts", async () => {
    const forwardedFor = crypto.randomUUID();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await oauthRoutes.request("/oauth/register", {
        method: "POST",
        headers: { "content-type": "text/plain", "x-forwarded-for": forwardedFor },
        body: "not json",
      });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(415));
    expect(statuses[10]).toBe(429);
  });

  test("cleans only abandoned dynamic registrations", async () => {
    const clients = await Promise.all([
      oauth.clients.registerDynamic({
        name: "Unused dynamic client",
        redirectUris: ["http://127.0.0.1:49154/callback"],
        scopes: ["read"],
      }),
      oauth.clients.registerDynamic({
        name: "Authorized dynamic client",
        redirectUris: ["http://127.0.0.1:49155/callback"],
        scopes: ["read"],
      }),
    ]);
    try {
      await sql`UPDATE oauth.clients SET created_at = now() - INTERVAL '2 hours' WHERE id IN (${clients[0].id}::uuid, ${clients[1].id}::uuid)`;
      await oauth.clients.markDynamicAuthorized({ id: clients[1].id });

      expect(await oauth.clients.cleanupUnusedDynamic()).toBeGreaterThanOrEqual(1);
      expect(await oauth.clients.get({ id: clients[0].id })).toBeNull();
      expect(await oauth.clients.get({ id: clients[1].id })).not.toBeNull();
    } finally {
      await sql`DELETE FROM oauth.clients WHERE id IN (${clients[0].id}::uuid, ${clients[1].id}::uuid)`;
    }
  });

  test("requires one-time browser consent before a dynamic client can exchange a resource-bound code", async () => {
    const userId = await insertUser();
    const sessionToken = await createSessionToken(userId);
    const resource = "http://localhost:3000/api/mcp/v1";
    const redirectUri = "http://127.0.0.1:49152/callback";
    const verifier = "dynamic-client-verifier-0123456789-abcdefghi";
    const challenge = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toBase64({
      alphabet: "base64url",
      omitPadding: true,
    });
    let clientId: string | null = null;

    try {
      const client = await oauth.clients.registerDynamic({
        name: "Consent test client",
        redirectUris: [redirectUri],
        scopes: ["offline_access", "read", "write"],
      });
      clientId = client.clientId;

      const authorize = (state: string) =>
        oauthRoutes.request(
          `/oauth/authorize?${new URLSearchParams({
            client_id: client.clientId,
            redirect_uri: redirectUri,
            response_type: "code",
            scope: "offline_access read write",
            resource,
            state,
            code_challenge: challenge,
            code_challenge_method: "S256",
          })}`,
          { headers: { cookie: `session_token=${sessionToken}` }, redirect: "manual" },
        );

      const approvalStart = await authorize("approval-state");
      expect(approvalStart.status).toBe(302);
      const consentLocation = approvalStart.headers.get("location");
      expect(consentLocation).toStartWith("/oauth/consent?request=");
      const requestId = new URL(consentLocation!, "http://localhost:3000").searchParams.get("request");
      expect(requestId).toBeTruthy();

      const crossOriginApproval = await consentActionRoutes().request("/oauth/consent", {
        method: "POST",
        headers: {
          cookie: `session_token=${sessionToken}`,
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://attacker.example",
        },
        body: new URLSearchParams({ request: requestId!, decision: "approve" }),
        redirect: "manual",
      });
      expect(crossOriginApproval.headers.get("location")).toContain("/oauth/error?error=invalid_request");

      const approve = await consentActionRoutes().request("/oauth/consent", {
        method: "POST",
        headers: {
          cookie: `session_token=${sessionToken}`,
          "content-type": "application/x-www-form-urlencoded",
          origin: "http://localhost:3000",
        },
        body: new URLSearchParams({ request: requestId!, decision: "approve" }),
        redirect: "manual",
      });
      expect(approve.status).toBe(302);
      const callback = new URL(approve.headers.get("location")!);
      expect(callback.origin + callback.pathname).toBe(redirectUri);
      expect(callback.searchParams.get("state")).toBe("approval-state");
      expect(callback.searchParams.get("iss")).toBe("http://localhost:3000");
      const code = callback.searchParams.get("code");
      expect(code).toBeTruthy();
      const [authorizedClient] = await sql<{ authorized_at: Date | null }[]>`
        SELECT authorized_at FROM oauth.clients WHERE id = ${client.id}::uuid
      `;
      expect(authorizedClient?.authorized_at).toBeInstanceOf(Date);

      const replay = await consentActionRoutes().request("/oauth/consent", {
        method: "POST",
        headers: { cookie: `session_token=${sessionToken}`, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ request: requestId!, decision: "approve" }),
        redirect: "manual",
      });
      expect(replay.headers.get("location")).toContain("/oauth/error?error=invalid_request");

      const exchange = await oauthRoutes.request("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.clientId,
          code: code!,
          redirect_uri: redirectUri,
          resource,
          code_verifier: verifier,
        }),
      });
      expect(exchange.status).toBe(200);
      const tokens = (await exchange.json()) as { access_token: string; refresh_token: string; id_token?: string };
      expect(await oauthTokens.verifyAccessToken(tokens.access_token, resource)).not.toBeNull();
      expect(await oauthTokens.verifyAccessToken(tokens.access_token)).toBeNull();
      expect(tokens.refresh_token).toStartWith("cld_rt_");
      expect(tokens).not.toHaveProperty("id_token");

      const refresh = await oauthRoutes.request("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.clientId,
          refresh_token: tokens.refresh_token,
          resource,
        }),
      });
      expect(refresh.status).toBe(200);
      const refreshed = (await refresh.json()) as { access_token: string; refresh_token: string; id_token?: string };
      expect(await oauthTokens.verifyAccessToken(refreshed.access_token, resource)).not.toBeNull();
      expect(refreshed.refresh_token).toStartWith("cld_rt_");
      expect(refreshed).not.toHaveProperty("id_token");

      const denialStart = await authorize("denial-state");
      const denialRequest = new URL(denialStart.headers.get("location")!, "http://localhost:3000").searchParams.get("request");
      const deny = await consentActionRoutes().request("/oauth/consent", {
        method: "POST",
        headers: { cookie: `session_token=${sessionToken}`, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ request: denialRequest!, decision: "deny" }),
        redirect: "manual",
      });
      const denialCallback = new URL(deny.headers.get("location")!);
      expect(denialCallback.searchParams.get("error")).toBe("access_denied");
      expect(denialCallback.searchParams.get("state")).toBe("denial-state");
      expect(denialCallback.searchParams.get("iss")).toBe("http://localhost:3000");

      const foreignResource = await oauthRoutes.request(
        `/oauth/authorize?${new URLSearchParams({
          client_id: client.clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: "read",
          resource: "https://other.example/api/mcp/v1",
          code_challenge: challenge,
          code_challenge_method: "S256",
        })}`,
        { headers: { cookie: `session_token=${sessionToken}` }, redirect: "manual" },
      );
      expect(foreignResource.status).toBe(302);
      const foreignResourceCallback = new URL(foreignResource.headers.get("location")!);
      expect(foreignResourceCallback.searchParams.get("error")).toBe("invalid_target");
      expect(foreignResourceCallback.searchParams.get("iss")).toBe("http://localhost:3000");

      const immutableUpdate = await oauth.clients.update({
        id: client.id,
        data: { name: "Changed by administrator" },
        actor: adminActor(userId),
      });
      expect(immutableUpdate).toMatchObject({ ok: false, status: 400 });

      const revoked = await oauth.clients.delete_({
        id: client.id,
        actor: { id: userId, uid: `oauth-admin-${userId}`, provider: "local", roles: ["admin"] },
      });
      expect(revoked.ok).toBe(true);
      if (revoked.ok) clientId = null;
      expect(await oauthTokens.verifyAccessToken(tokens.access_token, resource)).toBeNull();

      const refreshAfterRevocation = await oauthRoutes.request("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.clientId,
          refresh_token: refreshed.refresh_token,
          resource,
        }),
      });
      expect(refreshAfterRevocation.status).toBe(401);
      expect(await refreshAfterRevocation.json()).toMatchObject({ error: "invalid_client" });
    } finally {
      await auth.session.revoke(sessionToken);
      if (clientId) await sql`DELETE FROM oauth.clients WHERE client_id = ${clientId}`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("keeps seeded first-party clients immutable and non-revocable through the admin lifecycle", async () => {
    const userId = await insertUser();
    try {
      const client = await oauth.clients.getByClientId({ clientId: "cloud-cli" });
      expect(client?.registrationKind).toBe("first_party");
      expect(await oauth.clients.update({ id: client!.id, data: { name: "Changed Cloud CLI" }, actor: adminActor(userId) })).toMatchObject({
        ok: false,
        status: 400,
      });
      expect(
        await oauth.clients.delete_({
          id: client!.id,
          actor: { id: userId, uid: `oauth-admin-${userId}`, provider: "local", roles: ["admin"] },
        }),
      ).toMatchObject({ ok: false, status: 400 });
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("migration restores Cloud CLI invariants and creator deletion preserves managed clients", async () => {
    const creatorId = await insertUser();
    const accessUserId = await insertUser();
    const accessGroupId = await insertGroup("oauth-migration");
    let managedClientId: string | null = null;

    try {
      const cloudCli = await oauth.clients.getByClientId({ clientId: "cloud-cli" });
      expect(cloudCli).not.toBeNull();
      await sql`
        UPDATE oauth.clients
        SET name = 'Legacy CLI',
          description = NULL,
          redirect_uris = ARRAY['https://wrong.example/callback'],
          scopes = ARRAY['admin'],
          audiences = ARRAY['wrong'],
          allowed_profiles = ARRAY['guest'],
          access_mode = 'specific',
          registration_kind = 'managed',
          is_public = false,
          client_secret_hash = 'legacy-secret'
        WHERE id = ${cloudCli!.id}::uuid
      `;
      await sql`INSERT INTO oauth.client_access_users (client_id, user_id) VALUES (${cloudCli!.id}::uuid, ${accessUserId}::uuid)`;
      await sql`INSERT INTO oauth.client_access_groups (client_id, group_id) VALUES (${cloudCli!.id}::uuid, ${accessGroupId}::uuid)`;
      const [legacyFamily] = await sql<{ id: string }[]>`
        INSERT INTO oauth.refresh_token_families (client_id, user_id, scopes, audiences, resource, expires_at)
        VALUES (
          'cloud-cli',
          ${accessUserId}::uuid,
          ARRAY['offline_access', 'read'],
          ARRAY['https://legacy.example.test/api'],
          NULL,
          now() + INTERVAL '30 days'
        )
        RETURNING id
      `;
      await sql`
        INSERT INTO oauth.refresh_tokens (family_id, token_prefix, secret_hash, generation, expires_at)
        VALUES (${legacyFamily!.id}::uuid, ${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}, 'legacy', 1, now() + INTERVAL '30 days')
      `;

      await migrate();
      await migrate();
      const restored = await oauth.clients.getByClientId({ clientId: "cloud-cli" });
      expect(restored).toMatchObject({
        name: "Cloud CLI",
        redirectUris: ["http://127.0.0.1/callback", "http://[::1]/callback"],
        scopes: ["openid", "profile", "email", "offline_access", "read", "write"],
        audiences: ["cloud"],
        serviceAccountId: null,
        allowedProfiles: ["user", "guest"],
        accessMode: "profiles",
        accessUsers: [],
        accessGroups: [],
        registrationKind: "first_party",
        isPublic: true,
      });
      const [secretRow] = await sql<{ client_secret_hash: string | null }[]>`
        SELECT client_secret_hash FROM oauth.clients WHERE id = ${cloudCli!.id}::uuid
      `;
      expect(secretRow?.client_secret_hash).toBeNull();
      const [legacyGrant] = await sql<{ family_status: string; token_status: string; revoked_reason: string | null }[]>`
        SELECT family.status AS family_status, token.status AS token_status, family.revoked_reason
        FROM oauth.refresh_token_families family
        JOIN oauth.refresh_tokens token ON token.family_id = family.id
        WHERE family.id = ${legacyFamily!.id}::uuid
      `;
      expect(legacyGrant).toEqual({
        family_status: "revoked",
        token_status: "revoked",
        revoked_reason: "legacy_resource_binding_migration",
      });

      const managed = await oauth.clients.create({
        actor: adminActor(creatorId),
        data: {
          name: `Creator lifecycle client ${crypto.randomUUID()}`,
          redirectUris: ["https://client.example.test/callback"],
          scopes: ["openid"],
          audiences: ["cloud"],
          allowedProfiles: ["user"],
          accessMode: "profiles",
          allowedUserIds: [],
          allowedGroupIds: [],
          isPublic: true,
        },
      });
      expect(managed.ok).toBe(true);
      if (!managed.ok) return;
      managedClientId = managed.data.id;

      await sql`DELETE FROM auth.users WHERE id = ${creatorId}::uuid`;
      expect(await oauth.clients.get({ id: managedClientId })).toMatchObject({ createdBy: null });
    } finally {
      if (managedClientId) await sql`DELETE FROM oauth.clients WHERE id = ${managedClientId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id IN (${creatorId}::uuid, ${accessUserId}::uuid)`;
      await sql`DELETE FROM auth.groups WHERE id = ${accessGroupId}::uuid`;
    }
  });

  test("concurrent managed client patches preserve independent fields", async () => {
    const userId = await insertUser();
    let clientId: string | null = null;
    try {
      const created = await oauth.clients.create({
        actor: adminActor(userId),
        data: {
          name: `Concurrent client ${crypto.randomUUID()}`,
          description: "before",
          redirectUris: ["https://client.example.test/callback"],
          scopes: ["openid"],
          audiences: ["cloud"],
          allowedProfiles: ["user"],
          accessMode: "profiles",
          allowedUserIds: [],
          allowedGroupIds: [],
          isPublic: true,
        },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      clientId = created.data.id;

      await Promise.all([
        oauth.clients.update({ id: clientId, data: { name: "Concurrent name" }, actor: adminActor(userId) }),
        oauth.clients.update({ id: clientId, data: { description: "Concurrent description" }, actor: adminActor(userId) }),
      ]);
      expect(await oauth.clients.get({ id: clientId })).toMatchObject({
        name: "Concurrent name",
        description: "Concurrent description",
      });
    } finally {
      if (clientId) await sql`DELETE FROM oauth.clients WHERE id = ${clientId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("token endpoint failures are non-cacheable and machine-readable", async () => {
    const response = await oauthRoutes.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "unsupported" }),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(await response.json()).toEqual({ error: "invalid_request", error_description: "Token request validation failed" });

    const mixedAuthentication = await oauthRoutes.request("/oauth/token", {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa("basic-client:secret")}`,
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-for": crypto.randomUUID(),
      },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: "body-client", refresh_token: "invalid" }),
    });
    expect(mixedAuthentication.status).toBe(400);
    expect(await mixedAuthentication.json()).toMatchObject({ error: "invalid_request" });

    const malformedBasic = await oauthRoutes.request("/oauth/token", {
      method: "POST",
      headers: {
        authorization: "Basic not-base64!",
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-for": crypto.randomUUID(),
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "invalid" }),
    });
    expect(malformedBasic.status).toBe(401);
    expect(malformedBasic.headers.get("www-authenticate")).toBe('Basic realm="oauth"');

    const oversized = await oauthRoutes.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": crypto.randomUUID() },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: "client", refresh_token: "x".repeat(17_000) }),
    });
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get("cache-control")).toBe("no-store");
    expect(await oversized.json()).toMatchObject({ error: "invalid_request" });

    const invalidResource = await oauthRoutes.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": crypto.randomUUID() },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "client",
        refresh_token: "invalid",
        resource: "https://cloud.example/api#fragment",
      }),
    });
    expect(invalidResource.status).toBe(400);
    expect(await invalidResource.json()).toMatchObject({ error: "invalid_target" });
  });

  test("preserves public authority errors while releasing refresh attempts proven unclaimed", async () => {
    const userId = await insertUser();
    const originalMode = process.env.CLOUD_OAUTH_ISSUANCE_MODE;
    const originalCredential = process.env.CLOUD_APP_CREDENTIAL;
    const originalCoreOrigin = process.env.CLOUD_CORE_INTERNAL_ORIGIN;
    const originalFetch = globalThis.fetch;
    let clientId: string | null = null;
    try {
      const created = await oauth.clients.create({
        actor: adminActor(userId),
        data: {
          name: `Authority error client ${crypto.randomUUID()}`,
          redirectUris: ["https://client.example.test/callback"],
          scopes: ["openid", "offline_access"],
          audiences: ["cloud"],
          allowedProfiles: ["user"],
          accessMode: "profiles",
          allowedUserIds: [],
          allowedGroupIds: [],
          isPublic: false,
        },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      clientId = created.data.id;
      process.env.CLOUD_OAUTH_ISSUANCE_MODE = "core";
      process.env.CLOUD_APP_CREDENTIAL = "test-workload";
      process.env.CLOUD_CORE_INTERNAL_ORIGIN = "http://core.internal:3000";
      await sql`UPDATE oauth.issuance_state SET mode = 'core', cutover_at = now(), updated_at = now() WHERE singleton = true`;
      globalThis.fetch = Object.assign(async () => new Response(null, { status: 403 }), { preconnect: originalFetch.preconnect });

      const code = await oauth.codes.create({
        clientId: created.data.clientId,
        userId,
        redirectUri: "https://client.example.test/callback",
        scopes: ["openid"],
      });
      const codeResponse = await oauthRoutes.request("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: created.data.clientId,
          client_secret: created.data.clientSecret,
          code,
          redirect_uri: "https://client.example.test/callback",
        }),
      });
      expect(codeResponse.status).toBe(400);
      expect(await codeResponse.json()).toMatchObject({ error: "invalid_grant" });

      const rejectedRefresh = await oauth.refreshTokens.create({
        userId,
        client: created.data,
        scopes: ["openid", "offline_access"],
        audiences: ["cloud", created.data.clientId],
      });
      const refreshRequest = (token: string) =>
        oauthRoutes.request("/oauth/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: created.data.clientId,
            client_secret: created.data.clientSecret,
            refresh_token: token,
          }),
        });
      const rejectedResponse = await refreshRequest(rejectedRefresh.refreshToken);
      expect(rejectedResponse.status).toBe(400);
      expect(await rejectedResponse.json()).toMatchObject({ error: "invalid_grant" });
      const [releasedFamily] = await sql<{ status: string }[]>`
        SELECT status FROM oauth.refresh_token_families WHERE id = ${rejectedRefresh.familyId}::uuid
      `;
      expect(releasedFamily?.status).toBe("active");

      const unknownRefresh = await oauth.refreshTokens.create({
        userId,
        client: created.data,
        scopes: ["openid", "offline_access"],
        audiences: ["cloud", created.data.clientId],
      });
      globalThis.fetch = Object.assign(
        async () => {
          throw new Error("unknown Core response outcome");
        },
        { preconnect: originalFetch.preconnect },
      );
      const unknownResponse = await refreshRequest(unknownRefresh.refreshToken);
      expect(unknownResponse.status).toBe(500);
      expect(await unknownResponse.json()).toMatchObject({ error: "server_error" });
      const [unclaimedFamily] = await sql<{ status: string }[]>`
        SELECT status FROM oauth.refresh_token_families WHERE id = ${unknownRefresh.familyId}::uuid
      `;
      expect(unclaimedFamily?.status).toBe("active");
    } finally {
      globalThis.fetch = originalFetch;
      await sql`UPDATE oauth.issuance_state SET mode = 'legacy', cutover_at = NULL, updated_at = now() WHERE singleton = true`;
      if (originalMode === undefined) delete process.env.CLOUD_OAUTH_ISSUANCE_MODE;
      else process.env.CLOUD_OAUTH_ISSUANCE_MODE = originalMode;
      if (originalCredential === undefined) delete process.env.CLOUD_APP_CREDENTIAL;
      else process.env.CLOUD_APP_CREDENTIAL = originalCredential;
      if (originalCoreOrigin === undefined) delete process.env.CLOUD_CORE_INTERNAL_ORIGIN;
      else process.env.CLOUD_CORE_INTERNAL_ORIGIN = originalCoreOrigin;
      if (clientId) await sql`DELETE FROM oauth.clients WHERE id = ${clientId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("UserInfo accepts only active openid user access tokens for the issuing client", async () => {
    const userId = await insertUser();
    let clientId: string | null = null;

    try {
      const created = await oauth.clients.create({
        actor: adminActor(userId),
        data: {
          name: `UserInfo client ${crypto.randomUUID()}`,
          redirectUris: ["https://client.example.test/callback"],
          scopes: ["openid", "email", "read"],
          audiences: ["cloud"],
          allowedProfiles: ["user"],
          accessMode: "profiles",
          allowedUserIds: [],
          allowedGroupIds: [],
          isPublic: false,
        },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      clientId = created.data.id;

      const tokens = await oauth.tokens.createTokens({
        userId,
        client: created.data,
        issuer: "http://localhost:3000",
        scopes: ["openid", "email"],
      });
      const userInfo = (token: string) => oauthRoutes.request("/oauth/userinfo", { headers: { authorization: `Bearer ${token}` } });

      const valid = await userInfo(tokens.accessToken);
      expect(valid.status).toBe(200);
      expect(valid.headers.get("cache-control")).toBe("no-store");
      expect(await valid.json()).toMatchObject({ id: userId });
      expect((await userInfo(tokens.idToken!)).status).toBe(401);

      const noOpenId = await oauth.tokens.createTokens({
        userId,
        client: created.data,
        issuer: "http://localhost:3000",
        scopes: ["read"],
      });
      expect((await userInfo(noOpenId.accessToken)).status).toBe(403);

      const resourceBound = await oauth.tokens.createTokens({
        userId,
        client: created.data,
        issuer: "http://localhost:3000",
        scopes: ["openid"],
        audiences: ["http://localhost:3000/api/mcp/v1"],
        resource: "http://localhost:3000/api/mcp/v1",
      });
      expect((await userInfo(resourceBound.accessToken)).status).toBe(401);

      await sql`UPDATE auth.users SET account_expires = now() - INTERVAL '1 minute' WHERE id = ${userId}::uuid`;
      expect((await userInfo(tokens.accessToken)).status).toBe(401);

      await sql`UPDATE auth.users SET account_expires = NULL WHERE id = ${userId}::uuid`;
      await sql`DELETE FROM oauth.clients WHERE id = ${clientId}::uuid`;
      clientId = null;
      expect((await userInfo(tokens.accessToken)).status).toBe(401);
    } finally {
      if (clientId) await sql`DELETE FROM oauth.clients WHERE id = ${clientId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("expired accounts cannot authorize or refresh and failed refreshes do not rotate", async () => {
    const userId = await insertUser();
    const sessionToken = await createSessionToken(userId);
    let clientId: string | null = null;

    try {
      const created = await oauth.clients.create({
        actor: adminActor(userId),
        data: {
          name: `Account lifecycle client ${crypto.randomUUID()}`,
          redirectUris: ["https://client.example.test/callback"],
          scopes: ["openid", "offline_access", "read"],
          audiences: ["cloud"],
          allowedProfiles: ["user"],
          accessMode: "profiles",
          allowedUserIds: [],
          allowedGroupIds: [],
          isPublic: false,
        },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      clientId = created.data.id;

      const issued = await oauth.tokens.createTokens({
        userId,
        client: created.data,
        issuer: "http://localhost:3000",
        scopes: ["openid", "offline_access", "read"],
        issueRefreshToken: true,
      });
      expect(issued.refreshToken).toBeTruthy();

      await sql`UPDATE auth.users SET account_expires = now() - INTERVAL '1 minute' WHERE id = ${userId}::uuid`;
      const authorize = await oauthRoutes.request(
        `/oauth/authorize?${new URLSearchParams({
          client_id: created.data.clientId,
          redirect_uri: "https://client.example.test/callback",
          response_type: "code",
          scope: "openid read",
        })}`,
        { headers: { cookie: `session_token=${sessionToken}` }, redirect: "manual" },
      );
      expect(authorize.status).toBe(302);
      expect(authorize.headers.get("location")).toStartWith("/auth/login?");

      const refresh = () =>
        oauthRoutes.request("/oauth/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: created.data.clientId,
            client_secret: created.data.clientSecret,
            refresh_token: issued.refreshToken!,
          }),
        });
      const denied = await refresh();
      expect(denied.status).toBe(400);
      expect(await denied.json()).toMatchObject({ error: "invalid_grant" });

      await sql`UPDATE auth.users SET account_expires = NULL WHERE id = ${userId}::uuid`;
      expect((await refresh()).status).toBe(200);
    } finally {
      await auth.session.revoke(sessionToken);
      if (clientId) await sql`DELETE FROM oauth.clients WHERE id = ${clientId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("public clients must use PKCE S256", async () => {
    const userId = await insertUser();
    let clientId: string | null = null;

    try {
      const created = await oauth.clients.create({
        actor: adminActor(userId),
        data: {
          name: `Public PKCE client ${crypto.randomUUID()}`,
          redirectUris: ["http://127.0.0.1/callback"],
          scopes: ["openid"],
          audiences: ["cloud"],
          allowedProfiles: ["user"],
          accessMode: "profiles",
          allowedUserIds: [],
          allowedGroupIds: [],
          isPublic: true,
        },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      clientId = created.data.id;

      const missingMethod = await oauthRoutes.request(
        `/oauth/authorize?${new URLSearchParams({
          client_id: created.data.clientId,
          redirect_uri: "http://127.0.0.1:49152/callback",
          response_type: "code",
          code_challenge: "a".repeat(43),
        })}`,
      );
      expect(missingMethod.status).toBe(302);
      expect(new URL(missingMethod.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");

      const plainMethod = await oauthRoutes.request(
        `/oauth/authorize?${new URLSearchParams({
          client_id: created.data.clientId,
          redirect_uri: "http://127.0.0.1:49152/callback",
          response_type: "code",
          code_challenge: "a".repeat(43),
          code_challenge_method: "plain",
        })}`,
      );
      expect(plainMethod.status).toBe(302);
      expect(new URL(plainMethod.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
    } finally {
      if (clientId) await sql`DELETE FROM oauth.clients WHERE id = ${clientId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("confidential clients reject PKCE plain", async () => {
    const userId = await insertUser();
    let clientId: string | null = null;

    try {
      const created = await oauth.clients.create({
        actor: adminActor(userId),
        data: {
          name: `Confidential PKCE client ${crypto.randomUUID()}`,
          redirectUris: ["https://client.example.test/callback"],
          scopes: ["openid"],
          audiences: ["cloud"],
          allowedProfiles: ["user"],
          accessMode: "profiles",
          allowedUserIds: [],
          allowedGroupIds: [],
          isPublic: false,
        },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      clientId = created.data.id;

      const response = await oauthRoutes.request(
        `/oauth/authorize?${new URLSearchParams({
          client_id: created.data.clientId,
          redirect_uri: "https://client.example.test/callback",
          response_type: "code",
          code_challenge: "a".repeat(43),
          code_challenge_method: "plain",
        })}`,
      );
      expect(response.status).toBe(302);
      expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
    } finally {
      if (clientId) await sql`DELETE FROM oauth.clients WHERE id = ${clientId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("refresh tokens keep the original grant audiences after client changes", async () => {
    const userId = await insertUser();
    let clientId: string | null = null;

    try {
      const created = await oauth.clients.create({
        actor: adminActor(userId),
        data: {
          name: `Refresh audience client ${crypto.randomUUID()}`,
          redirectUris: ["https://client.example.test/callback"],
          scopes: ["openid", "offline_access"],
          audiences: ["old-api"],
          allowedProfiles: ["user"],
          accessMode: "profiles",
          allowedUserIds: [],
          allowedGroupIds: [],
          isPublic: false,
        },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      clientId = created.data.id;

      const code = await oauth.codes.create({
        clientId: created.data.clientId,
        userId,
        redirectUri: "https://client.example.test/callback",
        scopes: created.data.scopes,
      });
      const codeResponse = await oauthRoutes.request("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: created.data.clientId,
          client_secret: created.data.clientSecret,
          code,
          redirect_uri: "https://client.example.test/callback",
        }),
      });
      expect(codeResponse.status).toBe(200);
      const codeToken = (await codeResponse.json()) as { access_token: string; refresh_token: string };
      const initialPayload = jose.decodeJwt(codeToken.access_token);
      const initialAudience = Array.isArray(initialPayload.aud) ? initialPayload.aud : [initialPayload.aud];

      await sql`
        UPDATE oauth.clients
        SET audiences = ARRAY['old-api', 'new-api']
        WHERE id = ${clientId}::uuid
      `;

      const refreshResponse = await oauthRoutes.request("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: created.data.clientId,
          client_secret: created.data.clientSecret,
          refresh_token: codeToken.refresh_token,
        }),
      });
      expect(refreshResponse.status).toBe(200);
      const refreshed = (await refreshResponse.json()) as { access_token: string };
      const payload = jose.decodeJwt(refreshed.access_token);
      const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      expect(audience).toEqual(initialAudience);
      expect(audience).toContain("cloud");
      expect(audience).toContain(created.data.clientId);
      expect(audience).toContain("old-api");
      expect(audience).not.toContain("new-api");
    } finally {
      if (clientId) await sql`DELETE FROM oauth.clients WHERE id = ${clientId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("authorization codes and refresh families stay bound to one MCP resource", async () => {
    const userId = await insertUser();
    const sessionToken = await createSessionToken(userId);
    const resource = "https://cloud.example/api/mcp/v1";
    let clientId: string | null = null;

    try {
      const created = await oauth.clients.create({
        actor: adminActor(userId),
        data: {
          name: `MCP resource client ${crypto.randomUUID()}`,
          redirectUris: ["https://client.example.test/callback"],
          scopes: ["openid", "offline_access", "read", "write"],
          audiences: [resource],
          allowedProfiles: ["user"],
          accessMode: "profiles",
          allowedUserIds: [],
          allowedGroupIds: [],
          isPublic: true,
        },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      clientId = created.data.id;

      const verifier = "mcp-public-client-verifier-0123456789-abcdef";
      const challenge = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toBase64({
        alphabet: "base64url",
        omitPadding: true,
      });
      const authorize = await oauthRoutes.request(
        `/oauth/authorize?${new URLSearchParams({
          client_id: created.data.clientId,
          redirect_uri: "https://client.example.test/callback",
          response_type: "code",
          scope: "openid offline_access read write",
          resource,
          code_challenge: challenge,
          code_challenge_method: "S256",
        })}`,
        { headers: { cookie: `session_token=${sessionToken}` }, redirect: "manual" },
      );
      expect(authorize.status).toBe(302);
      const code = new URL(authorize.headers.get("location")!).searchParams.get("code");
      expect(code).toBeTruthy();
      const exchange = (requestedResource?: string) => {
        const body = new URLSearchParams({
          grant_type: "authorization_code",
          client_id: created.data.clientId,
          code: code!,
          redirect_uri: "https://client.example.test/callback",
          code_verifier: verifier,
        });
        if (requestedResource) body.set("resource", requestedResource);
        return oauthRoutes.request("/oauth/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        });
      };

      expect((await exchange()).status).toBe(400);
      const codeResponse = await exchange(resource);
      expect(codeResponse.status).toBe(200);
      const codeToken = (await codeResponse.json()) as { access_token: string; refresh_token: string };
      expect(await oauthTokens.verifyAccessToken(codeToken.access_token, resource)).not.toBeNull();
      expect(await oauthTokens.verifyAccessToken(codeToken.access_token)).toBeNull();
      expect(await oauthTokens.verifyAccessToken(codeToken.access_token, "https://other.example/api/mcp/v1")).toBeNull();
      const resourceProbe = new Hono<AuthContext>()
        .use(auth.requireRole("authenticated", { oauthAudience: ["cloud", resource] }))
        .get("/probe", (c) => c.json({ actor: c.get("actor").kind, scopes: c.get("oauthScopes") }));
      const probe = await resourceProbe.request("/probe", {
        headers: { Authorization: `Bearer ${codeToken.access_token}` },
      });
      expect(probe.status).toBe(200);
      expect(await probe.json()).toEqual({ actor: "user", scopes: ["openid", "offline_access", "read", "write"] });

      const mcp = createMcpRoutes({
        getAppUrl: async () => "cloud.example",
        listApps: async () => [],
        limit: async (_c, next) => next(),
      });
      const mcpResponse = await mcp.request("/mcp/v1", {
        method: "POST",
        headers: {
          authorization: `Bearer ${codeToken.access_token}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(mcpResponse.status).toBe(200);
      expect(await mcpResponse.json()).toMatchObject({ result: { tools: expect.any(Array) } });

      const refresh = (requestedResource: string, scope?: string) =>
        oauthRoutes.request("/oauth/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: created.data.clientId,
            client_secret: created.data.clientSecret,
            refresh_token: codeToken.refresh_token,
            resource: requestedResource,
            ...(scope ? { scope } : {}),
          }),
        });
      expect((await refresh("https://other.example/api/mcp/v1")).status).toBe(400);
      const invalidScope = await refresh(resource, "admin");
      expect(invalidScope.status).toBe(400);
      expect(await invalidScope.json()).toMatchObject({ error: "invalid_scope" });
      const refreshResponse = await refresh(resource);
      expect(refreshResponse.status).toBe(200);
      const refreshed = (await refreshResponse.json()) as { access_token: string };
      expect(await oauthTokens.verifyAccessToken(refreshed.access_token, resource)).not.toBeNull();
      expect(await oauthTokens.verifyAccessToken(refreshed.access_token)).toBeNull();
    } finally {
      await auth.session.revoke(sessionToken);
      if (clientId) await sql`DELETE FROM oauth.clients WHERE id = ${clientId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("refresh token revocation invalidates the grant without exposing token details", async () => {
    const userId = await insertUser();
    let clientId: string | null = null;

    try {
      const created = await oauth.clients.create({
        actor: adminActor(userId),
        data: {
          name: `Refresh token revocation client ${crypto.randomUUID()}`,
          redirectUris: ["https://client.example.test/callback"],
          scopes: ["openid", "profile", "email", "offline_access"],
          audiences: ["cloud"],
          allowedProfiles: ["user"],
          accessMode: "profiles",
          allowedUserIds: [],
          allowedGroupIds: [],
          isPublic: false,
        },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      clientId = created.data.id;

      const code = await oauth.codes.create({
        clientId: created.data.clientId,
        userId,
        redirectUri: "https://client.example.test/callback",
        scopes: created.data.scopes,
      });
      const codeResponse = await oauthRoutes.request("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: created.data.clientId,
          client_secret: created.data.clientSecret,
          code,
          redirect_uri: "https://client.example.test/callback",
        }),
      });
      expect(codeResponse.status).toBe(200);
      const codeToken = (await codeResponse.json()) as { access_token: string; refresh_token: string };

      const revokeResponse = await oauthRoutes.request("/oauth/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: codeToken.refresh_token,
          token_type_hint: "access_token",
          client_id: created.data.clientId,
          client_secret: created.data.clientSecret,
        }),
      });
      expect(revokeResponse.status).toBe(200);
      expect(await oauthTokens.verifyAccessToken(codeToken.access_token)).not.toBeNull();

      const refreshResponse = await oauthRoutes.request("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: created.data.clientId,
          client_secret: created.data.clientSecret,
          refresh_token: codeToken.refresh_token,
        }),
      });
      expect(refreshResponse.status).toBe(400);

      await sql`
        UPDATE oauth.refresh_token_families
        SET revoked_at = now() - INTERVAL '2 days'
        WHERE client_id = ${created.data.clientId}
      `;
      expect(await oauth.refreshTokens.cleanup()).toBeGreaterThanOrEqual(1);
      const [remaining] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM oauth.refresh_token_families
        WHERE client_id = ${created.data.clientId}
      `;
      expect(remaining?.count).toBe(0);
    } finally {
      if (clientId) await sql`DELETE FROM oauth.clients WHERE id = ${clientId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("specific client access allows direct users and recursive group members only", async () => {
    const creatorId = await insertUser();
    const directUserId = await insertUser();
    const nestedUserId = await insertUser();
    const deniedUserId = await insertUser();
    const parentGroupId = await insertGroup("oauth-parent");
    const childGroupId = await insertGroup("oauth-child");
    let clientId: string | null = null;

    try {
      await sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${parentGroupId}::uuid, ${childGroupId}::uuid)`;
      await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${nestedUserId}::uuid, ${childGroupId}::uuid)`;

      const created = await oauth.clients.create({
        actor: adminActor(creatorId),
        data: {
          name: `Specific access client ${crypto.randomUUID()}`,
          redirectUris: ["https://client.example.test/callback"],
          scopes: ["openid", "profile", "email"],
          audiences: ["cloud"],
          allowedProfiles: ["user", "guest"],
          accessMode: "specific",
          allowedUserIds: [directUserId],
          allowedGroupIds: [parentGroupId],
          isPublic: false,
        },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      clientId = created.data.id;

      expect(await oauth.clients.canAuthorizeUser({ client: created.data, userId: directUserId, profile: "user" })).toBe(true);
      expect(await oauth.clients.canAuthorizeUser({ client: created.data, userId: nestedUserId, profile: "user" })).toBe(true);
      expect(await oauth.clients.canAuthorizeUser({ client: created.data, userId: deniedUserId, profile: "user" })).toBe(false);
    } finally {
      if (clientId) await sql`DELETE FROM oauth.clients WHERE id = ${clientId}::uuid`;
      await sql`DELETE FROM auth.user_groups_v2 WHERE user_id IN (${directUserId}::uuid, ${nestedUserId}::uuid, ${deniedUserId}::uuid)`;
      await sql`DELETE FROM auth.group_groups_v2 WHERE parent_group_id = ${parentGroupId}::uuid OR child_group_id = ${childGroupId}::uuid`;
      await sql`DELETE FROM auth.groups WHERE id IN (${parentGroupId}::uuid, ${childGroupId}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id IN (${creatorId}::uuid, ${directUserId}::uuid, ${nestedUserId}::uuid, ${deniedUserId}::uuid)`;
    }
  });

  test("client credentials resolve as resource service-account actors and validate scope/resource", async () => {
    const userId = await insertUser();
    let clientId: string | null = null;
    let serviceAccountId: string | null = null;

    try {
      const serviceAccount = await serviceAccounts.createResourceBound({
        name: `OAuth resource service ${crypto.randomUUID()}`,
        appId: "oauth-test",
        resourceType: "fixture",
        resourceId: crypto.randomUUID(),
        createdBy: userId,
      });
      expect(serviceAccount.ok).toBe(true);
      if (!serviceAccount.ok) return;
      serviceAccountId = serviceAccount.data.id;

      const publicBinding = await oauth.clients.create({
        actor: adminActor(userId),
        data: {
          name: `Invalid public service token client ${crypto.randomUUID()}`,
          redirectUris: [],
          scopes: ["read"],
          audiences: ["cloud"],
          serviceAccountId: serviceAccount.data.id,
          allowedProfiles: ["user"],
          accessMode: "profiles",
          allowedUserIds: [],
          allowedGroupIds: [],
          isPublic: true,
        },
      });
      expect(publicBinding.ok).toBe(false);

      const created = await oauth.clients.create({
        actor: adminActor(userId),
        data: {
          name: `Service token client ${crypto.randomUUID()}`,
          redirectUris: [],
          scopes: ["read", "write"],
          audiences: ["cloud", "https://oauth-test.example/api"],
          serviceAccountId: serviceAccount.data.id,
          allowedProfiles: ["user"],
          accessMode: "profiles",
          allowedUserIds: [],
          allowedGroupIds: [],
          isPublic: false,
        },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      clientId = created.data.id;

      for (const resource of ["oauth-test-api", "https://oauth-test.example/api#fragment"]) {
        const response = await requestClientCredentialsToken({
          clientId: created.data.clientId,
          clientSecret: created.data.clientSecret,
          scope: "read",
          resource,
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: "invalid_target" });
      }

      const invalidScope = await requestClientCredentialsToken({
        clientId: created.data.clientId,
        clientSecret: created.data.clientSecret,
        scope: "admin",
      });
      expect(invalidScope.status).toBe(400);

      const invalidResource = await requestClientCredentialsToken({
        clientId: created.data.clientId,
        clientSecret: created.data.clientSecret,
        scope: "read",
        resource: "https://other.example/api",
      });
      expect(invalidResource.status).toBe(400);

      const tokenResponse = await requestClientCredentialsToken({
        clientId: created.data.clientId,
        clientSecret: created.data.clientSecret,
        scope: "read",
        resource: "https://oauth-test.example/api",
      });
      expect(tokenResponse.status).toBe(200);
      const tokenBody = (await tokenResponse.json()) as {
        access_token: string;
        token_type: string;
        id_token?: string;
        scope: string;
      };
      expect(tokenBody.token_type).toBe("Bearer");
      expect(tokenBody).not.toHaveProperty("id_token");
      expect(tokenBody.scope).toBe("read");

      const verified = await oauthTokens.verifyAccessToken(tokenBody.access_token, "https://oauth-test.example/api");
      expect(verified?.kind).toBe("service_account");
      expect(verified?.kind === "service_account" ? verified.serviceAccount.id : null).toBe(serviceAccount.data.id);
      expect(await oauthTokens.verifyAccessToken(tokenBody.access_token)).toBeNull();

      const resourceProbe = new Hono<AuthContext>()
        .use(auth.requireRole("authenticated", { oauthAudience: "https://oauth-test.example/api" }))
        .get("/probe", (c) => {
          const actor = c.get("actor");
          return c.json({
            actorKind: actor.kind,
            userId: c.get("user")?.id ?? null,
            serviceAccountId: actor.kind === "service_account" ? actor.serviceAccount.id : null,
            accessSubject: c.get("accessSubject"),
          });
        });
      const response = await resourceProbe.request("/probe", {
        headers: { Authorization: `Bearer ${tokenBody.access_token}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        actorKind: "service_account",
        userId: null,
        serviceAccountId: serviceAccount.data.id,
        accessSubject: { type: "service_account", serviceAccountId: serviceAccount.data.id },
      });
    } finally {
      if (clientId) await sql`DELETE FROM oauth.clients WHERE id = ${clientId}::uuid`;
      if (serviceAccountId) await sql`DELETE FROM auth.service_accounts WHERE id = ${serviceAccountId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
});
