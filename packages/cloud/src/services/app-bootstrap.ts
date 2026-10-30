import { type SQL, sql } from "bun";
import { decodeJwt, decodeProtectedHeader, type JWTPayload, jwtVerify } from "jose";
import { importAppPublicKey } from "../app-key";
import {
  BOOTSTRAP_PATH,
  BOOTSTRAP_PROOF_BYTES,
  BOOTSTRAP_PROOF_SECONDS,
  BOOTSTRAP_REPLAY_RETENTION_SECONDS,
  BOOTSTRAP_TYPE,
  type BootstrapIdentity,
  bootstrapBodyDigest,
} from "../runtime/bootstrap-protocol";
import { getActiveAppKey, getInstallationId } from "./app-keys";

export class BootstrapProofError extends Error {
  constructor(readonly code: "invalid_proof" | "wrong_app" | "wrong_installation" | "replayed_proof" | "connections_not_permitted") {
    super(code);
    this.name = "BootstrapProofError";
  }
}
const invalid = () => new BootstrapProofError("invalid_proof");

/** Shared Postgres uniqueness rejects a proof used concurrently on different Core replicas. */
export const consumeBootstrapProof = async (keyId: string, jti: string, exp: number, db: SQL = sql): Promise<boolean> => {
  const rows = await db`
    INSERT INTO auth.app_proof_replays (key_id, jti, retain_until)
    VALUES (${keyId}::uuid, ${jti}, ${new Date((exp + BOOTSTRAP_REPLAY_RETENTION_SECONDS) * 1000)})
    ON CONFLICT (key_id, jti) DO NOTHING RETURNING jti
  `;
  return rows.length === 1;
};

/** Called by Core's existing minute maintenance. Reuse its 100-row page budget. */
export const cleanupBootstrapProofs = async (db: SQL = sql): Promise<void> => {
  await db`DELETE FROM auth.app_proof_replays WHERE (key_id, jti) IN (
    SELECT key_id, jti FROM auth.app_proof_replays WHERE retain_until <= now()
    ORDER BY retain_until LIMIT 100 FOR UPDATE SKIP LOCKED
  )`;
};

/** No caches: every HTTP transmission rechecks revocation, expiry and account state in Postgres. */
export const authenticateBootstrap = async (
  proof: string,
  request: { method: string; path: string; body: Uint8Array<ArrayBuffer> },
  db: SQL = sql,
  now = Date.now(),
): Promise<BootstrapIdentity> => {
  if (Buffer.byteLength(proof) > BOOTSTRAP_PROOF_BYTES) throw invalid();
  let appId: string;
  let keyId: string;
  try {
    const header = decodeProtectedHeader(proof);
    const claims = decodeJwt(proof);
    if (header.alg !== "EdDSA" || header.typ !== BOOTSTRAP_TYPE || typeof header.kid !== "string" || typeof claims.iss !== "string")
      throw invalid();
    appId = claims.iss;
    keyId = header.kid;
  } catch {
    throw invalid();
  }
  // Only validated IDs reach SQL, and the app identity must own this active credential.
  const key = await getActiveAppKey({ appId, keyId }, db);
  if (!key) throw invalid();
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
  const seconds = Math.floor(now / 1000);
  if (
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.exp) ||
    claims.iat! > seconds + 2 ||
    claims.exp! <= claims.iat! ||
    claims.exp! - claims.iat! > BOOTSTRAP_PROOF_SECONDS ||
    typeof claims.jti !== "string" ||
    claims.jti.length === 0 ||
    claims.jti.length > 64 ||
    claims.jti.includes("\0") ||
    request.method !== "POST" ||
    request.path !== BOOTSTRAP_PATH ||
    claims.htm !== request.method ||
    claims.htu !== request.path ||
    claims.bdh !== (await bootstrapBodyDigest(request.body))
  )
    throw invalid();
  if (claims.iss !== key.appId || claims.sub !== key.appId) throw new BootstrapProofError("wrong_app");
  const installationId = await getInstallationId(db);
  if (claims.aud !== `cloud-core:${installationId}`) throw new BootstrapProofError("wrong_installation");
  if (!key.connectionsAllowed) throw new BootstrapProofError("connections_not_permitted");
  if (!(await consumeBootstrapProof(keyId, claims.jti, claims.exp!, db))) throw new BootstrapProofError("replayed_proof");
  return { installationId, appId, keyId };
};
