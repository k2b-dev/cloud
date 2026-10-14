import { accounts, audit } from "@k2b/cloud/services";
import { err, fail, i18n, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { z } from "zod";
import { SENDER_VERIFICATION_WAIT_MS } from "../contracts";
import type { auditActorFromRequest } from "./auth";
import { commandStillAuthorized, type StoredCommandAuthorization } from "./command-authorization";
import { imapSmtpConnector } from "./connectors";
import { resolveRoleFolder } from "./folders";
import { loadProviderConnectionRuntimeSnapshot } from "./provider-connections";
import { type ProviderOperationTurn, withMailboxProviderOperationTurn } from "./provider-operation-lock";

type SqlClient = typeof sql;
type JsonRecord = Record<string, unknown>;
type AuditActor = ReturnType<typeof auditActorFromRequest>;

// A verification waits behind provider work for `SENDER_VERIFICATION_WAIT_MS`. Mail's lease line
// lets a waiting command go before later syncs, so a verification that cannot start within it finds
// a provider that does not answer rather than a busy mailbox.

const verificationMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      subject: "Cloud Mail sender identity verification",
      body: ({ address }: { address: string }) => `Cloud Mail verified that ${address} can be submitted through this provider binding.`,
    },
    de: {
      subject: "Bestätigung der Absenderidentität in Cloud Mail",
      body: ({ address }) => `Cloud Mail hat bestätigt, dass ${address} über diese Anbieterverbindung versendet werden kann.`,
    },
  },
});

export type SenderVerificationRequest = {
  mailboxId: string;
  senderIdentityId: string;
  bindingId: string;
  /** Lowercased and checked by the caller. */
  verificationRecipient: string;
  savesSentAutomatically: boolean;
  locale: string | null;
};

/**
 * Who asks for a verification: their permission is checked again under the mailbox lock, and the
 * audit names them, with the request or, for a queued verification, its command.
 */
export type SenderVerificationAuthority = {
  authorize: (db: SqlClient) => Promise<Result<unknown>>;
  auditActor: AuditActor;
  requestId: string | null;
  commandId?: string;
};

type DbSenderVerification = {
  id: string;
  from_address: string;
  display_name: string;
  reply_to: string | null;
  envelope_sender: string | null;
  sent_folder_id: string | null;
  connection_id: string;
  connection_username: string;
  secret_revision: number;
  authenticated_principal: string | null;
  remote_resource_id: string;
};

/** The identity and the active binding it would be verified through, or null when either is unavailable. */
export const loadSenderVerification = async (params: {
  mailboxId: string;
  senderIdentityId: string;
  bindingId: string;
  db?: SqlClient;
  lock?: boolean;
}): Promise<DbSenderVerification | null> => {
  const db = params.db ?? sql;
  const lockClause = params.lock ? sql`FOR UPDATE OF si, rr, pb, pc` : sql``;
  const [record] = await db<DbSenderVerification[]>`
    SELECT
      si.id,
      si.from_address,
      si.display_name,
      si.reply_to,
      si.envelope_sender,
      si.sent_folder_id,
      pb.connection_id,
      pc.username AS connection_username,
      pc.secret_revision,
      pb.authenticated_principal,
      rr.id AS remote_resource_id
    FROM mail.sender_identities si
    JOIN mail.remote_resources rr ON rr.mailbox_id = si.mailbox_id
    JOIN mail.mailboxes mailbox ON mailbox.id = si.mailbox_id
    JOIN mail.provider_bindings pb ON pb.remote_resource_id = rr.id
    JOIN mail.provider_connections pc ON pc.id = pb.connection_id
    WHERE si.id = ${params.senderIdentityId}::uuid
      AND si.mailbox_id = ${params.mailboxId}::uuid
      AND pb.id = ${params.bindingId}::uuid
      AND pb.state = 'active'
      AND pb.verified_scope_fingerprint = rr.scope_fingerprint
      AND pb.verified_secret_revision = pc.secret_revision
      AND pc.status = 'active'
      AND pc.encrypted_secret IS NOT NULL
      AND pc.owner_mailbox_id = ${params.mailboxId}::uuid
      AND rr.status = 'active'
      AND mailbox.deleted_at IS NULL
      AND si.status <> 'disabled'
    ${lockClause}
  `;
  return record ?? null;
};

const markRejected = (tx: SqlClient, senderIdentityId: string) => tx`
  UPDATE mail.sender_identities
  SET status = 'rejected', last_provider_rejection = 'Provider rejected sender identity verification'
  WHERE id = ${senderIdentityId}::uuid
`;

/** Sends the verification message and records the result; runs while the caller holds the mailbox's provider turn. */
const performSenderVerification = (
  request: SenderVerificationRequest,
  authority: SenderVerificationAuthority,
  remoteResourceId: string,
  assertLeaseActive: () => Promise<void>,
): Promise<Result<{ senderIdentityId: string }>> =>
  sql.begin(async (tx) => {
    const [mailbox] = await tx<{ id: string }[]>`
      SELECT id FROM mail.mailboxes WHERE id = ${request.mailboxId}::uuid AND deleted_at IS NULL FOR UPDATE
    `;
    if (!mailbox) return fail(err.notFound("Mailbox"));
    const permission = await authority.authorize(tx);
    if (!permission.ok) return permission;
    const current = await loadSenderVerification({ ...request, db: tx, lock: true });
    if (!current || current.remote_resource_id !== remoteResourceId) {
      return fail(err.badInput("Sender identity or provider binding changed before verification"));
    }
    // An identity created before Sent folders were preset, or whose folder was cleared, takes the mailbox's.
    // It is stored only with a successful verification, so a failed one leaves the identity unchanged.
    let filledSentFolderId: string | null = null;
    if (!request.savesSentAutomatically) {
      if (!current.sent_folder_id) {
        const sent = await resolveRoleFolder(request.mailboxId, "sent", tx);
        filledSentFolderId = sent.ok ? sent.data.id : null;
        if (!filledSentFolderId) return fail(err.badInput("A Sent folder is required when the provider does not save sent mail"));
      }
      const [sentRef] = await tx<{ allowed: boolean }[]>`
        SELECT 'insert' = ANY(effective_rights) AS allowed
        FROM mail.binding_folder_refs
        WHERE binding_id = ${request.bindingId}::uuid AND folder_id = ${current.sent_folder_id ?? filledSentFolderId}::uuid
      `;
      if (!sentRef?.allowed) return fail(err.badInput("The selected binding cannot append to the configured Sent folder"));
    }

    const messageId = `<cloud-sender-verification-${crypto.randomUUID()}@${current.from_address.split("@")[1] ?? "mail.invalid"}>`;
    const snapshot = await loadProviderConnectionRuntimeSnapshot(current.connection_id);
    if (snapshot.secretRevision !== current.secret_revision) {
      return fail(err.conflict("Provider credentials changed before sender verification"));
    }
    try {
      const t = verificationMessages.resolve([request.locale ?? "en"]).t;
      await assertLeaseActive();
      const result = await imapSmtpConnector.send(snapshot.runtime, {
        from: { name: current.display_name, address: current.from_address },
        replyTo: current.reply_to,
        envelopeFrom: current.envelope_sender,
        to: [{ address: request.verificationRecipient }],
        subject: t.subject,
        text: t.body({ address: current.from_address }),
        messageId,
      });
      await assertLeaseActive();
      if (result.accepted.length === 0 || result.rejected.includes(request.verificationRecipient)) {
        await markRejected(tx, current.id);
        return fail(err.badInput("The provider did not accept the sender identity verification message"));
      }
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "MAIL_PROVIDER_OPERATION_LEASE_LOST") throw error;
      await markRejected(tx, current.id);
      return fail(err.badInput("The provider rejected sender identity verification"));
    }

    await tx`
      INSERT INTO mail.sender_identity_bindings (
        sender_identity_id,
        binding_id,
        provider_principal,
        verified_at,
        verified_secret_revision,
        saves_sent_automatically,
        revoked_at,
        last_error_code
      )
      VALUES (
        ${current.id}::uuid,
        ${request.bindingId}::uuid,
        ${current.authenticated_principal ?? current.connection_username},
        now(),
        ${current.secret_revision},
        ${request.savesSentAutomatically},
        NULL,
        NULL
      )
      ON CONFLICT (sender_identity_id, binding_id) DO UPDATE SET
        provider_principal = EXCLUDED.provider_principal,
        verified_at = now(),
        verified_secret_revision = EXCLUDED.verified_secret_revision,
        saves_sent_automatically = EXCLUDED.saves_sent_automatically,
        revoked_at = NULL,
        last_error_code = NULL
    `;
    const [updated] = await tx<{ id: string; from_address: string }[]>`
      UPDATE mail.sender_identities si
      SET status = 'verified', last_provider_rejection = NULL, sent_folder_id = COALESCE(si.sent_folder_id, ${filledSentFolderId}::uuid)
      WHERE si.id = ${current.id}::uuid
        AND si.mailbox_id = ${request.mailboxId}::uuid
        AND si.status <> 'disabled'
      RETURNING si.id, si.from_address
    `;
    if (!updated) throw Object.assign(new Error("Sender identity disappeared during verification"), { code: "SENDER_IDENTITY_MISSING" });
    await audit.record(
      {
        action: "mail.sender_identity.verify",
        outcome: "allowed",
        actor: authority.auditActor,
        target: { type: "sender_identity", id: updated.id, label: updated.from_address },
        requestId: authority.requestId ?? undefined,
        metadata: {
          bindingId: request.bindingId,
          savesSentAutomatically: request.savesSentAutomatically,
          ...(filledSentFolderId ? { sentFolderId: filledSentFolderId } : {}),
          ...(authority.commandId ? { commandId: authority.commandId } : {}),
        },
      },
      tx,
    );
    await assertLeaseActive();
    return ok({ senderIdentityId: updated.id });
  });

/** The place of an identity's verification in its mailbox's provider lease line, kept from the request to its queued command. */
const senderVerificationWaiter = (senderIdentityId: string): string => `sender-verification:${senderIdentityId}`;

/**
 * Verifies the identity now when it is its turn at the mailbox's provider lease, or says when to
 * try again. A verification never runs next to a folder sync, another provider command, or a
 * lifecycle change of the same mailbox.
 */
export const attemptSenderVerification = async (
  request: SenderVerificationRequest,
  authority: SenderVerificationAuthority,
): Promise<ProviderOperationTurn<Result<{ senderIdentityId: string }>>> => {
  const record = await loadSenderVerification(request);
  if (!record) return { acquired: true, value: fail(err.notFound("Sender identity or provider binding")) };
  try {
    return await withMailboxProviderOperationTurn(
      {
        mailboxId: request.mailboxId,
        remoteResourceId: record.remote_resource_id,
        waiter: senderVerificationWaiter(request.senderIdentityId),
      },
      (assertLeaseActive) => performSenderVerification(request, authority, record.remote_resource_id, assertLeaseActive),
    );
  } catch (error) {
    return {
      acquired: true,
      value:
        (error as { code?: unknown } | null)?.code === "MAIL_PROVIDER_OPERATION_LEASE_LOST"
          ? fail(err.conflict("Provider state changed during sender verification; retry the operation"))
          : fail(err.internal("Failed to verify sender identity")),
    };
  }
};

export const queuedSenderVerificationTargetSchema = z.object({ senderIdentityId: z.string().uuid(), bindingId: z.string().uuid() });
/**
 * What a queued verification needs to run. Every reader of the mailbox's commands sees it, so it
 * holds no audit identity: the audit names the command's stored actor.
 */
export const queuedSenderVerificationPayloadSchema = z.object({
  verificationRecipient: z.string().min(3).max(320),
  savesSentAutomatically: z.boolean(),
  locale: z.string().max(35).nullable(),
});

const parseRecord = (value: JsonRecord | string): JsonRecord => (typeof value === "string" ? (JSON.parse(value) as JsonRecord) : value);

const codedError = (code: string, message: string, extra: JsonRecord = {}): Error => Object.assign(new Error(message), { code, ...extra });

/** The person behind a stored command, as the audit names them: its user, or the user a service account acts for. */
const commandAuditActor = async (userId: string | null): Promise<AuditActor> => {
  const user = userId ? await accounts.users.get({ id: userId }).catch(() => null) : null;
  return { userId, uid: user?.uid ?? null, provider: user?.provider ?? null, roles: user?.roles ?? [] };
};

/**
 * Runs a queued `verify_sender_identity` command for the maintenance runtime: its result, or an
 * error whose code the runtime records. `SYNC_BUSY` keeps the command queued in its place in the
 * lease line. A command that could not start within `SENDER_VERIFICATION_WAIT_MS` of its request
 * fails with `SENDER_VERIFICATION_TIMEOUT` and leaves the identity as it was.
 */
export const executeQueuedSenderVerification = async (
  command: StoredCommandAuthorization & { id: string; payload: JsonRecord | string },
): Promise<JsonRecord> => {
  const target = queuedSenderVerificationTargetSchema.parse(parseRecord(command.target));
  const payload = queuedSenderVerificationPayloadSchema.parse(parseRecord(command.payload));
  // A verification through the same binding since the request already did what it asks: one of
  // this command whose process stopped before it recorded the result, or another request that got
  // the lease first. It is confirmed without a second test message, also after the wait ran out.
  const [state] = await sql<{ expired: boolean; already_verified: boolean; delegated_user_id: string | null }[]>`
    SELECT
      c.created_at < now() - (${SENDER_VERIFICATION_WAIT_MS}::int * interval '1 millisecond') AS expired,
      c.delegated_user_id,
      EXISTS (
        SELECT 1
        FROM mail.sender_identities si
        JOIN mail.sender_identity_bindings identity_binding ON identity_binding.sender_identity_id = si.id
        JOIN mail.provider_bindings binding ON binding.id = identity_binding.binding_id
        JOIN mail.provider_connections connection ON connection.id = binding.connection_id
        WHERE si.id = ${target.senderIdentityId}::uuid
          AND si.mailbox_id = c.mailbox_id
          AND si.status = 'verified'
          AND identity_binding.binding_id = ${target.bindingId}::uuid
          AND identity_binding.revoked_at IS NULL
          AND identity_binding.verified_at >= c.created_at
          AND identity_binding.verified_secret_revision = connection.secret_revision
          AND identity_binding.saves_sent_automatically = ${payload.savesSentAutomatically}
      ) AS already_verified
    FROM mail.commands c
    WHERE c.id = ${command.id}::uuid
  `;
  if (state?.already_verified) return { senderIdentityId: target.senderIdentityId, verified: true };
  if (state?.expired) {
    throw codedError(
      "SENDER_VERIFICATION_TIMEOUT",
      `Provider work kept the mailbox busy for ${SENDER_VERIFICATION_WAIT_MS / 60_000} minutes; verify the sender identity again`,
    );
  }
  const outcome = await attemptSenderVerification(
    {
      mailboxId: command.mailbox_id,
      senderIdentityId: target.senderIdentityId,
      bindingId: target.bindingId,
      verificationRecipient: payload.verificationRecipient,
      savesSentAutomatically: payload.savesSentAutomatically,
      locale: payload.locale,
    },
    {
      authorize: async (db) =>
        (await commandStillAuthorized(command, "admin", db))
          ? ok(undefined)
          : fail(err.forbidden("Mailbox administration access was revoked before sender verification")),
      auditActor: await commandAuditActor(command.actor_kind === "user" ? command.actor_id : (state?.delegated_user_id ?? null)),
      requestId: null,
      commandId: command.id,
    },
  );
  if (!outcome.acquired) throw codedError("SYNC_BUSY", "Mail remote resource is busy", { retryAfterMs: outcome.retryAfterMs });
  if (!outcome.value.ok) throw codedError(outcome.value.error.code, outcome.value.error.message);
  return { senderIdentityId: outcome.value.data.senderIdentityId, verified: true };
};
