import { sql } from "bun";
import { logger } from "../services/logging";

const log = logger("capabilities:claims");

/**
 * Platform-owned idempotency claims for capability Actions.
 *
 * Every Action that declares `idempotency: "required"` is claimed here before
 * the dispatcher forwards it, and resolved once the outcome is known. Apps own
 * no claim code: retry safety is the same contract for built-in and
 * third-party capabilities.
 */
export type CapabilityClaimScope = {
  appId: string;
  /** Fully qualified capability name, such as `grids.record_create`. */
  capability: string;
  /** Acting principal as `user:<id>`, `service_account:<id>`, or `anonymous`. */
  principal: string;
  /** Caller-supplied Idempotency-Key, hashed before storage. */
  keyHash: string;
};

export type CapabilityClaimState = "in_flight" | "succeeded" | "uncertain";

export type CapabilityClaimOutcome =
  /** The caller owns this claim and must resolve it after forwarding. */
  | { state: "claimed" }
  /** A definitive earlier success for the same input; return this response verbatim. */
  | { state: "replay"; status: number; body: unknown }
  /** An earlier success whose response exceeded the retained body cap. */
  | { state: "not_retained" }
  /** Same key, different input. */
  | { state: "conflict" }
  /** A concurrent attempt still holds the claim. */
  | { state: "in_flight" }
  /** An earlier attempt left the outcome unknown; the caller must verify with a Query. */
  | { state: "uncertain" };

/**
 * A retry window long enough to cover a human or agent noticing a lost
 * response and repeating the call, without keeping response bodies around as
 * de-facto durable app data. Twenty-four hours is the common industry contract
 * and there is deliberately no operator setting for it.
 */
export const CAPABILITY_CLAIM_RETENTION_HOURS = 24;

/**
 * Responses larger than this are not retained. A replay then reports that the
 * result is gone rather than returning a partial or fabricated body; the
 * caller must read the current state with a Query.
 */
export const CAPABILITY_CLAIM_MAX_BODY_BYTES = 256 * 1024;

/** Stable JSON with sorted object keys, so equal inputs hash equally whatever order the caller sent. */
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
};

const sha256 = (value: string): string => new Bun.CryptoHasher("sha256").update(value).digest("hex");

/** Hash of the validated capability input. Two calls with the same key must carry the same hash. */
export const capabilityRequestHash = (input: unknown): string => sha256(canonicalJson(input));

export const capabilityIdempotencyKeyHash = (key: string): string => sha256(key);

type ClaimRow = { state: CapabilityClaimState; request_hash: string; response_status: number | null; response_body: unknown };

/**
 * Claim the scope before forwarding. Inserts `in_flight`; on conflict it reads
 * the existing row and never re-forwards a call whose outcome is already known
 * or still unknown.
 */
export const claimCapabilityIdempotency = async (scope: CapabilityClaimScope, requestHash: string): Promise<CapabilityClaimOutcome> => {
  const [inserted] = await sql<{ inserted: boolean }[]>`
    INSERT INTO capabilities.idempotency_claims (app_id, capability, principal, key_hash, request_hash, state)
    VALUES (${scope.appId}, ${scope.capability}, ${scope.principal}, ${scope.keyHash}, ${requestHash}, 'in_flight')
    ON CONFLICT (app_id, capability, principal, key_hash) DO NOTHING
    RETURNING true AS inserted
  `;
  if (inserted) return { state: "claimed" };

  const [existing] = await sql<ClaimRow[]>`
    SELECT state, request_hash, response_status, response_body
    FROM capabilities.idempotency_claims
    WHERE app_id = ${scope.appId} AND capability = ${scope.capability}
      AND principal = ${scope.principal} AND key_hash = ${scope.keyHash}
  `;
  // The row can disappear between the insert and the read when a concurrent
  // attempt releases a definitive failure. Retrying the claim once is safe.
  if (!existing) {
    const [second] = await sql<{ inserted: boolean }[]>`
      INSERT INTO capabilities.idempotency_claims (app_id, capability, principal, key_hash, request_hash, state)
      VALUES (${scope.appId}, ${scope.capability}, ${scope.principal}, ${scope.keyHash}, ${requestHash}, 'in_flight')
      ON CONFLICT (app_id, capability, principal, key_hash) DO NOTHING
      RETURNING true AS inserted
    `;
    return second ? { state: "claimed" } : { state: "in_flight" };
  }
  if (existing.request_hash !== requestHash) return { state: "conflict" };
  if (existing.state === "in_flight") return { state: "in_flight" };
  if (existing.state === "uncertain") return { state: "uncertain" };
  if (existing.response_status === null) return { state: "not_retained" };
  return { state: "replay", status: existing.response_status, body: existing.response_body };
};

/** Records a definitive success so a later retry replays it instead of acting twice. */
export const completeCapabilityClaim = async (scope: CapabilityClaimScope, status: number, body: unknown): Promise<void> => {
  let serialized: string | null = null;
  try {
    const encoded = JSON.stringify(body);
    if (encoded !== undefined && new TextEncoder().encode(encoded).byteLength <= CAPABILITY_CLAIM_MAX_BODY_BYTES) serialized = encoded;
  } catch {
    serialized = null;
  }
  await sql`
    UPDATE capabilities.idempotency_claims
    SET state = 'succeeded',
        response_status = ${serialized === null ? null : status},
        response_body = ${serialized}::text::jsonb,
        updated_at = now()
    WHERE app_id = ${scope.appId} AND capability = ${scope.capability}
      AND principal = ${scope.principal} AND key_hash = ${scope.keyHash}
  `;
};

/** Releases a claim whose failure proves nothing happened, so a corrected retry can run. */
export const releaseCapabilityClaim = async (scope: CapabilityClaimScope): Promise<void> => {
  await sql`
    DELETE FROM capabilities.idempotency_claims
    WHERE app_id = ${scope.appId} AND capability = ${scope.capability}
      AND principal = ${scope.principal} AND key_hash = ${scope.keyHash}
      AND state = 'in_flight'
  `;
};

/** Freezes a claim whose request left the dispatcher without a usable answer. Never deleted by a retry. */
export const markCapabilityClaimUncertain = async (scope: CapabilityClaimScope): Promise<void> => {
  await sql`
    UPDATE capabilities.idempotency_claims
    SET state = 'uncertain', updated_at = now()
    WHERE app_id = ${scope.appId} AND capability = ${scope.capability}
      AND principal = ${scope.principal} AND key_hash = ${scope.keyHash}
      AND state = 'in_flight'
  `;
};

/** Resolving a claim must never fail the call it describes; the outcome is already decided. */
export const resolveCapabilityClaim = async (resolve: Promise<void>, scope: CapabilityClaimScope): Promise<void> =>
  resolve.catch((error: unknown) => {
    log.error("Capability idempotency claim could not be resolved", {
      capability: scope.capability,
      error: error instanceof Error ? error.message : String(error),
    });
  });

const PRUNE_BATCH_SIZE = 5_000;

/** Deletes expired claims in bounded batches, alongside the execution retention sweep. */
export const pruneCapabilityIdempotencyClaims = async (olderThan: Date): Promise<number> => {
  let total = 0;
  let deleted: number;
  do {
    const result = await sql`
      WITH expired AS (
        SELECT ctid FROM capabilities.idempotency_claims WHERE created_at < ${olderThan} LIMIT ${PRUNE_BATCH_SIZE}
      )
      DELETE FROM capabilities.idempotency_claims claim USING expired WHERE claim.ctid = expired.ctid
    `;
    deleted = result.count;
    total += deleted;
  } while (deleted === PRUNE_BATCH_SIZE);
  return total;
};
