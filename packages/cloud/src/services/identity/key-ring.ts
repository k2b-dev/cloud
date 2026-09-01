import { crypto } from "@k2b/stdlib";
import { sql } from "bun";
import {
  CompactSign,
  compactVerify,
  exportJWK,
  generateKeyPair,
  importJWK,
  type JWK,
} from "jose";
import { logger } from "../logging";
import {
  CLOUD_IDENTITY_ALGORITHM,
  IDENTITY_ACTIVATION_LEAD_MS,
  IDENTITY_CLOCK_TOLERANCE_SECONDS,
  IDENTITY_ROLLOUT_MARGIN_MS,
  IDENTITY_ROTATION_AGE_MS,
  IDENTITY_SIGNING_CACHE_MS,
} from "./constants";
import { readIdentityKeyEncryptionConfig, type IdentityKeyEncryptionConfig } from "./key-config";
import { identityMetrics } from "./metrics";

export type SigningKeyPurpose = "session" | "invocation" | "oauth";
export type SigningKeyState = "pending" | "active" | "retired" | "revoked";

type SigningKeyRow = {
  id: string;
  purpose: SigningKeyPurpose;
  state: SigningKeyState;
  kid: string;
  alg: "RS256";
  public_jwk: JWK | string;
  encrypted_private_jwk: string;
  encryption_key_id: string;
  created_at: Date | string;
  activate_at: Date | string;
  activated_at: Date | string | null;
  sign_until: Date | string;
  retired_at: Date | string | null;
  verify_until: Date | string;
  revoked_at: Date | string | null;
};

export type PreparedIdentitySigner = {
  kid: string;
  key: CryptoKey;
  signUntil: Date;
};

export type IdentitySigningKeyStatus = {
  purpose: SigningKeyPurpose;
  state: SigningKeyState;
  kid: string;
  alg: "RS256";
  encryptionKeyId: string;
  createdAt: string;
  activateAt: string;
  signUntil: string;
  verifyUntil: string;
  revokedAt: string | null;
};

type GeneratedKey = {
  kid: string;
  publicJwk: JWK;
  encryptedPrivateJwk: string;
  encryptionKeyId: string;
  privateKey: CryptoKey;
};

const log = logger("core:identity-keyring");
const encoder = new TextEncoder();
const PURPOSE_FALLBACK_TOKEN_TTL_MS: Record<SigningKeyPurpose, number> = {
  session: 24 * 60 * 60_000,
  invocation: 30_000,
  oauth: 2 * 60 * 60_000,
};

const date = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));
const publicJwk = (value: JWK | string): JWK => (typeof value === "string" ? (JSON.parse(value) as JWK) : value);
const serializedSize = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength;

const assertRsaJwk = (value: JWK, privateRequired: boolean): void => {
  if (value.kty !== "RSA" || typeof value.n !== "string" || typeof value.e !== "string") {
    throw new Error("Cloud identity key is not an RSA JWK");
  }
  if (privateRequired && typeof value.d !== "string") throw new Error("Cloud identity private JWK is incomplete");
  if (value.alg && value.alg !== CLOUD_IDENTITY_ALGORITHM) throw new Error("Cloud identity key uses an unsupported algorithm");
};

const verifyPair = async (privateJwk: JWK, expectedPublicJwk: JWK): Promise<CryptoKey> => {
  assertRsaJwk(privateJwk, true);
  assertRsaJwk(expectedPublicJwk, false);
  if (privateJwk.n !== expectedPublicJwk.n || privateJwk.e !== expectedPublicJwk.e) {
    throw new Error("Cloud identity private/public key pair does not match");
  }
  const importedPrivate = await importJWK(privateJwk, CLOUD_IDENTITY_ALGORITHM);
  const importedPublic = await importJWK(expectedPublicJwk, CLOUD_IDENTITY_ALGORITHM);
  if (!(importedPrivate instanceof CryptoKey) || !(importedPublic instanceof CryptoKey)) {
    throw new Error("Cloud identity RSA JWK imported as an unexpected key type");
  }
  const probe = encoder.encode("cloud-identity-key-pair-check");
  const signature = await new CompactSign(probe).setProtectedHeader({ alg: CLOUD_IDENTITY_ALGORITHM }).sign(importedPrivate);
  const verified = await compactVerify(signature, importedPublic, { algorithms: [CLOUD_IDENTITY_ALGORITHM] });
  if (new TextDecoder().decode(verified.payload) !== "cloud-identity-key-pair-check") {
    throw new Error("Cloud identity key-pair verification failed");
  }
  return importedPrivate;
};

const decryptPrivateJwk = async (row: SigningKeyRow, keys: IdentityKeyEncryptionConfig): Promise<JWK> => {
  const candidate =
    row.encryption_key_id === keys.current.id
      ? keys.current
      : row.encryption_key_id === keys.previous?.id
        ? keys.previous
        : row.encryption_key_id === keys.next?.id
          ? keys.next
          : null;
  if (!candidate) throw new Error(`No configured KEK can decrypt Cloud identity key ${row.kid}`);
  const plaintext = await crypto.symmetric.decrypt({ payload: row.encrypted_private_jwk, key: candidate.key });
  const parsed = JSON.parse(plaintext) as JWK;
  if (serializedSize(parsed) > 16_384) throw new Error("Cloud identity private JWK exceeds its size bound");
  return parsed;
};

const generateEncryptedKey = async (keys: IdentityKeyEncryptionConfig): Promise<GeneratedKey> => {
  const { privateKey, publicKey } = await generateKeyPair(CLOUD_IDENTITY_ALGORITHM, { extractable: true, modulusLength: 2048 });
  const kid = crypto.common.uuid();
  const [rawPrivate, rawPublic] = await Promise.all([exportJWK(privateKey), exportJWK(publicKey)]);
  const privateJwk: JWK = { ...rawPrivate, alg: CLOUD_IDENTITY_ALGORITHM, kid, use: "sig" };
  const exposedPublicJwk: JWK = { ...rawPublic, alg: CLOUD_IDENTITY_ALGORITHM, kid, use: "sig" };
  assertRsaJwk(privateJwk, true);
  assertRsaJwk(exposedPublicJwk, false);
  if (serializedSize(exposedPublicJwk) > 16_384 || serializedSize(privateJwk) > 16_384) {
    throw new Error("Generated Cloud identity JWK exceeds its size bound");
  }
  const encryptedPrivateJwk = await crypto.symmetric.encrypt({
    payload: JSON.stringify(privateJwk),
    key: keys.current.key,
    stretched: false,
  });
  if (encoder.encode(encryptedPrivateJwk).byteLength > 32_768) {
    throw new Error("Encrypted Cloud identity private JWK exceeds its size bound");
  }
  return { kid, publicJwk: exposedPublicJwk, encryptedPrivateJwk, encryptionKeyId: keys.current.id, privateKey };
};

const signingDeadline = (activateAt: Date): Date =>
  new Date(activateAt.getTime() + IDENTITY_ROTATION_AGE_MS + IDENTITY_ACTIVATION_LEAD_MS + IDENTITY_SIGNING_CACHE_MS);

const cache = new Map<SigningKeyPurpose, { signer: PreparedIdentitySigner; expiresAt: number }>();
let maintenanceTimer: ReturnType<typeof setInterval> | null = null;

const importRow = async (row: SigningKeyRow, keys: IdentityKeyEncryptionConfig): Promise<PreparedIdentitySigner> => {
  if (row.alg !== CLOUD_IDENTITY_ALGORITHM || row.state !== "active") throw new Error("Cloud identity signer row is not active RS256");
  const privateJwk = await decryptPrivateJwk(row, keys);
  const key = await verifyPair(privateJwk, publicJwk(row.public_jwk));
  return { kid: row.kid, key, signUntil: date(row.sign_until) };
};

const selectRows = async (purpose: SigningKeyPurpose): Promise<SigningKeyRow[]> =>
  sql<SigningKeyRow[]>`
    SELECT id, purpose, state, kid, alg, public_jwk, encrypted_private_jwk, encryption_key_id,
      created_at, activate_at, activated_at, sign_until, retired_at, verify_until, revoked_at
    FROM auth.signing_keys
    WHERE purpose = ${purpose} AND state IN ('pending', 'active')
    ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END, created_at DESC
  `;

const insertKey = async (
  db: typeof sql,
  purpose: SigningKeyPurpose,
  generated: GeneratedKey,
  state: "pending" | "active",
  now: Date,
): Promise<void> => {
  const activateAt = state === "active" ? now : new Date(now.getTime() + IDENTITY_ACTIVATION_LEAD_MS);
  const signUntil = signingDeadline(activateAt);
  const purposeTtl = PURPOSE_FALLBACK_TOKEN_TTL_MS[purpose];
  const verifyUntil = new Date(signUntil.getTime() + purposeTtl + IDENTITY_CLOCK_TOLERANCE_SECONDS * 1_000 + IDENTITY_ROLLOUT_MARGIN_MS);
  await db`
    INSERT INTO auth.signing_keys (
      purpose, state, kid, alg, public_jwk, encrypted_private_jwk, encryption_key_id,
      created_at, activate_at, activated_at, sign_until, verify_until
    ) VALUES (
      ${purpose}, ${state}, ${generated.kid}, ${CLOUD_IDENTITY_ALGORITHM}, ${JSON.stringify(generated.publicJwk)}::jsonb,
      ${generated.encryptedPrivateJwk}, ${generated.encryptionKeyId}, ${now}, ${activateAt},
      ${state === "active" ? now : null}, ${signUntil}, ${verifyUntil}
    )
  `;
};

const maintainPurpose = async (purpose: SigningKeyPurpose): Promise<SigningKeyRow> => {
  const keys = await readIdentityKeyEncryptionConfig();
  const before = await selectRows(purpose);
  const beforeActive = before.find((row) => row.state === "active");
  const beforePending = before.find((row) => row.state === "pending");
  const nowMs = Date.now();
  const activeIsFresh =
    beforeActive &&
    nowMs < date(beforeActive.sign_until).getTime() - IDENTITY_ACTIVATION_LEAD_MS &&
    nowMs < date(beforeActive.created_at).getTime() + IDENTITY_ROTATION_AGE_MS;
  if (activeIsFresh && (!beforePending || date(beforePending.activate_at).getTime() > nowMs)) return beforeActive;

  const generated = !beforeActive || (!beforePending && !activeIsFresh) ? await generateEncryptedKey(keys) : null;
  const active = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`cloud:identity-keyring:${purpose}`}, 0))`;
    const rows = await tx<SigningKeyRow[]>`
      SELECT id, purpose, state, kid, alg, public_jwk, encrypted_private_jwk, encryption_key_id,
        created_at, activate_at, activated_at, sign_until, retired_at, verify_until, revoked_at
      FROM auth.signing_keys
      WHERE purpose = ${purpose} AND state IN ('pending', 'active')
      ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END, created_at DESC
      FOR UPDATE
    `;
    let current = rows.find((row) => row.state === "active");
    const pending = rows.find((row) => row.state === "pending");
    const now = new Date();

    if (pending && date(pending.activate_at).getTime() <= now.getTime()) {
      if (current) {
        const overlapSignUntil = new Date(now.getTime() + IDENTITY_SIGNING_CACHE_MS);
        await tx`
          UPDATE auth.signing_keys
          SET state = 'retired', retired_at = ${now}, sign_until = ${overlapSignUntil},
              verify_until = GREATEST(verify_until, ${new Date(
                overlapSignUntil.getTime() +
                  PURPOSE_FALLBACK_TOKEN_TTL_MS[purpose] +
                  IDENTITY_CLOCK_TOLERANCE_SECONDS * 1_000 +
                  IDENTITY_ROLLOUT_MARGIN_MS,
              )})
          WHERE id = ${current.id}
        `;
      }
      const [promoted] = await tx<SigningKeyRow[]>`
        UPDATE auth.signing_keys
        SET state = 'active', activated_at = ${now}
        WHERE id = ${pending.id}
        RETURNING id, purpose, state, kid, alg, public_jwk, encrypted_private_jwk, encryption_key_id,
          created_at, activate_at, activated_at, sign_until, retired_at, verify_until, revoked_at
      `;
      if (!promoted) throw new Error(`Failed to promote ${purpose} signing key`);
      current = promoted;
      identityMetrics.increment("rotation_success");
      log.info("Cloud identity signing key promoted", { purpose, kid: promoted.kid });
    }

    if (!current) {
      if (!generated) throw new Error(`No ${purpose} signing key candidate is available`);
      await insertKey(tx as typeof sql, purpose, generated, "active", now);
      const [created] = await tx<SigningKeyRow[]>`
        SELECT id, purpose, state, kid, alg, public_jwk, encrypted_private_jwk, encryption_key_id,
          created_at, activate_at, activated_at, sign_until, retired_at, verify_until, revoked_at
        FROM auth.signing_keys WHERE purpose = ${purpose} AND state = 'active'
      `;
      if (!created) throw new Error(`Failed to create initial ${purpose} signing key`);
      current = created;
      identityMetrics.increment("rotation_success");
      log.info("Initial Cloud identity signing key created", { purpose, kid: created.kid });
    }

    const currentDue =
      date(current.created_at).getTime() + IDENTITY_ROTATION_AGE_MS <= now.getTime() ||
      date(current.sign_until).getTime() - IDENTITY_ACTIVATION_LEAD_MS <= now.getTime();
    if (!pending && currentDue) {
      const candidate = generated ?? (await generateEncryptedKey(keys));
      await insertKey(tx as typeof sql, purpose, candidate, "pending", now);
      log.info("Cloud identity signing key pre-published", { purpose, kid: candidate.kid });
    }
    return current;
  });
  return active;
};

export const prepareIdentitySigner = async (purpose: SigningKeyPurpose): Promise<PreparedIdentitySigner> => {
  const now = Date.now();
  const cached = cache.get(purpose);
  if (cached && cached.expiresAt > now && cached.signer.signUntil.getTime() > now) return cached.signer;
  try {
    const keys = await readIdentityKeyEncryptionConfig();
    const row = await maintainPurpose(purpose);
    const signer = await importRow(row, keys);
    if (signer.signUntil.getTime() <= now) throw new Error(`Active ${purpose} signing key is past sign_until`);
    cache.set(purpose, { signer, expiresAt: Math.min(now + IDENTITY_SIGNING_CACHE_MS, signer.signUntil.getTime()) });
    return signer;
  } catch (error) {
    identityMetrics.increment("rotation_failure");
    log.error("Cloud identity signer refresh failed", { purpose, error: error instanceof Error ? error.message : String(error) });
    if (cached && cached.signer.signUntil.getTime() > now) return cached.signer;
    throw error;
  }
};

export const initializeIdentityAuthority = async (): Promise<void> => {
  const keys = await readIdentityKeyEncryptionConfig();
  for (const purpose of ["session", "invocation"] as const) {
    const row = await maintainPurpose(purpose);
    const signer = await importRow(row, keys);
    cache.set(purpose, {
      signer,
      expiresAt: Math.min(Date.now() + IDENTITY_SIGNING_CACHE_MS, signer.signUntil.getTime()),
    });
  }
  if (keys.previous) await rewrapIdentitySigningKeys();
};

export const listIdentityJwks = async (): Promise<{ keys: JWK[]; etag: string }> => {
  const rows = await sql<Array<{ public_jwk: JWK | string }>>`
    SELECT public_jwk
    FROM auth.signing_keys
    WHERE purpose IN ('session', 'invocation')
      AND state IN ('pending', 'active', 'retired')
      AND verify_until > now()
    ORDER BY purpose, created_at
  `;
  const keys = rows.map((row) => publicJwk(row.public_jwk));
  return { keys, etag: `"${(await crypto.common.hash(JSON.stringify(keys))).slice(0, 32)}"` };
};

export const revokeIdentitySigningKey = async (params: { kid: string; reason: string }): Promise<boolean> => {
  const reason = params.reason.trim().slice(0, 500);
  if (!reason) throw new Error("Emergency key revocation requires a reason");
  const rows = await sql<Array<{ purpose: SigningKeyPurpose }>>`
    UPDATE auth.signing_keys
    SET state = 'revoked', revoked_at = now(), revoke_reason = ${reason}
    WHERE kid = ${params.kid} AND state <> 'revoked'
    RETURNING purpose
  `;
  for (const row of rows) cache.delete(row.purpose);
  if (rows.length > 0) {
    const purpose = rows[0]!.purpose;
    log.warn("Cloud identity signing key revoked", { kid: params.kid, purpose, reason });
    if (purpose === "session" || purpose === "invocation") await prepareIdentitySigner(purpose);
  }
  return rows.length > 0;
};

export const getIdentitySigningKeyStatus = async (): Promise<IdentitySigningKeyStatus[]> => {
  const rows = await sql<SigningKeyRow[]>`
    SELECT id, purpose, state, kid, alg, public_jwk, encrypted_private_jwk, encryption_key_id,
      created_at, activate_at, activated_at, sign_until, retired_at, verify_until, revoked_at
    FROM auth.signing_keys
    ORDER BY purpose, created_at DESC
  `;
  return rows.map((row) => ({
    purpose: row.purpose,
    state: row.state,
    kid: row.kid,
    alg: row.alg,
    encryptionKeyId: row.encryption_key_id,
    createdAt: date(row.created_at).toISOString(),
    activateAt: date(row.activate_at).toISOString(),
    signUntil: date(row.sign_until).toISOString(),
    verifyUntil: date(row.verify_until).toISOString(),
    revokedAt: row.revoked_at ? date(row.revoked_at).toISOString() : null,
  }));
};

export const rewrapIdentitySigningKeys = async (): Promise<number> => {
  const keys = await readIdentityKeyEncryptionConfig();
  const rows = await sql<SigningKeyRow[]>`
    SELECT id, purpose, state, kid, alg, public_jwk, encrypted_private_jwk, encryption_key_id,
      created_at, activate_at, activated_at, sign_until, retired_at, verify_until, revoked_at
    FROM auth.signing_keys
    ORDER BY created_at
  `;
  const replacements: Array<{ id: string; encrypted: string }> = [];
  for (const row of rows) {
    const privateJwk = await decryptPrivateJwk(row, keys);
    await verifyPair(privateJwk, publicJwk(row.public_jwk));
    if (row.encryption_key_id === keys.current.id) continue;
    const encrypted = await crypto.symmetric.encrypt({ payload: JSON.stringify(privateJwk), key: keys.current.key, stretched: false });
    const verifiedPlaintext = await crypto.symmetric.decrypt({ payload: encrypted, key: keys.current.key });
    await verifyPair(JSON.parse(verifiedPlaintext) as JWK, publicJwk(row.public_jwk));
    replacements.push({
      id: row.id,
      encrypted,
    });
  }
  if (replacements.length === 0) return 0;
  await sql.begin(async (tx) => {
    for (const replacement of replacements) {
      await tx`
        UPDATE auth.signing_keys
        SET encrypted_private_jwk = ${replacement.encrypted}, encryption_key_id = ${keys.current.id}
        WHERE id = ${replacement.id}
      `;
    }
  });
  cache.clear();
  log.info("Cloud identity signing keys rewrapped", { count: replacements.length, encryptionKeyId: keys.current.id });
  return replacements.length;
};

const maintainVerificationWindows = async (): Promise<void> => {
  await sql`
    UPDATE auth.signing_keys key
    SET verify_until = GREATEST(
      key.verify_until,
      family.latest_expiry + (${IDENTITY_CLOCK_TOLERANCE_SECONDS}::int * INTERVAL '1 second') + (${Math.floor(
        IDENTITY_ROLLOUT_MARGIN_MS / 1_000,
      )}::int * INTERVAL '1 second')
    )
    FROM (
      SELECT signing_kid, max(expires_at) AS latest_expiry
      FROM auth.session_families
      GROUP BY signing_kid
    ) family
    WHERE key.kid = family.signing_kid AND key.purpose = 'session'
  `;
};

export const runIdentityKeyMaintenance = async (): Promise<void> => {
  for (const purpose of ["session", "invocation"] as const) await maintainPurpose(purpose);
  await maintainVerificationWindows();
  await sql`
    DELETE FROM auth.session_families
    WHERE sid IN (
      SELECT sid FROM auth.session_families
      WHERE expires_at < now() - INTERVAL '24 hours'
        OR revoked_at < now() - INTERVAL '24 hours'
      ORDER BY COALESCE(revoked_at, expires_at)
      LIMIT 500
    )
  `;
  await sql`
    DELETE FROM auth.signing_keys
    WHERE id IN (
      SELECT key.id FROM auth.signing_keys key
      WHERE key.state = 'retired' AND key.verify_until < now()
        AND NOT EXISTS (
          SELECT 1 FROM auth.session_families family
          WHERE family.signing_kid = key.kid
        )
      ORDER BY verify_until
      LIMIT 100
    )
  `;
};

export const startIdentityKeyMaintenance = (): (() => void) => {
  if (maintenanceTimer) return () => undefined;
  maintenanceTimer = setInterval(() => {
    void runIdentityKeyMaintenance().catch((error) => {
      identityMetrics.increment("rotation_failure");
      log.error("Cloud identity key maintenance failed", { error: error instanceof Error ? error.message : String(error) });
    });
  }, IDENTITY_SIGNING_CACHE_MS);
  maintenanceTimer.unref?.();
  return () => {
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    maintenanceTimer = null;
  };
};

export const clearIdentityKeyCachesForTest = (): void => {
  cache.clear();
};

export const invalidateIdentitySignerCache = (purpose: SigningKeyPurpose, kid?: string): void => {
  const cached = cache.get(purpose);
  if (!kid || cached?.signer.kid === kid) cache.delete(purpose);
};
