import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  clearIdentityKeyCachesForTest,
  getIdentitySigningKeyStatus,
  initializeIdentityAuthority,
  listIdentityJwks,
  prepareIdentitySigner,
  revokeIdentitySigningKey,
  runIdentityKeyMaintenance,
  withActiveIdentitySigner,
} from "@valentinkolb/cloud/services/identity";
import { readIdentityKeyEncryptionConfig } from "@valentinkolb/cloud/services/identity/key-config";
import { sql } from "bun";
import { migrate } from "./migrate/core/auth";

const suite = process.env.CLOUD_IDENTITY_KEYRING_INTEGRATION === "1" ? describe : describe.skip;
const keyA = "10".repeat(32);
const keyB = "20".repeat(32);

suite("Core identity key ring", () => {
  const original = {
    appId: process.env.APP_ID,
    current: process.env.CLOUD_IDENTITY_KEY_ENCRYPTION_KEY,
    previous: process.env.CLOUD_IDENTITY_PREVIOUS_KEY,
    next: process.env.CLOUD_IDENTITY_NEXT_KEY,
  };

  beforeAll(async () => {
    process.env.APP_ID = "core";
    process.env.CLOUD_IDENTITY_KEY_ENCRYPTION_KEY = keyA;
    delete process.env.CLOUD_IDENTITY_PREVIOUS_KEY;
    delete process.env.CLOUD_IDENTITY_NEXT_KEY;
    await migrate();
  }, 30_000);

  afterAll(() => {
    for (const [name, value] of [
      ["APP_ID", original.appId],
      ["CLOUD_IDENTITY_KEY_ENCRYPTION_KEY", original.current],
      ["CLOUD_IDENTITY_PREVIOUS_KEY", original.previous],
      ["CLOUD_IDENTITY_NEXT_KEY", original.next],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    clearIdentityKeyCachesForTest();
  });

  test("keeps the mandate workload index stable across idempotent migrations", async () => {
    const readIndex = async () => {
      const [index] = await sql<
        Array<{
          oid: number;
          definition: string;
        }>
      >`
        SELECT
          index_state.indexrelid::oid::int AS oid,
          pg_get_indexdef(index_state.indexrelid) AS definition
        FROM pg_index AS index_state
        WHERE index_state.indexrelid = 'auth.uq_mandates_confirmed_owner_workload'::regclass
      `;
      return index;
    };

    const before = await readIndex();
    await migrate();
    const after = await readIndex();

    expect(after).toEqual(before);
    expect(after?.definition).toContain("confirmed_at IS NOT NULL");
  }, 30_000);

  test("invalidates a replica-stale signer and retries once with its replacement", async () => {
    clearIdentityKeyCachesForTest();
    const stale = await prepareIdentitySigner("oauth");
    await sql`
      UPDATE auth.signing_keys
      SET state = 'revoked', revoked_at = now(), revoke_reason = 'remote replica integration test'
      WHERE kid = ${stale.kid}
    `;

    const replacementKid = await withActiveIdentitySigner("oauth", async (signer) => signer.kid);

    expect(replacementKid).not.toBe(stale.kid);
    const [replacement] = await sql<Array<{ state: string }>>`
      SELECT state FROM auth.signing_keys WHERE kid = ${replacementKid}
    `;
    expect(replacement?.state).toBe("active");
  });

  test("fails closed after exactly one stale-signer retry", async () => {
    let checks = 0;
    let callbacks = 0;
    const neverActive = ((_strings: TemplateStringsArray, ..._values: unknown[]) => {
      checks += 1;
      return Promise.resolve([]);
    }) as unknown as typeof sql;

    await expect(
      withActiveIdentitySigner(
        "oauth",
        async () => {
          callbacks += 1;
          return "unexpected";
        },
        { db: neverActive },
      ),
    ).rejects.toThrow("No active oauth identity signer is available");
    expect(checks).toBe(2);
    expect(callbacks).toBe(0);
  });

  test("serializes emergency revocation behind in-flight issuance", async () => {
    clearIdentityKeyCachesForTest();
    const active = await prepareIdentitySigner("oauth");
    let release!: () => void;
    let entered!: () => void;
    const callbackEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const callbackRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const issuance = withActiveIdentitySigner("oauth", async (signer) => {
      entered();
      await callbackRelease;
      return signer.kid;
    });
    await callbackEntered;

    let revocationSettled = false;
    const revocation = revokeIdentitySigningKey({ kid: active.kid, reason: "FOR SHARE integration test" }).then((revoked) => {
      revocationSettled = true;
      return revoked;
    });
    await Bun.sleep(25);
    expect(revocationSettled).toBeFalse();

    release();
    expect(await issuance).toBe(active.kid);
    expect(await revocation).toBeTrue();
    expect(revocationSettled).toBeTrue();
    const replacements = (await getIdentitySigningKeyStatus()).filter((key) => key.purpose === "oauth" && key.state === "active");
    expect(replacements).toHaveLength(1);
    expect(replacements[0]!.kid).not.toBe(active.kid);
  });

  test("rotates concurrently, fails closed, revokes, cleans up, and rolling-rewraps", async () => {
    await Promise.all(Array.from({ length: 8 }, () => initializeIdentityAuthority()));
    let status = await getIdentitySigningKeyStatus();
    for (const purpose of ["session", "invocation", "oauth"] as const) {
      expect(status.filter((key) => key.purpose === purpose && key.state === "active")).toHaveLength(1);
      expect(status.filter((key) => key.purpose === purpose && key.state === "pending").length).toBeLessThanOrEqual(1);
    }

    const [invocation] = await sql<Array<{ kid: string }>>`
      UPDATE auth.signing_keys
      SET created_at = now() - INTERVAL '31 days'
      WHERE purpose = 'invocation' AND state = 'active'
      RETURNING kid
    `;
    expect(invocation).toBeDefined();
    await sql`
      UPDATE auth.signing_keys
      SET created_at = now() - INTERVAL '31 days'
      WHERE purpose = 'oauth' AND state = 'active'
    `;
    await Promise.all(Array.from({ length: 6 }, () => runIdentityKeyMaintenance()));
    status = await getIdentitySigningKeyStatus();
    expect(status.filter((key) => key.purpose === "invocation" && key.state === "pending")).toHaveLength(1);
    expect(status.filter((key) => key.purpose === "oauth" && key.state === "pending")).toHaveLength(1);

    await sql`UPDATE auth.signing_keys SET activate_at = now() - INTERVAL '1 second' WHERE purpose = 'invocation' AND state = 'pending'`;
    await Promise.all(Array.from({ length: 6 }, () => runIdentityKeyMaintenance()));
    status = await getIdentitySigningKeyStatus();
    expect(status.filter((key) => key.purpose === "invocation" && key.state === "active")).toHaveLength(1);
    expect(status.find((key) => key.kid === invocation!.kid)?.state).toBe("retired");
    expect((await listIdentityJwks()).keys.some((key) => key.kid === invocation!.kid)).toBe(true);
    expect((await listIdentityJwks("invocation")).keys.some((key) => key.kid === invocation!.kid)).toBe(true);
    expect((await listIdentityJwks("session")).keys.some((key) => key.kid === invocation!.kid)).toBe(false);

    const activeInvocation = status.find((key) => key.purpose === "invocation" && key.state === "active")!;
    const [backup] = await sql<Array<{ encrypted_private_jwk: string; public_jwk: unknown }>>`
      SELECT encrypted_private_jwk, public_jwk FROM auth.signing_keys WHERE kid = ${activeInvocation.kid}
    `;
    expect(backup).toBeDefined();

    process.env.CLOUD_IDENTITY_KEY_ENCRYPTION_KEY = keyB;
    clearIdentityKeyCachesForTest();
    expect(prepareIdentitySigner("invocation")).rejects.toThrow("No configured KEK");
    process.env.CLOUD_IDENTITY_KEY_ENCRYPTION_KEY = keyA;

    await sql`UPDATE auth.signing_keys SET encrypted_private_jwk = 'corrupt' WHERE kid = ${activeInvocation.kid}`;
    clearIdentityKeyCachesForTest();
    expect(prepareIdentitySigner("invocation")).rejects.toThrow();
    await sql`UPDATE auth.signing_keys SET encrypted_private_jwk = ${backup!.encrypted_private_jwk} WHERE kid = ${activeInvocation.kid}`;

    const [other] = await sql<Array<{ public_jwk: unknown }>>`
      SELECT public_jwk FROM auth.signing_keys WHERE purpose = 'session' AND state = 'active'
    `;
    const mismatchedPublicJwk = typeof other!.public_jwk === "string" ? other!.public_jwk : JSON.stringify(other!.public_jwk);
    await sql`UPDATE auth.signing_keys SET public_jwk = ${mismatchedPublicJwk}::jsonb WHERE kid = ${activeInvocation.kid}`;
    clearIdentityKeyCachesForTest();
    expect(prepareIdentitySigner("invocation")).rejects.toThrow("does not match");
    const originalPublicJwk = typeof backup!.public_jwk === "string" ? backup!.public_jwk : JSON.stringify(backup!.public_jwk);
    await sql`UPDATE auth.signing_keys SET public_jwk = ${originalPublicJwk}::jsonb WHERE kid = ${activeInvocation.kid}`;

    process.env.CLOUD_IDENTITY_NEXT_KEY = keyB;
    clearIdentityKeyCachesForTest();
    await initializeIdentityAuthority();
    const oldEncryptionId = (await readIdentityKeyEncryptionConfig()).current.id;
    expect((await getIdentitySigningKeyStatus()).every((key) => key.encryptionKeyId === oldEncryptionId)).toBe(true);

    process.env.CLOUD_IDENTITY_KEY_ENCRYPTION_KEY = keyB;
    process.env.CLOUD_IDENTITY_PREVIOUS_KEY = keyA;
    delete process.env.CLOUD_IDENTITY_NEXT_KEY;
    clearIdentityKeyCachesForTest();
    await initializeIdentityAuthority();
    const newEncryptionId = (await readIdentityKeyEncryptionConfig()).current.id;
    expect((await getIdentitySigningKeyStatus()).every((key) => key.encryptionKeyId === newEncryptionId)).toBe(true);

    delete process.env.CLOUD_IDENTITY_PREVIOUS_KEY;
    clearIdentityKeyCachesForTest();
    await initializeIdentityAuthority();

    const activeAfterRewrap = (await getIdentitySigningKeyStatus()).find((key) => key.purpose === "invocation" && key.state === "active")!;
    expect(await revokeIdentitySigningKey({ kid: activeAfterRewrap.kid, reason: "integration test" })).toBe(true);
    expect((await listIdentityJwks()).keys.some((key) => key.kid === activeAfterRewrap.kid)).toBe(false);
    expect((await getIdentitySigningKeyStatus()).filter((key) => key.purpose === "invocation" && key.state === "active")).toHaveLength(1);

    await sql`
      UPDATE auth.signing_keys
      SET activate_at = LEAST(activate_at, now() - INTERVAL '3 seconds'),
          sign_until = now() - INTERVAL '2 seconds',
          verify_until = now() - INTERVAL '1 second'
      WHERE kid = ${invocation!.kid} AND state = 'retired'
    `;
    await runIdentityKeyMaintenance();
    expect((await getIdentitySigningKeyStatus()).some((key) => key.kid === invocation!.kid)).toBe(false);
  }, 30_000);
});
