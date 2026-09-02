import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, type JWTVerifyGetKey, SignJWT } from "jose";
import {
  CLOUD_IDENTITY_ALGORITHM,
  CLOUD_INVOCATION_PROTOCOL_VERSION,
  CLOUD_INVOCATION_TOKEN_TYPE,
  IDENTITY_MAX_COMPACT_TOKEN_BYTES,
} from "./constants";
import {
  type CloudInvocationClaims,
  isInvocationJwtCandidate,
  normalizeInvocationRequestId,
  signInvocationToken,
  verifyInvocationToken,
} from "./invocation-token";
import * as runtimeConfig from "./runtime-config";

const issuer = "https://cloud.example";
const targetAppId = "mail";
const callingAppId = "assistant";
const operation = "capability.query:message.read";
const schemaHash = "a".repeat(64);
const userId = "7bd9706e-6c70-4dd5-946f-0caac02bfc2a";
const serviceAccountId = "dd3f5bad-53ac-41e6-a1dc-98a7db0ffb9c";
const credentialId = "a9bacd3c-67e2-4b41-84eb-7a64bb0a2089";
const kid = "bd5e8d90-d2f1-48cb-9c5b-1b657165b8c5";
const jti = "5bb057b0-376a-4a9c-856c-aa62c1f49ccb";
const now = new Date("2026-09-02T00:00:00.000Z");
const nowSeconds = Math.floor(now.getTime() / 1_000);
let privateKey: CryptoKey;
let sessionPrivateKey: CryptoKey;
let pssPrivateKey: CryptoKey;
let keySet: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair(CLOUD_IDENTITY_ALGORITHM, { extractable: true });
  privateKey = pair.privateKey;
  sessionPrivateKey = (await generateKeyPair(CLOUD_IDENTITY_ALGORITHM)).privateKey;
  pssPrivateKey = (await generateKeyPair("PS256")).privateKey;
  const publicKey: JWK = { ...(await exportJWK(pair.publicKey)), alg: CLOUD_IDENTITY_ALGORITHM, kid, use: "sig" };
  keySet = createLocalJWKSet({ keys: [publicKey] });
});

const baseClaims = (): CloudInvocationClaims => ({
  iss: issuer,
  aud: `app:${targetAppId}`,
  token_use: "invocation",
  sub: userId,
  principal_type: "user",
  access_subject_type: "user",
  access_subject_id: userId,
  act: { sub: `app:${callingAppId}` },
  credential_kind: "session",
  scopes: [],
  op: operation,
  schema_hash: schemaHash,
  ver: CLOUD_INVOCATION_PROTOCOL_VERSION,
  request_id: "request-1",
  jti,
  iat: nowSeconds,
  nbf: nowSeconds,
  exp: nowSeconds + 30,
});

const token = async (
  claims: Record<string, unknown> = baseClaims(),
  header: { alg?: string; typ?: string; kid?: string; extra?: Record<string, unknown> } = {},
): Promise<string> =>
  new SignJWT(claims)
    .setProtectedHeader({
      alg: header.alg ?? CLOUD_IDENTITY_ALGORITHM,
      typ: header.typ ?? CLOUD_INVOCATION_TOKEN_TYPE,
      kid: header.kid ?? kid,
      ...(header.extra ?? {}),
    })
    .sign(header.alg === "PS256" ? pssPrivateKey : privateKey);

const verify = (value: string, expected: { targetAppId?: string; operation?: string; schemaHash?: string | null } = {}) =>
  verifyInvocationToken(
    value,
    {
      targetAppId: expected.targetAppId ?? targetAppId,
      operation: expected.operation ?? operation,
      schemaHash: expected.schemaHash === undefined ? schemaHash : expected.schemaHash,
    },
    { issuer, key: keySet, now },
  );

describe("Cloud invocation JWT", () => {
  test("uses the guarded issuer without another runtime configuration read", async () => {
    const config = spyOn(runtimeConfig, "getIdentityRuntimeConfig").mockRejectedValue(new Error("unexpected settings read"));
    try {
      const signed = await signInvocationToken({
        issuer,
        targetAppId,
        callingAppId,
        operation,
        schemaHash,
        issuedAt: now,
        authority: {
          sub: userId,
          principal_type: "user",
          access_subject_type: "user",
          access_subject_id: userId,
          credential_kind: "session",
          scopes: [],
        },
        signer: { key: privateKey, kid, signUntil: new Date(now.getTime() + 60_000) },
      });
      expect(config).not.toHaveBeenCalled();
      expect(await verify(signed.token)).not.toBeNull();
    } finally {
      config.mockRestore();
    }
  });

  test("normalizes optional request metadata before signing, but verifies signed claims strictly", async () => {
    const config = spyOn(runtimeConfig, "getIdentityRuntimeConfig").mockResolvedValue({
      issuer,
      jwksUrl: new URL(issuer),
      sessionJwksUrl: new URL(issuer),
      invocationJwksUrl: new URL(issuer),
      oauthJwksUrl: new URL(issuer),
      groupsAdmin: [],
    });
    try {
      expect(normalizeInvocationRequestId("request-1")).toBe("request-1");
      expect(normalizeInvocationRequestId("x".repeat(200))).toHaveLength(200);
      for (const requestId of ["", "two words", "ümlaut", "x".repeat(201), "line\nbreak"]) {
        expect(normalizeInvocationRequestId(requestId)).toBeUndefined();
        const signed = await signInvocationToken({
          targetAppId,
          callingAppId,
          operation,
          schemaHash,
          requestId,
          issuedAt: now,
          authority: {
            sub: userId,
            principal_type: "user",
            access_subject_type: "user",
            access_subject_id: userId,
            credential_kind: "session",
            scopes: [],
          },
          signer: { key: privateKey, kid, signUntil: new Date(now.getTime() + 60_000) },
        });
        expect(signed.claims.request_id).toBeUndefined();
        expect(await verify(signed.token)).not.toBeNull();
        expect(await verify(await token({ ...baseClaims(), request_id: requestId }))).toBeNull();
      }
      expect(normalizeInvocationRequestId(undefined)).toBeUndefined();
      expect(normalizeInvocationRequestId(123)).toBeUndefined();
    } finally {
      config.mockRestore();
    }
  });

  test("accepts the minimal strict user-session contract", async () => {
    const signed = await token();
    expect(isInvocationJwtCandidate(signed)).toBe(true);
    expect(await verify(signed)).toEqual(baseClaims());
  });

  test("accepts delegated and resource-bound service-account authority", async () => {
    const delegated = await token({
      ...baseClaims(),
      sub: serviceAccountId,
      principal_type: "service_account",
      access_subject_id: userId,
      delegated_user_id: userId,
      credential_kind: "api_key",
      credential_id: credentialId,
      scopes: ["read"],
    });
    expect(await verify(delegated)).toMatchObject({
      sub: serviceAccountId,
      principal_type: "service_account",
      access_subject_type: "user",
      access_subject_id: userId,
      delegated_user_id: userId,
    });

    const resource = await token({
      ...baseClaims(),
      sub: serviceAccountId,
      principal_type: "service_account",
      access_subject_type: "service_account",
      access_subject_id: serviceAccountId,
      credential_kind: "oauth",
      credential_id: credentialId,
      scopes: ["read", "write"],
    });
    expect(await verify(resource)).toMatchObject({
      sub: serviceAccountId,
      access_subject_type: "service_account",
      access_subject_id: serviceAccountId,
      scopes: ["read", "write"],
    });
  });

  test("accepts complete mandate provenance and rejects partial provenance", async () => {
    const mandate = await token({
      ...baseClaims(),
      credential_kind: "mandate",
      mandate_id: "10ec1c74-858b-4a98-9ba7-ab2276754c69",
      mandate_revision: 3,
      workload_type: "ai.task",
      workload_id: "task-1",
    });
    expect(await verify(mandate)).toMatchObject({ credential_kind: "mandate", mandate_revision: 3 });

    const partial = await token({
      ...baseClaims(),
      credential_kind: "mandate",
      mandate_id: "10ec1c74-858b-4a98-9ba7-ab2276754c69",
    });
    expect(await verify(partial)).toBeNull();
  });

  test("rejects wrong audience, operation, and schema binding", async () => {
    const signed = await token();
    expect(await verify(signed, { targetAppId: "spaces" })).toBeNull();
    expect(await verify(signed, { operation: "capability.action.run:message.read" })).toBeNull();
    expect(await verify(signed, { schemaHash: "b".repeat(64) })).toBeNull();
    expect(await verify(signed, { schemaHash: null })).toBeNull();
  });

  test("can defer only schema comparison for an authenticated mismatch response", async () => {
    const signed = await token();
    const options = { issuer, key: keySet, now, deferSchemaBinding: true };
    expect(await verifyInvocationToken(signed, { targetAppId, operation, schemaHash: "b".repeat(64) }, options)).toEqual(baseClaims());
    expect(await verifyInvocationToken(signed, { targetAppId: "spaces", operation, schemaHash }, options)).toBeNull();
    expect(await verifyInvocationToken(signed, { targetAppId, operation: "capability.query:other", schemaHash }, options)).toBeNull();
    expect(
      await verifyInvocationToken(
        await token({ ...baseClaims(), request_id: "invalid metadata" }),
        { targetAppId, operation, schemaHash },
        options,
      ),
    ).toBeNull();
  });

  test("rejects inconsistent actor and access-subject combinations", async () => {
    const inconsistent = [
      { ...baseClaims(), access_subject_id: serviceAccountId },
      { ...baseClaims(), principal_type: "service_account", delegated_user_id: userId },
      {
        ...baseClaims(),
        sub: serviceAccountId,
        principal_type: "service_account",
        access_subject_type: "service_account",
        access_subject_id: userId,
      },
      { ...baseClaims(), credential_kind: "api_key" },
    ];
    for (const claims of inconsistent) expect(await verify(await token(claims))).toBeNull();
  });

  test("rejects duplicate scopes, unknown claims, and unknown protected headers", async () => {
    expect(await verify(await token({ ...baseClaims(), scopes: ["read", "read"] }))).toBeNull();
    expect(await verify(await token({ ...baseClaims(), roles: ["admin"] }))).toBeNull();
    expect(await verify(await token(baseClaims(), { extra: { cty: "JWT" } }))).toBeNull();
  });

  test("rejects token confusion and malformed key ids", async () => {
    expect(await verify(await token({ ...baseClaims(), token_use: "session" }))).toBeNull();
    expect(await verify(await token({ ...baseClaims(), iss: "https://other.example" }))).toBeNull();
    expect(await verify(await token({ ...baseClaims(), ver: 2 }))).toBeNull();
    expect(await verify(await token({ ...baseClaims(), scopes: ["read"] }))).toBeNull();
    expect(await verify(await token(baseClaims(), { typ: "cloud-session+jwt" }))).toBeNull();
    expect(await verify(await token(baseClaims(), { kid: "not-a-uuid" }))).toBeNull();
    expect(await verify(await token(baseClaims(), { alg: "PS256" }))).toBeNull();
  });

  test("rejects an invocation-shaped token signed by a session key", async () => {
    const wrongPurpose = await new SignJWT(baseClaims())
      .setProtectedHeader({
        alg: CLOUD_IDENTITY_ALGORITHM,
        typ: CLOUD_INVOCATION_TOKEN_TYPE,
        kid: "530b8902-c7c9-4131-8c81-bfe128f550fd",
      })
      .sign(sessionPrivateKey);
    expect(await verify(wrongPurpose)).toBeNull();
  });

  test("enforces the fixed lifetime, not-before time, expiry, and compact size bound", async () => {
    expect(await verify(await token({ ...baseClaims(), exp: nowSeconds + 31 }))).toBeNull();
    expect(
      await verify(
        await token({
          ...baseClaims(),
          iat: nowSeconds + 31,
          nbf: nowSeconds + 31,
          exp: nowSeconds + 61,
        }),
      ),
    ).toBeNull();
    expect(
      await verify(
        await token({
          ...baseClaims(),
          iat: nowSeconds - 61,
          nbf: nowSeconds - 61,
          exp: nowSeconds - 31,
        }),
      ),
    ).toBeNull();
    expect(await verify("x".repeat(IDENTITY_MAX_COMPACT_TOKEN_BYTES + 1))).toBeNull();
    expect(isInvocationJwtCandidate("x".repeat(IDENTITY_MAX_COMPACT_TOKEN_BYTES + 1))).toBe(false);
  });

  test("allows at most two seconds of invocation clock skew", async () => {
    expect(
      await verify(
        await token({
          ...baseClaims(),
          iat: nowSeconds - 31,
          nbf: nowSeconds - 31,
          exp: nowSeconds - 1,
        }),
      ),
    ).not.toBeNull();
    expect(
      await verify(
        await token({
          ...baseClaims(),
          iat: nowSeconds - 33,
          nbf: nowSeconds - 33,
          exp: nowSeconds - 3,
        }),
      ),
    ).toBeNull();
    expect(
      await verify(
        await token({
          ...baseClaims(),
          iat: nowSeconds + 1,
          nbf: nowSeconds + 1,
          exp: nowSeconds + 31,
        }),
      ),
    ).not.toBeNull();
    expect(
      await verify(
        await token({
          ...baseClaims(),
          iat: nowSeconds + 3,
          nbf: nowSeconds + 3,
          exp: nowSeconds + 33,
        }),
      ),
    ).toBeNull();
  });
});
