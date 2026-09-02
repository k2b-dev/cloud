import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { publicCloudOrigin } from "../shared/app-url";
import { clearOAuthVerifierCachesForTest, resolveOAuthTokenActor, verifyAccessToken } from "./oauth-tokens";
import * as settings from "./settings";

const canUseDatabase = async (): Promise<boolean> => {
  try {
    const [row] = await sql<Array<{ clients: string | null; users: string | null }>>`
      SELECT to_regclass('oauth.clients')::text AS clients,
             to_regclass('auth.users')::text AS users
    `;
    const [client] = await sql<Array<{ present: boolean }>>`
      SELECT true AS present FROM oauth.clients WHERE client_id = 'cloud-cli'
    `;
    return Boolean(row?.clients && row.users && client?.present);
  } catch {
    return false;
  }
};

const suite = (await canUseDatabase()) ? describe : describe.skip;
const userId = crypto.randomUUID();
const uid = `oauth-verifier-${userId}`;
const coreKid = crypto.randomUUID();
const legacyKid = crypto.randomUUID();
const serviceAccountId = crypto.randomUUID();
let issuer: string;
let corePrivateKey: CryptoKey;
let legacyPrivateKey: CryptoKey;
let jwks: { keys: JWK[] };

const accessToken = (privateKey: CryptoKey, kid: string) => {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    token_use: "access",
    principal_type: "user",
    uid,
    id: userId,
    client_id: "cloud-cli",
    azp: "cloud-cli",
    scope: "read",
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(issuer)
    .setSubject(userId)
    .setAudience(["cloud", "cloud-cli"])
    .setIssuedAt(now)
    .setExpirationTime(now + 3_600)
    .setJti(crypto.randomUUID())
    .sign(privateKey);
};

suite("OAuth access-token verifier", () => {
  beforeAll(async () => {
    issuer = publicCloudOrigin(await settings.get<string>("app.url"));
    const corePair = await generateKeyPair("RS256", { extractable: true });
    const legacyPair = await generateKeyPair("RS256", { extractable: true });
    corePrivateKey = corePair.privateKey;
    legacyPrivateKey = legacyPair.privateKey;
    jwks = {
      keys: [
        { ...(await exportJWK(corePair.publicKey)), alg: "RS256", kid: coreKid, use: "sig" },
        { ...(await exportJWK(legacyPair.publicKey)), alg: "RS256", kid: legacyKid, use: "sig" },
      ],
    };

    await sql`
      INSERT INTO auth.users (id, uid, provider, profile, given_name, sn, display_name, mail)
      VALUES (${userId}, ${uid}, 'local', 'user', 'OAuth', 'Verifier', 'OAuth Verifier', ${`${uid}@example.test`})
    `;
    await sql`
      INSERT INTO auth.service_accounts (id, name, kind, status, delegated_user_id)
      VALUES (${serviceAccountId}, 'OAuth verifier delegate', 'user_delegated', 'active', ${userId})
    `;
  });

  afterAll(async () => {
    clearOAuthVerifierCachesForTest();
    await sql`DELETE FROM auth.service_accounts WHERE id = ${serviceAccountId}`;
    await sql`DELETE FROM auth.users WHERE id = ${userId}`;
  });

  test("accepts Core and legacy keys from one JWKS without a key-table query", async () => {
    let queries = 0;
    const countedSql = new Proxy(sql, {
      apply(target, thisArg, args) {
        queries += 1;
        return Reflect.apply(target, thisArg, args);
      },
    });
    const key = createLocalJWKSet(jwks);
    const options = { issuer, key, groupsAdmin: ["admins"], query: countedSql };

    expect(await verifyAccessToken(await accessToken(corePrivateKey, coreKid), "cloud", options)).toMatchObject({
      kind: "user",
      payload: { aud: ["cloud", "cloud-cli"], azp: "cloud-cli", client_id: "cloud-cli", token_use: "access" },
      user: { id: userId },
      scopes: ["read"],
    });
    expect(queries).toBe(1);
    expect(await verifyAccessToken(await accessToken(legacyPrivateKey, legacyKid), "cloud", options)).toMatchObject({
      kind: "user",
      user: { id: userId },
    });
    expect(queries).toBe(2);
  });

  test("keeps a warm remote JWKS local and performs at most one forced unknown-kid refresh", async () => {
    clearOAuthVerifierCachesForTest();
    let jwksRequests = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        jwksRequests += 1;
        return Response.json(jwks);
      },
    });
    const jwksUrl = new URL("/.well-known/jwks.json", server.url);
    const options = { issuer, jwksUrl, groupsAdmin: ["admins"] };

    try {
      expect(await verifyAccessToken(await accessToken(corePrivateKey, coreKid), "cloud", options)).not.toBeNull();
      expect(await verifyAccessToken(await accessToken(corePrivateKey, coreKid), "cloud", options)).not.toBeNull();
      expect(jwksRequests).toBe(1);

      const unknown = await accessToken(corePrivateKey, crypto.randomUUID());
      expect(await verifyAccessToken(unknown, "cloud", options)).toBeNull();
      expect(jwksRequests).toBe(2);
      expect(await verifyAccessToken(unknown, "cloud", options)).toBeNull();
      expect(jwksRequests).toBe(2);
    } finally {
      server.stop(true);
      clearOAuthVerifierCachesForTest();
    }
  });

  test("loads the client and complete principal in one actor-resolution query", async () => {
    let queries = 0;
    const countedSql = new Proxy(sql, {
      apply(target, thisArg, args) {
        queries += 1;
        return Reflect.apply(target, thisArg, args);
      },
    });

    const user = await resolveOAuthTokenActor(
      { token_use: "access", client_id: "cloud-cli", id: userId, uid, scope: "read write" },
      ["admins"],
      countedSql,
    );
    expect(queries).toBe(1);
    expect(user).toMatchObject({ kind: "user", user: { id: userId, uid }, scopes: ["read", "write"] });

    const service = await resolveOAuthTokenActor(
      { token_use: "access", client_id: "cloud-cli", service_account_id: serviceAccountId, scope: "read" },
      ["admins"],
      countedSql,
    );
    expect(queries).toBe(2);
    expect(service).toMatchObject({
      kind: "service_account",
      serviceAccount: { id: serviceAccountId, status: "active", delegatedUserId: userId },
      delegatedUser: { id: userId, uid },
      scopes: ["read"],
    });
  });

  test("rejects disabled service accounts and expired delegated users in the joined read", async () => {
    const payload = { token_use: "access", client_id: "cloud-cli", service_account_id: serviceAccountId, scope: "read" };
    await sql`UPDATE auth.service_accounts SET status = 'disabled' WHERE id = ${serviceAccountId}`;
    expect(await resolveOAuthTokenActor(payload, ["admins"])).toBeNull();

    await sql`UPDATE auth.service_accounts SET status = 'active' WHERE id = ${serviceAccountId}`;
    await sql`UPDATE auth.users SET account_expires = now() - INTERVAL '1 minute' WHERE id = ${userId}`;
    expect(await resolveOAuthTokenActor(payload, ["admins"])).toBeNull();
  });
});
