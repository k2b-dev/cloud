import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK, type JWTVerifyGetKey } from "jose";
import {
  CLOUD_IDENTITY_ALGORITHM,
  CLOUD_SESSION_AUDIENCE,
  CLOUD_SESSION_TOKEN_TYPE,
  IDENTITY_MAX_COMPACT_TOKEN_BYTES,
} from "./constants";
import { readIdentityKeyEncryptionConfig } from "./key-config";
import { clearSessionVerifierCachesForTest, verifySessionToken } from "./session-token";

const issuer = "https://cloud.example";
const userId = "7bd9706e-6c70-4dd5-946f-0caac02bfc2a";
const sid = "1e9e8ee1-8295-4820-b46f-7655fea86c9f";
const kid = "bd5e8d90-d2f1-48cb-9c5b-1b657165b8c5";
const now = new Date("2026-09-01T10:00:00.000Z");
let privateKey: CryptoKey;
let keySet: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair(CLOUD_IDENTITY_ALGORITHM, { extractable: true });
  privateKey = pair.privateKey;
  const publicKey: JWK = { ...(await exportJWK(pair.publicKey)), alg: CLOUD_IDENTITY_ALGORITHM, kid, use: "sig" };
  keySet = createLocalJWKSet({ keys: [publicKey] });
});

const token = (params: {
  typ?: string;
  aud?: string;
  tokenUse?: string;
  issuedAt?: number;
  expiresAt?: number;
  extra?: Record<string, unknown>;
} = {}) => {
  const issuedAt = params.issuedAt ?? Math.floor(now.getTime() / 1_000);
  return new SignJWT({
    token_use: params.tokenUse ?? "session",
    sid,
    auth_epoch: 3,
    ...(params.extra ?? {}),
  })
    .setProtectedHeader({ alg: CLOUD_IDENTITY_ALGORITHM, typ: params.typ ?? CLOUD_SESSION_TOKEN_TYPE, kid })
    .setIssuer(issuer)
    .setAudience(params.aud ?? CLOUD_SESSION_AUDIENCE)
    .setSubject(userId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(params.expiresAt ?? issuedAt + 3_600)
    .sign(privateKey);
};

describe("Cloud session JWT", () => {
  test("accepts the minimal strict session contract", async () => {
    const value = await verifySessionToken(await token(), { issuer, key: keySet, now });
    expect(value).toMatchObject({ sub: userId, sid, auth_epoch: 3, aud: "cloud", token_use: "session" });
  });

  test("rejects token confusion and unknown claims", async () => {
    expect(await verifySessionToken(await token({ typ: "at+jwt" }), { issuer, key: keySet, now })).toBeNull();
    expect(await verifySessionToken(await token({ aud: "app:mail" }), { issuer, key: keySet, now })).toBeNull();
    expect(await verifySessionToken(await token({ tokenUse: "access" }), { issuer, key: keySet, now })).toBeNull();
    expect(await verifySessionToken(await token({ extra: { roles: ["admin"] } }), { issuer, key: keySet, now })).toBeNull();
  });

  test("enforces expiry, not-before tolerance, and the compact size bound", async () => {
    const issuedAt = Math.floor(now.getTime() / 1_000);
    expect(await verifySessionToken(await token({ expiresAt: issuedAt - 31 }), { issuer, key: keySet, now })).toBeNull();
    const future = await new SignJWT({ token_use: "session", sid, auth_epoch: 3 })
      .setProtectedHeader({ alg: CLOUD_IDENTITY_ALGORITHM, typ: CLOUD_SESSION_TOKEN_TYPE, kid })
      .setIssuer(issuer)
      .setAudience(CLOUD_SESSION_AUDIENCE)
      .setSubject(userId)
      .setIssuedAt(issuedAt)
      .setNotBefore(issuedAt + 31)
      .setExpirationTime(issuedAt + 3_600)
      .sign(privateKey);
    expect(await verifySessionToken(future, { issuer, key: keySet, now })).toBeNull();
    expect(await verifySessionToken("x".repeat(IDENTITY_MAX_COMPACT_TOKEN_BYTES + 1), { issuer, key: keySet, now })).toBeNull();
  });

  test("forces one bounded JWKS refresh for an unknown kid", async () => {
    const second = await generateKeyPair(CLOUD_IDENTITY_ALGORITHM, { extractable: true });
    const secondKid = "3a329316-6e0c-4fe0-8f1c-4d901a2f11eb";
    // Use a dedicated first pair so the remote cache starts from a known JWKS.
    const first = await generateKeyPair(CLOUD_IDENTITY_ALGORITHM, { extractable: true });
    const firstKid = "cf6dfae0-6941-40a3-ab72-6e3bf78055ca";
    const activeKeys: JWK[] = [{ ...(await exportJWK(first.publicKey)), alg: CLOUD_IDENTITY_ALGORITHM, kid: firstKid, use: "sig" }];
    let fetches = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        fetches += 1;
        return Response.json({ keys: activeKeys });
      },
    });
    const jwksUrl = new URL(`http://127.0.0.1:${server.port}/jwks`);
    const signRemote = (signingKey: CryptoKey, signingKid: string) =>
      new SignJWT({ token_use: "session", sid, auth_epoch: 3 })
        .setProtectedHeader({ alg: CLOUD_IDENTITY_ALGORITHM, typ: CLOUD_SESSION_TOKEN_TYPE, kid: signingKid })
        .setIssuer(issuer)
        .setAudience(CLOUD_SESSION_AUDIENCE)
        .setSubject(userId)
        .setIssuedAt(Math.floor(now.getTime() / 1_000))
        .setExpirationTime(Math.floor(now.getTime() / 1_000) + 3_600)
        .sign(signingKey);

    try {
      clearSessionVerifierCachesForTest();
      expect(await verifySessionToken(await signRemote(first.privateKey, firstKid), { issuer, jwksUrl, now })).not.toBeNull();
      expect(fetches).toBe(1);

      activeKeys[0] = { ...(await exportJWK(second.publicKey)), alg: CLOUD_IDENTITY_ALGORITHM, kid: secondKid, use: "sig" };
      expect(await verifySessionToken(await signRemote(second.privateKey, secondKid), { issuer, jwksUrl, now })).not.toBeNull();
      expect(fetches).toBe(2);

      const third = await generateKeyPair(CLOUD_IDENTITY_ALGORITHM);
      expect(
        await verifySessionToken(await signRemote(third.privateKey, "fdd6f8c2-c7c7-44b6-9c50-282405c62dbe"), { issuer, jwksUrl, now }),
      ).toBeNull();
      expect(fetches).toBe(2);
    } finally {
      server.stop(true);
      clearSessionVerifierCachesForTest();
    }
  });
});

describe("Core identity KEK configuration", () => {
  const originalAppId = process.env.APP_ID;
  const originalCurrent = process.env.CLOUD_IDENTITY_KEY_ENCRYPTION_KEY;
  const originalPrevious = process.env.CLOUD_IDENTITY_PREVIOUS_KEY;
  const originalNext = process.env.CLOUD_IDENTITY_NEXT_KEY;

  afterAll(() => {
    if (originalAppId === undefined) delete process.env.APP_ID;
    else process.env.APP_ID = originalAppId;
    if (originalCurrent === undefined) delete process.env.CLOUD_IDENTITY_KEY_ENCRYPTION_KEY;
    else process.env.CLOUD_IDENTITY_KEY_ENCRYPTION_KEY = originalCurrent;
    if (originalPrevious === undefined) delete process.env.CLOUD_IDENTITY_PREVIOUS_KEY;
    else process.env.CLOUD_IDENTITY_PREVIOUS_KEY = originalPrevious;
    if (originalNext === undefined) delete process.env.CLOUD_IDENTITY_NEXT_KEY;
    else process.env.CLOUD_IDENTITY_NEXT_KEY = originalNext;
  });

  test("is Core-only and requires a distinct 32-byte hexadecimal key", async () => {
    process.env.APP_ID = "mail";
    process.env.CLOUD_IDENTITY_KEY_ENCRYPTION_KEY = "00".repeat(32);
    expect(readIdentityKeyEncryptionConfig()).rejects.toThrow("Core application");

    process.env.APP_ID = "core";
    process.env.CLOUD_IDENTITY_KEY_ENCRYPTION_KEY = "short";
    expect(readIdentityKeyEncryptionConfig()).rejects.toThrow("64 hexadecimal");

    process.env.CLOUD_IDENTITY_KEY_ENCRYPTION_KEY = "01".repeat(32);
    process.env.CLOUD_IDENTITY_PREVIOUS_KEY = "01".repeat(32);
    expect(readIdentityKeyEncryptionConfig()).rejects.toThrow("must be distinct");

    process.env.CLOUD_IDENTITY_PREVIOUS_KEY = "02".repeat(32);
    const parsed = await readIdentityKeyEncryptionConfig();
    expect(parsed.current.key).toBe("01".repeat(32));
    expect(parsed.previous?.key).toBe("02".repeat(32));
    expect(parsed.current.id).not.toBe(parsed.previous?.id);

    delete process.env.CLOUD_IDENTITY_PREVIOUS_KEY;
    process.env.CLOUD_IDENTITY_NEXT_KEY = "03".repeat(32);
    expect((await readIdentityKeyEncryptionConfig()).next?.key).toBe("03".repeat(32));

    process.env.CLOUD_IDENTITY_PREVIOUS_KEY = "02".repeat(32);
    expect(readIdentityKeyEncryptionConfig()).rejects.toThrow("either CLOUD_IDENTITY_PREVIOUS_KEY or CLOUD_IDENTITY_NEXT_KEY");
  });
});
