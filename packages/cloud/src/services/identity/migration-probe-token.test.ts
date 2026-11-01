import { expect, test } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { signMigrationProbe, verifyAppAccessProbe, verifyInvocationToken, verifyMigrationProbe } from "./invocation-token";

const now = new Date("2030-01-02T00:00:00.000Z");
test("migration instructions are target-bound, short-lived and cannot authorize person or app-access operations", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const issuer = "https://core.test";
  const key = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "44444444-4444-4444-8444-444444444444", alg: "RS256" }] });
  const token = await signMigrationProbe({
    appId: "mail",
    keyId: "22222222-2222-4222-8222-222222222222",
    oauth: true,
    nonce: "33333333-3333-4333-8333-333333333333",
    issuer,
    now,
    signer: { key: privateKey, kid: "44444444-4444-4444-8444-444444444444", signUntil: new Date("2030-01-02T00:01:00.000Z") },
  });
  expect(await verifyMigrationProbe(token, "mail", { issuer, key, now })).toMatchObject({ oauth: true, token_use: "app_migration_probe" });
  expect(await verifyMigrationProbe(token, "other", { issuer, key, now })).toBeNull();
  expect(await verifyMigrationProbe(token, "mail", { issuer, key, now: new Date("2030-01-02T00:01:00.000Z") })).toBeNull();
  expect(await verifyAppAccessProbe(token, "mail", { issuer, key, now })).toBeNull();
  expect(
    await verifyInvocationToken(token, { targetAppId: "mail", operation: "example", schemaHash: null }, { issuer, key, now }),
  ).toBeNull();
});
