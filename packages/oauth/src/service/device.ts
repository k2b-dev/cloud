import { audit, toPgTextArray } from "@k2b/cloud/services";
import { redis, sql } from "bun";
import type { OAuthClient, OAuthScope } from "@/contracts";

// ==========================
// OAuth Device Authorization Grant (RFC 8628)
// ==========================

/** RFC 8628 §6.1: short enough to type, long enough that brute force stays bounded by the failure limit. */
export const DEVICE_CODE_LIFETIME_SECONDS = 600;
/** Minimum polling interval the token endpoint enforces with `slow_down`. */
export const DEVICE_POLL_INTERVAL_SECONDS = 5;

/** 32 symbols without the easily confused 0, O, 1 and I; eight symbols give 40 bits. */
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const USER_CODE_LENGTH = 8;
const INSERT_ATTEMPTS = 3;

const FAILED_ENTRY_LIMIT = 10;
const FAILED_ENTRY_WINDOW_SECONDS = 15 * 60;
const CONFIRMATION_TTL_SECONDS = 5 * 60;

type DeviceStatus = "pending" | "approved" | "denied" | "consumed";

type DbDeviceAuthorization = {
  id: string;
  client_id: string;
  scopes: string[];
  status: DeviceStatus;
  user_id: string | null;
  expires_at: Date;
};

export type PendingDeviceAuthorization = {
  id: string;
  clientId: string;
  scopes: OAuthScope[];
  expiresAt: Date;
};

const sha256 = (value: string): string => new Bun.CryptoHasher("sha256").update(value).digest("hex");

const randomDeviceCode = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

const randomUserCode = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(USER_CODE_LENGTH)), (byte) => USER_CODE_ALPHABET[byte & 31]).join("");

/** Accept lowercase, spaces, and dashes; return the canonical eight symbols or null. */
export const normalizeUserCode = (input: string): string | null => {
  const compact = input.toUpperCase().replace(/[\s-]/g, "");
  if (compact.length !== USER_CODE_LENGTH) return null;
  return [...compact].every((symbol) => USER_CODE_ALPHABET.includes(symbol)) ? compact : null;
};

export const formatUserCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

const mapPending = (row: DbDeviceAuthorization): PendingDeviceAuthorization => ({
  id: row.id,
  clientId: row.client_id,
  scopes: row.scopes as OAuthScope[],
  expiresAt: row.expires_at,
});

/** Start one device authorization. The plaintext codes are returned once and never stored. */
export const create = async (params: {
  client: OAuthClient;
  scopes: OAuthScope[];
}): Promise<{ deviceCode: string; userCode: string; expiresIn: number; interval: number }> => {
  const deviceCode = randomDeviceCode();
  for (let attempt = 0; attempt < INSERT_ATTEMPTS; attempt += 1) {
    const userCode = randomUserCode();
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO oauth.device_authorizations (device_code_hash, user_code_hash, client_id, scopes, audiences, expires_at)
      SELECT
        ${sha256(deviceCode)},
        ${sha256(userCode)},
        client.client_id,
        ${toPgTextArray(params.scopes)}::text[],
        ARRAY(
          SELECT audience
          FROM unnest(ARRAY['cloud', client.client_id]::text[] || client.audiences) WITH ORDINALITY AS value(audience, position)
          GROUP BY audience
          ORDER BY min(position)
        ),
        now() + make_interval(secs => ${DEVICE_CODE_LIFETIME_SECONDS})
      FROM oauth.clients client
      WHERE client.client_id = ${params.client.clientId}
      ON CONFLICT (user_code_hash) DO NOTHING
      RETURNING id
    `;
    if (row) return { deviceCode, userCode, expiresIn: DEVICE_CODE_LIFETIME_SECONDS, interval: DEVICE_POLL_INTERVAL_SECONDS };
  }
  throw new Error("Could not allocate a unique device user code");
};

/** Find a still-pending authorization by the code the person typed. */
export const findPendingByUserCode = async (userCode: string): Promise<PendingDeviceAuthorization | null> => {
  const [row] = await sql<DbDeviceAuthorization[]>`
    SELECT id, client_id, scopes, status, user_id, expires_at
    FROM oauth.device_authorizations
    WHERE user_code_hash = ${sha256(userCode)}
      AND status = 'pending'
      AND expires_at > now()
  `;
  return row ? mapPending(row) : null;
};

export const getPending = async (id: string): Promise<PendingDeviceAuthorization | null> => {
  const [row] = await sql<DbDeviceAuthorization[]>`
    SELECT id, client_id, scopes, status, user_id, expires_at
    FROM oauth.device_authorizations
    WHERE id = ${id}::uuid
      AND status = 'pending'
      AND expires_at > now()
  `;
  return row ? mapPending(row) : null;
};

type AuditActor = { userId: string; uid: string; provider: string; roles: readonly string[] };

/** Record the resource owner's decision exactly once, together with its audit entry. */
export const decide = async (params: {
  id: string;
  client: OAuthClient;
  actor: AuditActor;
  decision: "approve" | "deny";
}): Promise<boolean> =>
  sql.begin(async (tx) => {
    const status: DeviceStatus = params.decision === "approve" ? "approved" : "denied";
    const [row] = await tx<{ id: string; scopes: string[] }[]>`
      UPDATE oauth.device_authorizations
      SET status = ${status}, user_id = ${params.actor.userId}::uuid, decided_at = now()
      WHERE id = ${params.id}::uuid
        AND client_id = ${params.client.clientId}
        AND status = 'pending'
        AND expires_at > now()
      RETURNING id, scopes
    `;
    if (!row) return false;
    await audit.record(
      {
        action: "oauth.device.authorize",
        outcome: params.decision === "approve" ? "allowed" : "denied",
        actor: params.actor,
        target: { type: "oauth_client", id: params.client.id, label: params.client.name },
        ...(params.decision === "deny" ? { reason: "resource_owner_denied" } : {}),
        metadata: { clientId: params.client.clientId, deviceAuthorizationId: row.id, scopes: row.scopes },
      },
      tx,
    );
    return true;
  });

export type DevicePollResult =
  | { ok: false; error: "invalid_grant" | "authorization_pending" | "slow_down" | "access_denied" | "expired_token" }
  | {
      ok: true;
      userId: string;
      scopes: OAuthScope[];
      audiences: string[];
      authorityGrant: { kind: "device_code"; deviceAuthorizationId: string; nonce: string };
    };

/**
 * Answer one token-endpoint poll. An approved authorization is consumed atomically,
 * so a device code can mint tokens at most once.
 */
export const poll = async (params: { deviceCode: string; clientId: string }): Promise<DevicePollResult> => {
  const [row] = await sql<(DbDeviceAuthorization & { expired: boolean })[]>`
    SELECT id, client_id, scopes, status, user_id, expires_at, expires_at <= now() AS expired
    FROM oauth.device_authorizations
    WHERE device_code_hash = ${sha256(params.deviceCode)}
  `;
  if (!row || row.client_id !== params.clientId) return { ok: false, error: "invalid_grant" };
  if (row.status === "consumed") return { ok: false, error: "invalid_grant" };
  if (row.expired) return { ok: false, error: "expired_token" };

  // RFC 8628 §3.5: polling faster than the advertised interval earns slow_down.
  const accepted = await redis.send("SET", [`oauth:device:poll:${row.id}`, "1", "EX", String(DEVICE_POLL_INTERVAL_SECONDS), "NX"]);
  if (accepted === null) return { ok: false, error: "slow_down" };

  if (row.status === "pending") return { ok: false, error: "authorization_pending" };
  if (row.status === "denied") return { ok: false, error: "access_denied" };

  const nonce = crypto.randomUUID();
  const [consumed] = await sql<{ user_id: string; scopes: string[]; audiences: string[] }[]>`
    UPDATE oauth.device_authorizations
    SET status = 'consumed', authority_nonce = ${nonce}::uuid
    WHERE id = ${row.id}::uuid
      AND status = 'approved'
      AND expires_at > now()
    RETURNING user_id, scopes, audiences
  `;
  if (!consumed) return { ok: false, error: "invalid_grant" };
  return {
    ok: true,
    userId: consumed.user_id,
    scopes: consumed.scopes as OAuthScope[],
    audiences: consumed.audiences,
    authorityGrant: { kind: "device_code", deviceAuthorizationId: row.id, nonce },
  };
};

// ==========================
// Code entry protection
// ==========================

const failedEntryKeys = (subjects: { ip: string; userId: string }): string[] => [
  `oauth:device:failed:ip:${sha256(subjects.ip)}`,
  `oauth:device:failed:user:${subjects.userId}`,
];

/** Whether this browser address or account already typed too many wrong codes. */
export const isEntryBlocked = async (subjects: { ip: string; userId: string }): Promise<boolean> => {
  const counts = await Promise.all(failedEntryKeys(subjects).map((key) => redis.get(key)));
  return counts.some((count) => Number(count ?? 0) >= FAILED_ENTRY_LIMIT);
};

export const recordFailedEntry = async (subjects: { ip: string; userId: string }): Promise<void> => {
  for (const key of failedEntryKeys(subjects)) {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, FAILED_ENTRY_WINDOW_SECONDS);
  }
};

/**
 * Bind the rendered confirmation to the signed-in person. The form carries only
 * this unguessable, single-use token, so a cross-site form that knows the user
 * code still cannot submit a decision.
 */
export const createConfirmation = async (params: { deviceAuthorizationId: string; userId: string }): Promise<string> => {
  const id = crypto.randomUUID();
  await redis.set(`oauth:device:confirm:${id}`, JSON.stringify(params), "EX", CONFIRMATION_TTL_SECONDS);
  return id;
};

export const consumeConfirmation = async (id: string): Promise<{ deviceAuthorizationId: string; userId: string } | null> => {
  const raw = await redis.getdel(`oauth:device:confirm:${id}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { deviceAuthorizationId?: unknown; userId?: unknown };
    return typeof parsed.deviceAuthorizationId === "string" && typeof parsed.userId === "string"
      ? { deviceAuthorizationId: parsed.deviceAuthorizationId, userId: parsed.userId }
      : null;
  } catch {
    return null;
  }
};

/** Remove authorizations an hour after expiry and consumed ones whose tokens were issued. */
export const cleanup = async (): Promise<number> => {
  const result = await sql`
    DELETE FROM oauth.device_authorizations
    WHERE expires_at < now() - INTERVAL '1 hour'
      OR (status = 'consumed' AND authority_issued_at IS NOT NULL)
  `;
  return result.count;
};
