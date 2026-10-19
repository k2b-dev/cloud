import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { sql } from "bun";
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { publicCloudOrigin } from "../shared/app-url";
import { clearOAuthVerifierCachesForTest, resolveOAuthTokenActor, verifyAccessToken } from "./oauth-tokens";
import * as settings from "./settings";

const withFrozenTime = async (run: () => Promise<void>) => {
  const [clock] = await sql<{ now: Date }[]>`SELECT now() AS now`;
  setSystemTime(clock!.now);
  try {
    await run();
  } finally {
    setSystemTime();
  }
};

const suite = databaseSuite();
const userId = crypto.randomUUID();
const uid = `oauth-verifier-${userId}`;
const coreKid = crypto.randomUUID();
const legacyKid = crypto.randomUUID();
const serviceAccountId = crypto.randomUUID();
let issuer: string;
let corePrivateKey: CryptoKey;
let legacyPrivateKey: CryptoKey;
let jwks: { keys: JWK[] };

const accessToken = (privateKey: CryptoKey, kid: string, authEpoch: unknown, principal = { userId, uid, clientId: "cloud-cli" }) => {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    token_use: "access",
    principal_type: "user",
    auth_epoch: authEpoch,
    uid: principal.uid,
    id: principal.userId,
    client_id: principal.clientId,
    azp: principal.clientId,
    scope: "read",
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(issuer)
    .setSubject(principal.userId)
    .setAudience(["cloud", principal.clientId])
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
    const queries: string[] = [];
    const countedSql = new Proxy(sql, {
      apply(target, thisArg, args) {
        queries.push(Array.isArray(args[0]) ? args[0].join("") : String(args[0]));
        return Reflect.apply(target, thisArg, args);
      },
    });
    const key = createLocalJWKSet(jwks);
    const options = { issuer, key, groupsAdmin: ["admins"], query: countedSql };

    expect(await verifyAccessToken(await accessToken(corePrivateKey, coreKid, 0), "cloud", options)).toMatchObject({
      kind: "user",
      payload: { aud: ["cloud", "cloud-cli"], azp: "cloud-cli", client_id: "cloud-cli", token_use: "access" },
      user: { id: userId },
      scopes: ["read"],
    });
    // One joined principal read plus one uncached authorization-policy read; no signing-key lookup.
    expect(queries).toEqual([expect.stringMatching(/FROM oauth\.clients/), expect.stringMatching(/FROM settings\.entries/)]);
    expect(await verifyAccessToken(await accessToken(legacyPrivateKey, legacyKid, 0), "cloud", options)).toMatchObject({
      kind: "user",
      user: { id: userId },
    });
    expect(queries).toEqual([
      expect.stringMatching(/FROM oauth\.clients/),
      expect.stringMatching(/FROM settings\.entries/),
      expect.stringMatching(/FROM oauth\.clients/),
      expect.stringMatching(/FROM settings\.entries/),
    ]);
    expect(queries.join("\n")).not.toMatch(/(?:auth|oauth)\.signing_keys/);
  });

  test("accepts only user tokens that match the live account epoch", () =>
    withFrozenTime(async () => {
      const id = crypto.randomUUID();
      const principal = { userId: id, uid: `epoch-${id}`, clientId: `epoch-client-${id}` };
      const key = createLocalJWKSet(jwks);
      const options = { issuer, key, groupsAdmin: ["admins"] };
      await sql`INSERT INTO auth.users (id, uid, provider, profile, auth_epoch) VALUES (${id}::uuid, ${principal.uid}, 'local', 'user', 3)`;
      await sql`INSERT INTO oauth.clients (name, client_id, redirect_uris) VALUES (${principal.clientId}, ${principal.clientId}, ARRAY[]::text[])`;
      try {
        for (const authEpoch of [undefined, "3", -1, 0.5, 2, Number.MAX_SAFE_INTEGER + 1]) {
          expect(await verifyAccessToken(await accessToken(corePrivateKey, coreKid, authEpoch, principal), "cloud", options)).toBeNull();
        }
        expect(await verifyAccessToken(await accessToken(corePrivateKey, coreKid, 3, principal), "cloud", options)).toMatchObject({
          kind: "user",
          user: { id },
        });
      } finally {
        await sql`DELETE FROM oauth.clients WHERE client_id = ${principal.clientId}`;
        await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
      }
    }));

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
      expect(await verifyAccessToken(await accessToken(corePrivateKey, coreKid, 0), "cloud", options)).not.toBeNull();
      expect(await verifyAccessToken(await accessToken(corePrivateKey, coreKid, 0), "cloud", options)).not.toBeNull();
      expect(jwksRequests).toBe(1);

      const unknown = await accessToken(corePrivateKey, crypto.randomUUID(), 0);
      expect(await verifyAccessToken(unknown, "cloud", options)).toBeNull();
      expect(jwksRequests).toBe(2);
      expect(await verifyAccessToken(unknown, "cloud", options)).toBeNull();
      expect(jwksRequests).toBe(2);
    } finally {
      server.stop(true);
      clearOAuthVerifierCachesForTest();
    }
  });

  test("loads each client and principal together and rechecks durable account policy", async () => {
    const queries: string[] = [];
    const countedSql = new Proxy(sql, {
      apply(target, thisArg, args) {
        queries.push(Array.isArray(args[0]) ? args[0].join("") : String(args[0]));
        return Reflect.apply(target, thisArg, args);
      },
    });

    const user = await resolveOAuthTokenActor(
      { token_use: "access", client_id: "cloud-cli", id: userId, uid, auth_epoch: 0, scope: "read write" },
      ["admins"],
      countedSql,
    );
    // One joined principal read plus one uncached authorization-policy read; no signing-key lookup.
    expect(queries).toEqual([expect.stringMatching(/FROM oauth\.clients/), expect.stringMatching(/FROM settings\.entries/)]);
    expect(user).toMatchObject({ kind: "user", user: { id: userId, uid }, scopes: ["read", "write"] });

    const service = await resolveOAuthTokenActor(
      { token_use: "access", client_id: "cloud-cli", service_account_id: serviceAccountId, scope: "read" },
      ["admins"],
      countedSql,
    );
    expect(queries).toEqual([
      expect.stringMatching(/FROM oauth\.clients/),
      expect.stringMatching(/FROM settings\.entries/),
      expect.stringMatching(/FROM oauth\.clients/),
      expect.stringMatching(/FROM settings\.entries/),
    ]);
    expect(queries.join("\n")).not.toMatch(/(?:auth|oauth)\.signing_keys/);
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
