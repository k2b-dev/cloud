import { beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey, SignJWT } from "jose";
import type { User } from "../../contracts/shared";
import { type CloudInvocationClaims, verifyInvocationToken } from "../../services/identity/invocation-token";
import type { AuthContext } from "./auth";
import { requireInvocation } from "./invocation";

const user: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "reviewer",
  provider: "local",
  profile: "user",
  roles: ["user", "local", "local/user"],
  givenname: "Review",
  sn: "User",
  displayName: "Review User",
  mail: null,
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
};

const claims: CloudInvocationClaims = {
  iss: "https://cloud.example",
  aud: "app:demo",
  token_use: "invocation",
  sub: user.id,
  principal_type: "user",
  access_subject_type: "user",
  access_subject_id: user.id,
  act: { sub: "app:core" },
  credential_kind: "oauth",
  scopes: ["read"],
  op: "capability.query:read",
  schema_hash: "a".repeat(64),
  ver: 1,
  jti: "22222222-2222-4222-8222-222222222222",
  iat: 100,
  nbf: 100,
  exp: 130,
};

const expected = () => ({ targetAppId: "demo", operation: claims.op, schemaHash: claims.schema_hash });
const invocationCandidate = `${Buffer.from(
  JSON.stringify({ alg: "RS256", kid: "33333333-3333-4333-8333-333333333333", typ: "cloud-invocation+jwt" }),
).toString("base64url")}.e30.signature`;

const kid = "33333333-3333-4333-8333-333333333333";
let signingKey: CryptoKey;
let wrongSigningKey: CryptoKey;
let verificationKey: JWTVerifyGetKey;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  signingKey = pair.privateKey;
  wrongSigningKey = (await generateKeyPair("RS256")).privateKey;
  verificationKey = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid, alg: "RS256", use: "sig" }] });
});
const signedToken = (payload: CloudInvocationClaims, key = signingKey) =>
  new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid, typ: "cloud-invocation+jwt" }).sign(key);
const realVerify: typeof verifyInvocationToken = (token, expectation, options) =>
  verifyInvocationToken(token, expectation, {
    ...options,
    issuer: claims.iss,
    key: verificationKey,
    now: new Date(110_000),
  });

describe("invocation middleware", () => {
  test("reports a signed schema mismatch only after live authority resolves", async () => {
    for (const targetHash of ["b".repeat(64), null]) {
      let resolved = 0;
      let executed = false;
      const app = new Hono<AuthContext>()
        .use(
          requireInvocation(() => ({ ...expected(), schemaHash: targetHash }), {
            verify: realVerify,
            resolve: async () => {
              resolved += 1;
              return {
                actor: { kind: "user", user },
                accessSubject: { type: "user", userId: user.id },
                credentialKind: "invocation",
                scopes: ["read"],
              };
            },
          }),
        )
        .get("/", (c) => {
          executed = true;
          return c.text("ok");
        });
      const response = await app.request("/", { headers: { authorization: `Bearer ${await signedToken(claims)}` } });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "SCHEMA_MISMATCH" });
      expect(resolved).toBe(1);
      expect(executed).toBe(false);
    }
  });

  test("keeps bad signature, audience, operation and revoked authority unauthorized even with a schema mismatch", async () => {
    const tokens = [
      await signedToken(claims, wrongSigningKey),
      await signedToken({ ...claims, aud: "app:other" }),
      await signedToken({ ...claims, op: "capability.query:other" }),
    ];
    let resolved = 0;
    const app = new Hono<AuthContext>()
      .use(
        requireInvocation(() => ({ ...expected(), schemaHash: "b".repeat(64) }), {
          verify: realVerify,
          resolve: async () => {
            resolved += 1;
            return null;
          },
        }),
      )
      .get("/", (c) => c.text("unexpected"));
    for (const token of tokens) {
      const response = await app.request("/", { headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
    }
    expect(resolved).toBe(0);
    const revoked = await app.request("/", { headers: { authorization: `Bearer ${await signedToken(claims)}` } });
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toMatchObject({ code: "UNAUTHORIZED" });
    expect(resolved).toBe(1);
  });

  test("installs the current resolved authority and source OAuth scopes", async () => {
    const app = new Hono<AuthContext>()
      .use(
        requireInvocation(expected, {
          verify: async () => claims,
          resolve: async () => ({
            actor: { kind: "user", user },
            accessSubject: { type: "user", userId: user.id },
            credentialKind: "invocation",
            scopes: ["read"],
          }),
        }),
      )
      .get("/", (c) => c.json({ kind: c.get("credentialKind"), scopes: c.get("oauthScopes"), userId: c.get("user").id }));

    const response = await app.request("/", { headers: { authorization: `Bearer ${invocationCandidate}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "invocation", scopes: ["read"], userId: user.id });
  });

  test("rejects invalid signatures and mismatched invocation schemas", async () => {
    const app = new Hono<AuthContext>()
      .use(
        requireInvocation(() => ({ ...expected(), schemaHash: "b".repeat(64) }), {
          verify: realVerify,
          resolve: async () => ({
            actor: { kind: "user", user },
            accessSubject: { type: "user", userId: user.id },
            credentialKind: "invocation",
            scopes: ["read"],
          }),
        }),
      )
      .get("/", (c) => c.text("unexpected"));
    expect((await app.request("/", { headers: { authorization: `Bearer ${await signedToken(claims, wrongSigningKey)}` } })).status).toBe(
      401,
    );
    expect((await app.request("/", { headers: { authorization: `Bearer ${await signedToken(claims)}` } })).status).toBe(409);
  });

  test("strict mode rejects non-invocation credentials before verification", async () => {
    let verified = false;
    const app = new Hono<AuthContext>()
      .use(
        requireInvocation(expected, {
          verify: async () => {
            verified = true;
            return claims;
          },
        }),
      )
      .get("/", (c) => c.text("ok"));

    const credentials: HeadersInit[] = [
      { authorization: "Bearer cld_source" },
      { authorization: "Bearer user:opaque" },
      { cookie: "session_token=user:opaque" },
      {},
    ];
    for (const headers of credentials) {
      expect((await app.request("/", { headers })).status).toBe(401);
    }
    expect(verified).toBeFalse();
  });
});
