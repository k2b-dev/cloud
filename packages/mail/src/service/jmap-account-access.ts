import { sql } from "@k2b/cloud";
import { fetchJmapSession, JMAP_MAIL, type JmapSession, jmapBasicAuthorization } from "./connectors/jmap-client";
import { type JmapTransportDependencies, JmapTransportError } from "./connectors/jmap-transport";
import { loadJmapConnectionRuntimeSnapshot } from "./provider-connections";
import { providerErrorCode } from "./provider-errors";
import { jmapScopeEvidenceSchema, jmapScopeFingerprint } from "./provider-identity";

export type JmapAccountAccess = {
  session: JmapSession;
  authorization: string;
  accountId: string;
  bindingId: string;
  /** The revision the password was read with; the account commit checks it again. */
  secretRevision: number;
  connectionId: string;
  mailboxId: string;
};
export type JmapAccountUnavailableReason = "missing" | "not_jmap" | "paused" | "binding_inactive" | "origin_missing" | "account_mismatch";
export type JmapAccountAccessResult =
  | { status: "ready"; access: JmapAccountAccess }
  | { status: "unavailable"; reason: JmapAccountUnavailableReason };

type AccessRow = {
  resource_kind: string;
  resource_status: string;
  scope_fingerprint: string;
  mailbox_id: string;
  mailbox_deleted: boolean;
  sync_enabled: boolean;
  health: string;
  binding_id: string | null;
  binding_state: string | null;
  verified_scope_fingerprint: string | null;
  verified_secret_revision: number | null;
  verification_evidence: unknown;
  connection_id: string | null;
  connection_kind: string | null;
  connection_status: string | null;
  connection_encrypted: boolean | null;
  secret_revision: number | null;
};

const unavailable = (reason: JmapAccountUnavailableReason): JmapAccountAccessResult => ({ status: "unavailable", reason });

/** A credential-free HTTPS origin, written exactly as URL normalizes it. */
const approvedOrigin = (value: string | null): string | null => {
  if (value === null || !URL.canParse(value)) return null;
  const url = new URL(value);
  return url.protocol === "https:" && url.origin === value ? value : null;
};

/**
 * Loads what one JMAP account run needs: the Session from the operator-approved origin, the
 * credentials and the binding they were verified for. Nothing is cached; each call reads the
 * database and the Session again, and the credentials go to `jmap_origin` only.
 *
 * Not runnable states are results, not errors. Session failures (HTTP, transport) are thrown as
 * the connector's errors; `classifyJmapFailure` sorts them.
 */
export async function loadJmapAccountAccess(params: {
  remoteResourceId: string;
  signal: AbortSignal;
  db?: typeof sql;
  transport?: JmapTransportDependencies;
  /**
   * Receives the binding, revision and account fingerprint just before the credentials go out, so a
   * caller can record a refused Session for exactly these (`recordJmapAccountFailure`).
   */
  onRead?: (read: { bindingId: string; secretRevision: number; scopeFingerprint: string }) => void;
}): Promise<JmapAccountAccessResult> {
  if (params.signal.aborted) throw new JmapTransportError("JMAP_ABORTED");
  const db = params.db ?? sql;
  // At most one binding per resource is not revoked (provider_bindings_resource_current_idx).
  const [row] = await db<AccessRow[]>`
    SELECT resource.connector_kind AS resource_kind, resource.status AS resource_status, resource.scope_fingerprint,
      mailbox.id AS mailbox_id, mailbox.deleted_at IS NOT NULL AS mailbox_deleted, mailbox.sync_enabled, mailbox.health,
      binding.id AS binding_id, binding.state AS binding_state, binding.verified_scope_fingerprint,
      binding.verified_secret_revision, binding.verification_evidence,
      connection.id AS connection_id, connection.connector_kind AS connection_kind, connection.status AS connection_status,
      connection.encrypted_secret IS NOT NULL AS connection_encrypted, connection.secret_revision
    FROM mail.remote_resources resource
    JOIN mail.mailboxes mailbox ON mailbox.id = resource.mailbox_id
    LEFT JOIN mail.provider_bindings binding ON binding.remote_resource_id = resource.id AND binding.state <> 'revoked'
    LEFT JOIN mail.provider_connections connection ON connection.id = binding.connection_id
    WHERE resource.id = ${params.remoteResourceId}::uuid
  `;
  if (!row || row.mailbox_deleted) return unavailable("missing");
  if (row.resource_kind !== "jmap" || (row.connection_kind !== null && row.connection_kind !== "jmap")) return unavailable("not_jmap");
  if (!row.sync_enabled || row.resource_status === "paused" || row.health === "paused") return unavailable("paused");
  if (
    !row.binding_id ||
    !row.connection_id ||
    row.binding_state !== "active" ||
    row.connection_status !== "active" ||
    !row.connection_encrypted ||
    !["active", "degraded"].includes(row.resource_status) ||
    ["auth_required", "connection_required"].includes(row.health) ||
    row.verified_scope_fingerprint !== row.scope_fingerprint ||
    row.verified_secret_revision !== row.secret_revision
  )
    return unavailable("binding_inactive");
  const evidence = jmapScopeEvidenceSchema.safeParse(row.verification_evidence);
  if (!evidence.success || jmapScopeFingerprint(evidence.data) !== row.scope_fingerprint) return unavailable("account_mismatch");

  // Password, revision and origin come from one row read, so the password only goes where it was approved to.
  let snapshot: Awaited<ReturnType<typeof loadJmapConnectionRuntimeSnapshot>>;
  try {
    snapshot = await loadJmapConnectionRuntimeSnapshot(row.connection_id, db);
  } catch (error) {
    // Revoked between the two reads.
    if (providerErrorCode(error, "") === "CONNECTION_UNAVAILABLE") return unavailable("binding_inactive");
    throw error;
  }
  if (snapshot.connectorKind !== "jmap") return unavailable("not_jmap");
  if (snapshot.secretRevision !== row.verified_secret_revision) return unavailable("binding_inactive");
  const origin = approvedOrigin(snapshot.jmapOrigin);
  if (!origin) return unavailable("origin_missing");
  // Never send the credentials to an origin whose Session could not match the stored account anyway.
  if (evidence.data.origin !== origin) return unavailable("account_mismatch");

  const authorization = jmapBasicAuthorization(snapshot.runtime.username, snapshot.runtime.secret);
  params.onRead?.({ bindingId: row.binding_id, secretRevision: snapshot.secretRevision, scopeFingerprint: row.scope_fingerprint });
  const session = await fetchJmapSession({ origin, authorization, signal: params.signal }, params.transport);
  const account = Object.hasOwn(session.accounts, evidence.data.accountId) ? session.accounts[evidence.data.accountId] : undefined;
  if (session.origin !== origin || !account || !Object.hasOwn(account.accountCapabilities, JMAP_MAIL))
    return unavailable("account_mismatch");
  return {
    status: "ready",
    access: {
      session,
      authorization,
      accountId: evidence.data.accountId,
      bindingId: row.binding_id,
      secretRevision: snapshot.secretRevision,
      connectionId: row.connection_id,
      mailboxId: row.mailbox_id,
    },
  };
}
