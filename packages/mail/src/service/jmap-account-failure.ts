import { redis, sql } from "@k2b/cloud";
import { JMAP_RATE_LIMIT_FALLBACK_MS } from "./jmap-failure";
import { PROVIDER_BREAKER_MAX_WINDOW_MS } from "./provider-operation-lock";

/**
 * The longest wait a JMAP server's Retry-After sets: the provider breaker's longest window, the
 * cadence at which the scheduler verifies each binding again. A server that asks for more is
 * asked again then, as a server that does not answer at all would be. Shorter waits are kept as
 * the server sent them; the IMAP folder sync's 60-second cap does not apply.
 */
export const JMAP_RATE_LIMIT_MAX_MS = PROVIDER_BREAKER_MAX_WINDOW_MS;

// One hash tag per remote mailbox, like its provider lease line.
const cooldownKey = (remoteResourceId: string): string => `mail:jmap-cooldown:{${remoteResourceId}}`;

// KEYS: the cooldown. ARGV: wait. Extends the cooldown to the wait unless it already lasts longer,
// and returns how long it lasts now.
const extendCooldownScript = `
  local current = tonumber(redis.call("PTTL", KEYS[1]))
  local wanted = tonumber(ARGV[1])
  if current < wanted then
    redis.call("SET", KEYS[1], "1", "PX", wanted)
    return wanted
  end
  return current
`;

/**
 * Records a JMAP server's rate limit for the remote mailbox: every JMAP turn of the mailbox, the
 * account job's and body hydration's, waits for it before its next request. The cooldown only
 * grows: a shorter wait never ends a longer one. Returns how long it lasts. A wait that is not
 * positive takes the fallback of a 429 without Retry-After. Valkey errors keep the wait for the
 * caller alone.
 */
export const extendJmapCooldown = async (remoteResourceId: string, waitMs: number): Promise<number> => {
  const wait = waitMs > 0 ? Math.min(Math.ceil(waitMs), JMAP_RATE_LIMIT_MAX_MS) : JMAP_RATE_LIMIT_FALLBACK_MS;
  const reply = await redis.send("EVAL", [extendCooldownScript, "1", cooldownKey(remoteResourceId), String(wait)]).catch(() => wait);
  const lasts = Number(reply);
  return Number.isFinite(lasts) && lasts > 0 ? lasts : wait;
};

/** How long the remote mailbox's JMAP cooldown still lasts, or 0. Valkey errors answer 0. */
export const jmapCooldownMs = async (remoteResourceId: string): Promise<number> => {
  const remaining = Number(await redis.send("PTTL", [cooldownKey(remoteResourceId)]).catch(() => 0));
  return Number.isFinite(remaining) && remaining > 0 ? remaining : 0;
};

/** What a JMAP turn read before it sent the credentials: the failure may only be recorded for these. */
export type JmapAccountFailureContext = {
  remoteResourceId: string;
  bindingId: string;
  secretRevision: number;
  scopeFingerprint: string;
};

/**
 * - `auth_required`: the server refused the credentials (401); the account needs a new login.
 * - `access_denied`: the server refused access to the account (403); the credentials may be right,
 *   but the binding can no longer read the account.
 * - `degraded`: any other failure of a turn; the next completed commit clears it.
 */
export type JmapAccountHealthFailure = { kind: "auth_required" | "access_denied" } | { kind: "degraded"; code: string };

const FAILURE_TEXT = {
  auth_required: { code: "JMAP_AUTHENTICATION_FAILED", message: "The JMAP server rejected the credentials" },
  access_denied: { code: "JMAP_ACCESS_DENIED", message: "The JMAP server denied access to the account" },
} as const;

/**
 * Writes a JMAP account failure into the binding, connection, resource and mailbox health, the way
 * the IMAP folder sync's `recordSyncFailure` does, but only while the binding, the credentials and
 * the account are still the ones the turn used: a new login or another account written meanwhile
 * keeps its own health. A refused login degrades binding and connection and asks for a new login;
 * a refused account degrades only the binding and asks for a new connection, not a new password.
 * Both stop the account's turns until the binding is verified again (`loadJmapAccountAccess`
 * reports it inactive), so nothing repeats the refusal. Errors are swallowed: the job keeps its own.
 */
export const recordJmapAccountFailure = async (context: JmapAccountFailureContext, failure: JmapAccountHealthFailure): Promise<void> => {
  const refused = failure.kind !== "degraded";
  const authFailure = failure.kind === "auth_required";
  const { code, message } = failure.kind === "degraded" ? { code: failure.code, message: "JMAP synchronization failed" } : FAILURE_TEXT[failure.kind];
  await sql
    .begin(async (tx) => {
      // Lock order as recordSyncFailure: the resource first, then binding, connection and mailbox.
      const [resource] = await tx<{ mailbox_id: string; connection_id: string }[]>`
        SELECT resource.mailbox_id, binding.connection_id
        FROM mail.remote_resources resource
        JOIN mail.provider_bindings binding ON binding.id = ${context.bindingId}::uuid AND binding.remote_resource_id = resource.id
        JOIN mail.provider_connections connection ON connection.id = binding.connection_id
        WHERE resource.id = ${context.remoteResourceId}::uuid
          AND resource.connector_kind = 'jmap'
          AND resource.scope_fingerprint = ${context.scopeFingerprint}
          AND binding.state <> 'revoked'
          AND binding.verified_scope_fingerprint = ${context.scopeFingerprint}
          AND binding.verified_secret_revision = ${context.secretRevision}
          AND connection.secret_revision = ${context.secretRevision}
          AND connection.status <> 'revoked'
        FOR UPDATE OF resource
      `;
      if (!resource) return;
      await tx`
        UPDATE mail.provider_bindings
        SET state = CASE WHEN ${refused} THEN 'degraded' ELSE state END, last_error_code = ${code}, last_error_message = ${message}
        WHERE id = ${context.bindingId}::uuid
      `;
      if (authFailure) {
        await tx`
          UPDATE mail.provider_connections SET status = 'degraded', last_error_code = ${code}, last_error_message = ${message}
          WHERE id = ${resource.connection_id}::uuid
        `;
      }
      await tx`
        UPDATE mail.remote_resources
        SET status = ${refused ? "connection_required" : "degraded"}, last_error_code = ${code}, last_error_message = ${message}
        WHERE id = ${context.remoteResourceId}::uuid
      `;
      // Pausing does not fence a running turn; a late failure must not hide the pause.
      await tx`
        UPDATE mail.mailboxes
        SET
          health = CASE WHEN sync_enabled = false THEN 'paused'
            ELSE ${authFailure ? "auth_required" : refused ? "connection_required" : "degraded"} END,
          health_reason = CASE WHEN sync_enabled = false THEN 'Synchronization paused by a mailbox administrator' ELSE ${message} END
        WHERE id = ${resource.mailbox_id}::uuid
      `;
    })
    .catch(() => undefined);
};
