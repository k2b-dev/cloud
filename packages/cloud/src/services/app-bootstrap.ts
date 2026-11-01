import type { SQL } from "bun";
import { decodeJwt, decodeProtectedHeader, type JWTPayload, jwtVerify } from "jose";
import { importAppPublicKey, validateAppKeyAppId } from "../app-key";
import {
  BOOTSTRAP_PATH,
  BOOTSTRAP_PROOF_BYTES,
  BOOTSTRAP_PROOF_SECONDS,
  BOOTSTRAP_REPLAY_RETENTION_SECONDS,
  BOOTSTRAP_TYPE,
  type BootstrapIdentity,
  BootstrapIdentitySchema,
  bootstrapBodyDigest,
} from "../runtime/bootstrap-protocol";
import { sql } from "../runtime/clients";
import { getActiveAppKey, getInstallationId, getStoredAppKey, type LastRejectedStart } from "./app-keys";
import { get } from "./settings";

export class BootstrapProofError extends Error {
  constructor(readonly code: "invalid_proof" | "wrong_app" | "wrong_installation" | "replayed_proof" | "connections_not_permitted") {
    super(code);
    this.name = "BootstrapProofError";
  }
}
/** Evidence attached only after signature and every request claim have been verified. */
export class RejectedBootstrapStart extends BootstrapProofError {
  constructor(
    readonly identity: BootstrapIdentity,
    readonly jti: string,
    readonly reason: LastRejectedStart["reason"],
  ) {
    super(reason === "connections_not_permitted" ? reason : "invalid_proof");
  }
}
const invalid = () => new BootstrapProofError("invalid_proof");

/** A refused proof is never consumed. Already-consumed proofs cannot change administrator state. */
export const recordRejectedBootstrapStart = async (rejection: RejectedBootstrapStart, db: SQL = sql): Promise<void> => {
  const { identity, jti, reason } = rejection;
  await db`
    INSERT INTO auth.app_start_rejections (app_id, rejected_at, reason, key_id)
    SELECT ${identity.appId}, clock_timestamp(), ${reason}, ${identity.keyId}::uuid
    WHERE NOT EXISTS (SELECT 1 FROM auth.app_proof_replays WHERE key_id = ${identity.keyId}::uuid AND jti = ${jti})
    ON CONFLICT (app_id) DO UPDATE
      SET rejected_at = EXCLUDED.rejected_at, reason = EXCLUDED.reason, key_id = EXCLUDED.key_id
  `;
};

export const clearRejectedBootstrapStart = async (appId: string, db: SQL = sql): Promise<void> => {
  await db`DELETE FROM auth.app_start_rejections WHERE app_id = ${appId}`;
};

/** Shared Postgres uniqueness rejects a proof used concurrently on different Core replicas. */
export const consumeBootstrapProof = async (keyId: string, jti: string, exp: number, db: SQL = sql): Promise<boolean> => {
  const rows = await db`
    INSERT INTO auth.app_proof_replays (key_id, jti, retain_until)
    VALUES (${keyId}::uuid, ${jti}, ${new Date((exp + BOOTSTRAP_REPLAY_RETENTION_SECONDS) * 1000)})
    ON CONFLICT (key_id, jti) DO NOTHING RETURNING jti
  `;
  return rows.length === 1;
};

/** The ingress, per-key admission and minute maintenance share this installation budget. */
export const bootstrapRateLimit = async (): Promise<number> => Math.max(1, Math.floor(await get<number>("security.rate_limit_per_second")));

/** Drain expired pages, with two minutes of per-key admission capacity to catch up after missed runs. */
export const cleanupBootstrapProofs = async (
  db: SQL = sql,
  { signal }: { signal?: AbortSignal } = {},
): Promise<{ deleted: number; remaining: number }> => {
  signal?.throwIfAborted();
  // Include revoked keys: their retained evidence still needs cleaning after revocation.
  const [keys] = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM auth.service_account_credentials WHERE kind = 'app_key'`;
  const maxRows = Math.max(1, keys?.count ?? 0) * (await bootstrapRateLimit()) * 60 * 2;
  let deleted = 0;
  while (deleted < maxRows) {
    signal?.throwIfAborted();
    const batchSize = Math.min(100, maxRows - deleted);
    const query = db`
      WITH batch AS MATERIALIZED (
        SELECT key_id, jti FROM auth.app_proof_replays WHERE retain_until <= now()
        ORDER BY retain_until LIMIT ${batchSize} FOR UPDATE SKIP LOCKED
      )
      DELETE FROM auth.app_proof_replays replay USING batch
      WHERE replay.key_id = batch.key_id AND replay.jti = batch.jti AND replay.retain_until <= now()
      RETURNING replay.jti
    `;
    const abort = () => query.cancel();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      const rows = await query;
      deleted += rows.length;
      if (rows.length < batchSize) break;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  signal?.throwIfAborted();
  const [backlog] = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM auth.app_proof_replays WHERE retain_until <= now()`;
  return { deleted, remaining: backlog?.count ?? 0 };
};

/** Reject malformed or expired envelopes before allocating or reading a signed request body. Not authentication. */
export const inspectAppProof = (proof: string, now = Date.now()): { appId: string; keyId: string } => {
  if (Buffer.byteLength(proof) > BOOTSTRAP_PROOF_BYTES || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/.test(proof))
    throw invalid();
  let appId: string;
  let keyId: string;
  try {
    const header = decodeProtectedHeader(proof);
    const claims = decodeJwt(proof);
    if (header.alg !== "EdDSA" || header.typ !== BOOTSTRAP_TYPE || typeof header.kid !== "string" || typeof claims.iss !== "string")
      throw invalid();
    validateAppKeyAppId(claims.iss);
    if (!BootstrapIdentitySchema.shape.keyId.safeParse(header.kid).success) throw invalid();
    const seconds = Math.floor(now / 1000);
    if (
      !Number.isSafeInteger(claims.iat) ||
      !Number.isSafeInteger(claims.exp) ||
      claims.iat! > seconds + 2 ||
      claims.exp! <= seconds ||
      claims.exp! <= claims.iat! ||
      claims.exp! - claims.iat! > BOOTSTRAP_PROOF_SECONDS
    )
      throw invalid();
    appId = claims.iss;
    keyId = header.kid;
  } catch {
    throw invalid();
  }
  return { appId, keyId };
};

/** No caches: every HTTP transmission rechecks revocation, expiry and account state in Postgres. */
export const authenticateAppProof = async (
  proof: string,
  request: { method: string; path: string; body: Uint8Array<ArrayBuffer> },
  db: SQL = sql,
  now = Date.now(),
): Promise<{ identity: BootstrapIdentity; key: NonNullable<Awaited<ReturnType<typeof getActiveAppKey>>>; jti: string; exp: number }> => {
  const { appId, keyId } = inspectAppProof(proof, now);
  // Only validated IDs reach SQL, and the app identity must own this active credential.
  const key = await getActiveAppKey({ appId, keyId }, db);
  if (!key) throw invalid();
  return verifyAppProof(proof, request, key, db, now);
};

const verifyAppProof = async (
  proof: string,
  request: { method: string; path: string; body: Uint8Array<ArrayBuffer> },
  key: NonNullable<Awaited<ReturnType<typeof getStoredAppKey>>>,
  db: SQL,
  now: number,
) => {
  let claims: JWTPayload;
  try {
    const verified = await jwtVerify(proof, await importAppPublicKey(key.publicKey), {
      algorithms: ["EdDSA"],
      typ: BOOTSTRAP_TYPE,
      currentDate: new Date(now),
      requiredClaims: ["iss", "sub", "aud", "iat", "exp", "jti", "htm", "htu", "bdh"],
    });
    claims = verified.payload;
  } catch {
    throw invalid();
  }
  if (
    typeof claims.jti !== "string" ||
    claims.jti.length === 0 ||
    claims.jti.length > 64 ||
    claims.jti.includes("\0") ||
    claims.htm !== request.method ||
    claims.htu !== request.path ||
    claims.bdh !== (await bootstrapBodyDigest(request.body))
  )
    throw invalid();
  if (claims.iss !== key.appId || claims.sub !== key.appId) throw new BootstrapProofError("wrong_app");
  const installationId = await getInstallationId(db);
  if (claims.aud !== `cloud-core:${installationId}`) throw new BootstrapProofError("wrong_installation");
  // Admission must succeed before the route atomically consumes this verified nonce.
  return { identity: { installationId, appId: key.appId, keyId: key.keyId }, key, jti: claims.jti, exp: claims.exp! };
};

/** Only connection delivery requires connections_allowed; runners can still sign requests. */
export const authenticateBootstrap = async (
  proof: string,
  request: { method: string; path: string; body: Uint8Array<ArrayBuffer> },
  db: SQL = sql,
  now = Date.now(),
): Promise<{ identity: BootstrapIdentity; jti: string; exp: number }> => {
  const ids = inspectAppProof(proof, now);
  const key = await getStoredAppKey(ids, db);
  if (!key) throw invalid();
  const inactive = key.status !== "active" || key.accountStatus !== "active";
  let verified: Awaited<ReturnType<typeof verifyAppProof>>;
  try {
    verified = await verifyAppProof(proof, request, key, db, now);
  } catch (error) {
    // Inactive keys have always returned invalid_proof, regardless of their claims.
    if (inactive) throw invalid();
    throw error;
  }
  if (request.method !== "POST" || request.path !== BOOTSTRAP_PATH) throw invalid();
  const reason =
    key.status === "revoked"
      ? "revoked"
      : key.status === "expired"
        ? "expired"
        : key.accountStatus === "disabled"
          ? "disabled"
          : key.appId === "runner" || !key.connectionsAllowed
            ? "connections_not_permitted"
            : null;
  if (reason) throw new RejectedBootstrapStart(verified.identity, verified.jti, reason);
  const { identity, jti, exp } = verified;
  return { identity, jti, exp };
};
