import { beforeAll, expect, test } from "bun:test";
import { createLocalJWKSet, decodeJwt, exportJWK, generateKeyPair, type JWTVerifyGetKey, SignJWT } from "jose";
import { CODE_RUN_TOKEN_TYPE, type CodeRunTokenInput, signCodeRunToken, verifyCodeRunToken } from "./run-token";

const now = new Date("2026-11-01T00:00:00Z");
const issuer = "https://cloud.example";
const kid = "11111111-1111-4111-8111-111111111111";
let signer: { kid: string; key: CryptoKey; signUntil: Date };
let key: JWTVerifyGetKey;
const input: CodeRunTokenInput = {
  codeId: "c_fixture",
  versionId: kid,
  entrypoint: "weekly",
  runId: "22222222-2222-4222-8222-222222222222",
  generation: 2,
  mandateId: "33333333-3333-4333-8333-333333333333",
  mandateRevision: 4,
  bundleHash: "a".repeat(64),
};
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  signer = { kid, key: pair.privateKey, signUntil: new Date(now.getTime() + 600_000) };
  key = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid, alg: "RS256", use: "sig" }] });
});
const sign = () => signCodeRunToken(input, { issuer, signer, now, deadlineAt: now.getTime() + 300_000 });
const verify = (token: string, at = now) => verifyCodeRunToken(token, { issuer, key, now: at });
test("Core run token binds every attempt coordinate, remains stateless and ends at the original deadline", async () => {
  const token = await sign();
  expect(await verify(token)).toMatchObject(input);
  expect(await verify(token)).toMatchObject(input);
  expect(await verify(token, new Date(now.getTime() + 299_000))).toMatchObject(input);
  expect(await verify(token, new Date(now.getTime() + 300_000))).toBeNull();
  expect(await verify(token, new Date(now.getTime() - 1))).toBeNull();
  expect(await verify(`${token.slice(0, -10)}aaaaaaaaaa`)).toBeNull();
  expect(await verify("x".repeat(4097))).toBeNull();
});
test("wrong signer, audience, type, use, future issuance, lifetime and extra claims fail closed", async () => {
  const claims = decodeJwt(await sign());
  for (const change of [
    { aud: "app:runner" },
    { token_use: "invocation" },
    { exp: Number(claims.iat) + 301 },
    { nbf: Number(claims.iat) - 1 },
    { iat: Number(claims.iat) + 1 },
    { extra: true },
    { generation: 0 },
  ]) {
    const token = await new SignJWT({ ...claims, ...change })
      .setProtectedHeader({ alg: "RS256", typ: CODE_RUN_TOKEN_TYPE, kid })
      .sign(signer.key);
    expect(await verify(token)).toBeNull();
  }
  const pair = await generateKeyPair("RS256");
  expect(
    await verify(await new SignJWT(claims).setProtectedHeader({ alg: "RS256", typ: CODE_RUN_TOKEN_TYPE, kid }).sign(pair.privateKey)),
  ).toBeNull();
  expect(
    await verify(await new SignJWT(claims).setProtectedHeader({ alg: "RS256", typ: "cloud-invocation+jwt", kid }).sign(signer.key)),
  ).toBeNull();
});
test("issuance refuses deadlines outside the admin ceiling or beyond the signer's lifetime", async () => {
  for (const deadlineAt of [now.getTime(), now.getTime() + 301_000, NaN])
    await expect(signCodeRunToken(input, { issuer, signer, now, deadlineAt })).rejects.toThrow();
  await expect(
    signCodeRunToken(input, { issuer, signer: { ...signer, signUntil: now }, now, deadlineAt: now.getTime() + 60_000 }),
  ).rejects.toThrow("expires");
});
