import { beforeAll, expect, test } from "bun:test";
import { createLocalJWKSet, decodeJwt, exportJWK, generateKeyPair, SignJWT } from "jose";
import { CODE_OWNER_READ_TTL_SECONDS, CODE_OWNER_READ_TYPE, signCodeOwnerRead, verifyCodeOwnerRead } from "./owner-proof";

const now = new Date("2026-11-01T12:00:00Z");
const issuer = "https://cloud.example.test";
const principal = "11111111-1111-4111-8111-111111111111";
const kid = "22222222-2222-4222-8222-222222222222";
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let key: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  pair = await generateKeyPair("RS256", { extractable: true });
  key = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid, alg: "RS256", use: "sig" }] });
});
const sign = () =>
  signCodeOwnerRead("inventory", principal, {
    issuer,
    now,
    signer: { kid, key: pair.privateKey, signUntil: new Date(now.getTime() + 3600_000) },
  });
test("owner projection authority has one exact account, audience, purpose and short lifetime", async () => {
  const token = await sign();
  expect(await verifyCodeOwnerRead(token, "inventory", { issuer, key, now })).toMatchObject({
    principal,
    token_use: "code_owner_read",
    aud: "app:inventory",
  });
  expect(await verifyCodeOwnerRead(token, "other", { issuer, key, now })).toBeNull();
  expect(await verifyCodeOwnerRead(token, "inventory", { issuer: "https://other.example", key, now })).toBeNull();
  expect(await verifyCodeOwnerRead(token, "inventory", { issuer, key, now: new Date(now.getTime() + 120_000) })).toBeNull();
  expect(decodeJwt(token).exp! - decodeJwt(token).iat!).toBe(CODE_OWNER_READ_TTL_SECONDS);
});
test("grant claims, wrong purpose, extra headers and changed lifetimes fail closed", async () => {
  const claims = decodeJwt(await sign());
  for (const change of [{ token_use: "code_access_list" }, { grantId: principal }, { exp: claims.exp! + 1 }]) {
    const token = await new SignJWT({ ...claims, ...change })
      .setProtectedHeader({ alg: "RS256", typ: CODE_OWNER_READ_TYPE, kid })
      .sign(pair.privateKey);
    expect(await verifyCodeOwnerRead(token, "inventory", { issuer, key, now })).toBeNull();
  }
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", typ: CODE_OWNER_READ_TYPE, kid, jku: issuer })
    .sign(pair.privateKey);
  expect(await verifyCodeOwnerRead(token, "inventory", { issuer, key, now })).toBeNull();
});
