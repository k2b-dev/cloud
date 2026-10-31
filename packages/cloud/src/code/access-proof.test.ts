import { beforeAll, expect, test } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey, SignJWT } from "jose";
import {
  CODE_ACCESS_PROOF_TYPE,
  type CodeAccessProofInput,
  signCodeAccessCleanup,
  signCodeAccessProof,
  verifyCodeAccessCleanup,
  verifyCodeAccessProof,
} from "./access-proof";

const now = new Date("2026-10-31T12:00:00Z");
const issuer = "https://cloud.example";
const kid = "11111111-1111-4111-8111-111111111111";
let signer: { kid: string; key: CryptoKey; signUntil: Date };
let key: JWTVerifyGetKey;
const input: CodeAccessProofInput = {
  codeId: "code-1",
  versionId: "version-1",
  activationId: "22222222-2222-4222-8222-222222222222",
  activatingPerson: "33333333-3333-4333-8333-333333333333",
  principal: "44444444-4444-4444-8444-444444444444",
  grantId: "55555555-5555-4555-8555-555555555555",
  target: { type: "inventory.item", id: "item-1" },
  operations: ["inventory.item.update", "inventory.item.read"],
};
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  signer = { kid, key: pair.privateKey, signUntil: new Date(now.getTime() + 60_000) };
  key = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid, alg: "RS256", use: "sig" }] });
});
const expected = { appId: "inventory", target: input.target, operations: input.operations, activatingPerson: input.activatingPerson };
const options = () => ({ issuer, key, now });

test("Core proof is bound to person, account, code, version, activation, grant, target and operations", async () => {
  const token = await signCodeAccessProof("inventory", input, { issuer, signer, now });
  expect(await verifyCodeAccessProof(token, { ...expected, operations: [...input.operations].reverse() }, options())).toMatchObject(input);
  for (const binding of [
    { appId: "other" },
    { activatingPerson: kid },
    { target: { ...input.target, id: "item-2" } },
    { target: { ...input.target, type: "inventory.collection" } },
    { operations: ["inventory.item.read"] },
  ])
    expect(await verifyCodeAccessProof(token, { ...expected, ...binding }, options())).toBeNull();
  expect(await verifyCodeAccessProof(`${token.slice(0, -8)}aaaaaaaa`, expected, options())).toBeNull();
  expect(await verifyCodeAccessProof(token, expected, { ...options(), now: new Date(now.getTime() + 30_000) })).toBeNull();
  expect(await verifyCodeAccessProof(token, expected, { ...options(), now: new Date(now.getTime() - 1000) })).toBeNull();
  expect(await verifyCodeAccessProof("x".repeat(64 * 1024 + 1), expected, options())).toBeNull();
});
test("cleanup proof is account scoped, target app bound and never an activation proof", async () => {
  const token = await signCodeAccessCleanup("inventory", input.principal, { issuer, signer, now });
  expect(await verifyCodeAccessCleanup(token, "inventory", options())).toMatchObject({ principal: input.principal });
  expect(await verifyCodeAccessCleanup(token, "other", options())).toBeNull();
  expect(await verifyCodeAccessProof(token, expected, options())).toBeNull();
  expect(
    await verifyCodeAccessCleanup(await signCodeAccessProof("inventory", input, { issuer, signer, now }), "inventory", options()),
  ).toBeNull();
});
test("wrong signer, token use, header, lifetime and malformed bindings fail closed", async () => {
  const other = await generateKeyPair("RS256");
  expect(
    await verifyCodeAccessProof(
      await signCodeAccessProof("inventory", input, { issuer, signer: { ...signer, key: other.privateKey }, now }),
      expected,
      options(),
    ),
  ).toBeNull();
  const seconds = now.getTime() / 1000;
  const claims = {
    ...input,
    ver: 1,
    iss: issuer,
    aud: "app:inventory",
    token_use: "code_access",
    iat: seconds,
    nbf: seconds,
    exp: seconds + 30,
  };
  for (const change of [
    { exp: seconds + 31 },
    { token_use: "session" },
    { ver: 2 },
    { operations: [...input.operations, input.operations[0]] },
    { extra: true },
  ]) {
    const token = await new SignJWT({ ...claims, ...change })
      .setProtectedHeader({ alg: "RS256", typ: CODE_ACCESS_PROOF_TYPE, kid })
      .sign(signer.key);
    expect(await verifyCodeAccessProof(token, expected, options())).toBeNull();
  }
  await expect(signCodeAccessProof("inventory", input, { issuer, signer: { ...signer, signUntil: now }, now })).rejects.toThrow("expires");
});
