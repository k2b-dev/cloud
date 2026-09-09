import { err, fail, isServiceError, ok, type Result } from "@k2b/stdlib";
import { capabilityIdempotencyConflict } from "@k2b/cloud/contracts";
import { audit, logger, toPgTextArray, toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import {
  type ActorCommandInput,
  type ActorRef,
  type ComposeSafetyApproval,
  draftEditableContentInputSchema,
  type MailCommand,
  type MailCommandInput,
  type MaintenanceCommandInput,
  smtpTransportCapabilitiesSchema,
} from "../contracts";
import { withShortIdDb } from "../lib/short-id";
import { requireMailboxPermission } from "./access";
import { enqueueAttachmentExtractionsForMessage, logAttachmentExtractionEnqueueFailure } from "./attachment-extraction";
import { actorRefFromRequest, auditActorFromRequest, durableCredentialSnapshot, type MailRequestContext } from "./auth";
import { sha256Json } from "./canonical";
import { enqueueMailCommand } from "./command-runtime";
import { validateDraftComposeSafety } from "./compose-safety";
import { renderComposeDraft } from "./compose-templates";
import { invalidateDraftLeaseAfterSend } from "./draft-leases";
import { notifyMailInvalidations, publishMailCollaborationEvent, publishMailMailboxEvent } from "./events";
import { resolveMailExecution } from "./execution";
import { createBlobReadable } from "./message-blobs";
import { BASE_MAINTENANCE_KINDS, getOperatorActionEligibility } from "./operator-actions";
import { OUTBOX_DISPATCH_GRACE_SECONDS } from "./outbound-delivery";
import { materializeOutboundMessage, type OutboundMessageProjection } from "./outbound-message-projection";
import { measureMimeStream, outboundDraftSnapshotSchema } from "./outbound-mime";
import { activeSmtpMessageLimit, assertProviderMessageSize, loadBindingProviderLimits } from "./provider-limits";

const log = logger("mail:commands");
const internalDraftEditableContentInputSchema = draftEditableContentInputSchema.extend({ senderIdentityId: z.string().uuid() });

type DbCommand = {
  id: string;
  mailbox_id: string;
  kind: MailCommand["kind"];
  state: MailCommand["state"];
  actor_kind: ActorRef["kind"];
  actor_id: string | null;
  delegated_user_id: string | null;
  idempotency_key: string;
  request_hash: string;
  correlation_id: string | null;
  workflow_execution_generation: string | number | null;
  target: Record<string, unknown> | string;
  payload: Record<string, unknown> | string;
  selected_binding_id: string | null;
  rights_snapshot: Record<string, unknown> | string | null;
  transport_metadata: Record<string, unknown> | string;
  result: Record<string, unknown> | string;
  attempt: number;
  last_error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const commandColumns = sql`
  c.id,
  c.mailbox_id,
  c.kind,
  c.state,
  c.actor_kind,
  c.actor_id,
  c.delegated_user_id,
  c.idempotency_key,
  c.request_hash,
  c.correlation_id,
  c.workflow_execution_generation,
  c.target,
  c.payload,
  c.selected_binding_id,
  c.rights_snapshot,
  c.transport_metadata,
  c.result,
  c.attempt,
  c.last_error_message,
  c.created_at,
  c.updated_at
`;

const parseRecord = (value: Record<string, unknown> | string): Record<string, unknown> =>
  typeof value === "string" ? (JSON.parse(value) as Record<string, unknown>) : value;

const actorFromRow = (row: DbCommand): ActorRef => {
  if (row.actor_kind === "user" && row.actor_id) return { kind: "user", userId: row.actor_id };
  if (row.actor_kind === "service_account" && row.actor_id) {
    return { kind: "service_account", serviceAccountId: row.actor_id, delegatedUserId: row.delegated_user_id };
  }
  if (row.actor_kind === "workflow" && row.actor_id) return { kind: "workflow", workflowVersionId: row.actor_id };
  return { kind: "system" };
};

const mapCommand = (row: DbCommand): MailCommand => ({
  id: row.id,
  mailboxId: row.mailbox_id,
  kind: row.kind,
  state: row.state,
  actor: actorFromRow(row),
  idempotencyKey: row.idempotency_key,
  correlationId: row.correlation_id,
  target: parseRecord(row.target),
  payload: parseRecord(row.payload),
  selectedBindingId: row.selected_binding_id,
  rightsSnapshot: row.rights_snapshot ? parseRecord(row.rights_snapshot) : null,
  transportMetadata: parseRecord(row.transport_metadata),
  result: parseRecord(row.result),
  attempt: row.attempt,
  lastError: row.last_error_message,
  createdAt: (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)).toISOString(),
  updatedAt: (row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at)).toISOString(),
});

const normalizeCommands = async (commands: MailCommand[], db: typeof sql = sql): Promise<MailCommand[]> => {
  const remoteRefIds = commands.flatMap((command) => {
    const id = command.target.remoteMessageRefId;
    return typeof id === "string" ? [id] : [];
  });
  const remoteRefs =
    remoteRefIds.length === 0
      ? []
      : await db<{ id: string; message_id: string }[]>`
          SELECT id, message_id
          FROM mail.remote_message_refs
          WHERE id = ANY(${toPgUuidArray(remoteRefIds)}::uuid[])
        `;
  const messageIdByRemoteRef = new Map(remoteRefs.map((row) => [row.id, row.message_id]));
  return commands.map((command) => {
    let target = command.target;
    const remoteRefId = command.target.remoteMessageRefId;
    if (typeof remoteRefId === "string") {
      const messageId = messageIdByRemoteRef.get(remoteRefId);
      if (!messageId) throw new Error(`Missing Mail message for provider reference ${remoteRefId}`);
      const { remoteMessageRefId: _, ...resourceTarget } = target;
      target = { ...resourceTarget, messageId };
    }
    return { ...command, target };
  });
};

const normalizeCommand = async (command: MailCommand, db: typeof sql = sql): Promise<MailCommand> =>
  (await normalizeCommands([command], db))[0]!;

type PreparedActorCommand = {
  kind: ActorCommandInput["kind"];
  idempotencyKey: string;
  correlationId: string | null;
  target: Record<string, unknown>;
  payload: Record<string, unknown>;
  folderRequirements: Array<{ folderId: string; rights: string[] }>;
  senderIdentityId: string | null;
  remoteMessageRefId: string | null;
  sourceFolderId: string | null;
  draftId: string | null;
  expectedDraftRevision: number | null;
  safetyApproval: ComposeSafetyApproval | null;
  scheduledAt: string | null;
  undoSeconds: number;
  requiredPermission: "write" | "admin";
};

type DraftForOutbox = {
  conversation_id: string | null;
  to_addresses: unknown;
  cc_addresses: unknown;
  bcc_addresses: unknown;
  subject: string;
  body_markdown: string;
  body_format: "plain" | "markdown";
  priority: "low" | "normal" | "high";
  request_delivery_receipt: boolean;
  request_read_receipt: boolean;
  origin: "user" | "workflow";
  delivery_class: "normal" | "automatic_reply";
  revision: string | number;
  intent: "new" | "reply" | "reply_all" | "forward";
  display_name: string;
  sender_identity_id: string;
  from_address: string;
  reply_to: string | null;
  envelope_sender: string | null;
  vcard: string | null;
  identity_transport_revision: number | null;
  identity_transport_capabilities: unknown;
  identity_transport_verified_at: Date | string | null;
  parent_message_id: string | null;
  reference_ids: string[] | null;
  attachments: unknown;
};

const actorDatabaseId = (actor: ActorRef): string | null => {
  if (actor.kind === "user") return actor.userId;
  if (actor.kind === "service_account") return actor.serviceAccountId;
  if (actor.kind === "workflow") return actor.workflowVersionId;
  return null;
};

const commandActorMatches = (command: DbCommand, actor: ActorRef): boolean =>
  command.actor_kind === actor.kind && command.actor_id === actorDatabaseId(actor);

const resolveActorCommandInput = async (
  input: ActorCommandInput,
  mailboxId: string,
  db: typeof sql,
): Promise<Result<ActorCommandInput & { remoteMessageRefId?: string }>> => {
  const resolveProviderMessage = async (messageId: string, folderId: string): Promise<Result<string>> => {
    const rows = await db<{ id: string }[]>`
      SELECT DISTINCT remote_ref.id
      FROM mail.remote_message_refs remote_ref
      JOIN mail.message_placements placement ON placement.remote_message_ref_id = remote_ref.id
      WHERE remote_ref.message_id = ${messageId}::uuid
        AND remote_ref.folder_id = ${folderId}::uuid
        AND remote_ref.stale_at IS NULL
        AND placement.deleted_at IS NULL
      ORDER BY remote_ref.id
      LIMIT 2
    `;
    if (rows.length === 0) return fail(err.notFound("Message placement"));
    if (rows.length > 1) return fail(err.conflict("Message has more than one active placement in the selected folder"));
    return ok(rows[0]!.id);
  };
  if (input.kind === "move" || input.kind === "copy") {
    const { sourceFolderId, destinationFolderId } = input;
    const remoteMessageRefId = await resolveProviderMessage(input.messageId, sourceFolderId);
    return remoteMessageRefId.ok
      ? ok({ ...input, sourceFolderId, destinationFolderId, remoteMessageRefId: remoteMessageRefId.data })
      : remoteMessageRefId;
  }
  if (input.kind === "set_flags" || input.kind === "change_message_state" || input.kind === "delete") {
    const folderId = input.folderId;
    const remoteMessageRefId = await resolveProviderMessage((input as { messageId: string }).messageId, folderId);
    return remoteMessageRefId.ok
      ? ok({ ...input, folderId, remoteMessageRefId: remoteMessageRefId.data } as ActorCommandInput & { remoteMessageRefId: string })
      : remoteMessageRefId;
  }
  return ok(input);
};

const accessSubjectDatabaseId = (context: MailRequestContext): string =>
  context.accessSubject.type === "user" ? context.accessSubject.userId : context.accessSubject.serviceAccountId;

const prepareActorCommand = (input: ActorCommandInput & { remoteMessageRefId?: string }): Result<PreparedActorCommand> => {
  if ((input.kind === "move" || input.kind === "copy") && input.sourceFolderId === input.destinationFolderId) {
    return fail(err.badInput("Source and destination folders must differ"));
  }
  const base = {
    kind: input.kind,
    idempotencyKey: input.idempotencyKey.trim(),
    correlationId: input.correlationId?.trim() || null,
    senderIdentityId: null,
    remoteMessageRefId: null,
    sourceFolderId: null,
    draftId: null,
    expectedDraftRevision: null,
    safetyApproval: null,
    scheduledAt: null,
    undoSeconds: 0,
    requiredPermission: "write" as const,
  };
  if (input.kind === "set_flags") {
    if (!input.remoteMessageRefId) return fail(err.internal("Provider message reference was not resolved"));
    return ok({
      ...base,
      target: {
        remoteMessageRefId: input.remoteMessageRefId,
        folderId: input.folderId,
        expectedRemoteState: input.expectedRemoteState,
      },
      payload: { flags: [...new Set(input.flags.map((flag) => flag.trim()))].sort() },
      folderRequirements: [{ folderId: input.folderId, rights: ["write_flags"] }],
      remoteMessageRefId: input.remoteMessageRefId,
      sourceFolderId: input.folderId,
    });
  }
  if (input.kind === "change_message_state") {
    if (!input.remoteMessageRefId) return fail(err.internal("Provider message reference was not resolved"));
    return ok({
      ...base,
      target: {
        remoteMessageRefId: input.remoteMessageRefId,
        folderId: input.folderId,
        expectedRemoteState: input.expectedRemoteState,
      },
      payload: {
        addFlags: [...new Set(input.change.addFlags)].sort(),
        removeFlags: [...new Set(input.change.removeFlags)].sort(),
        addKeywords: [...new Set(input.change.addKeywords)].sort(),
        removeKeywords: [...new Set(input.change.removeKeywords)].sort(),
      },
      folderRequirements: [{ folderId: input.folderId, rights: ["write_flags"] }],
      remoteMessageRefId: input.remoteMessageRefId,
      sourceFolderId: input.folderId,
    });
  }
  if (input.kind === "move" || input.kind === "copy") {
    if (!input.remoteMessageRefId) return fail(err.internal("Provider message reference was not resolved"));
    return ok({
      ...base,
      target: {
        remoteMessageRefId: input.remoteMessageRefId,
        sourceFolderId: input.sourceFolderId,
        destinationFolderId: input.destinationFolderId,
        expectedRemoteState: input.expectedRemoteState,
      },
      payload: {},
      folderRequirements: [
        { folderId: input.sourceFolderId, rights: input.kind === "move" ? ["read", "move"] : ["read"] },
        { folderId: input.destinationFolderId, rights: ["insert"] },
      ],
      remoteMessageRefId: input.remoteMessageRefId,
      sourceFolderId: input.sourceFolderId,
    });
  }
  if (input.kind === "delete") {
    if (!input.remoteMessageRefId) return fail(err.internal("Provider message reference was not resolved"));
    return ok({
      ...base,
      target: {
        remoteMessageRefId: input.remoteMessageRefId,
        folderId: input.folderId,
        expectedRemoteState: input.expectedRemoteState,
      },
      payload: { deleted: true },
      folderRequirements: [{ folderId: input.folderId, rights: ["delete_messages"] }],
      remoteMessageRefId: input.remoteMessageRefId,
      sourceFolderId: input.folderId,
    });
  }
  if (input.kind === "create_folder") {
    return ok({
      ...base,
      requiredPermission: "admin",
      target: { parentFolderId: input.parentFolderId ?? null },
      payload: { name: input.name, subscribe: input.subscribe, showInSidebar: input.showInSidebar },
      folderRequirements: input.parentFolderId ? [{ folderId: input.parentFolderId, rights: [] }] : [],
    });
  }
  if (input.kind === "rename_folder" || input.kind === "delete_folder" || input.kind === "set_folder_subscription") {
    return ok({
      ...base,
      requiredPermission: "admin",
      target: { folderId: input.folderId },
      payload:
        input.kind === "rename_folder"
          ? { name: input.name }
          : input.kind === "set_folder_subscription"
            ? { subscribed: input.subscribed }
            : {},
      folderRequirements: [{ folderId: input.folderId, rights: [] }],
      sourceFolderId: input.folderId,
    });
  }
  const undoSeconds = input.scheduledAt ? 0 : input.undoSeconds;
  return ok({
    ...base,
    target: {
      draftId: input.draftId,
      expectedDraftRevision: input.expectedDraftRevision,
      senderIdentityId: input.senderIdentityId,
    },
    payload: {
      scheduledAt: input.scheduledAt ?? null,
      undoSeconds,
      safetyApproval: input.safetyApproval ?? null,
    },
    folderRequirements: [],
    senderIdentityId: input.senderIdentityId,
    draftId: input.draftId,
    expectedDraftRevision: input.expectedDraftRevision,
    safetyApproval: input.safetyApproval ?? null,
    scheduledAt: input.scheduledAt ?? null,
    undoSeconds,
  });
};

const validateCommandTargets = async (params: {
  mailboxId: string;
  prepared: PreparedActorCommand;
  draftOrigin: "user" | "workflow";
  db: typeof sql;
}): Promise<Result<void>> => {
  if (params.prepared.remoteMessageRefId && params.prepared.sourceFolderId) {
    const [messageRef] = await params.db<{ id: string }[]>`
      SELECT rmr.id
      FROM mail.remote_message_refs rmr
      JOIN mail.folders f ON f.id = rmr.folder_id
      JOIN mail.remote_resources rr ON rr.id = f.remote_resource_id
      WHERE rmr.id = ${params.prepared.remoteMessageRefId}::uuid
        AND rmr.folder_id = ${params.prepared.sourceFolderId}::uuid
        AND rr.mailbox_id = ${params.mailboxId}::uuid
        AND rmr.stale_at IS NULL
    `;
    if (!messageRef) return fail(err.notFound("Remote message"));
  }
  if (params.prepared.draftId && params.prepared.senderIdentityId) {
    const [draft] = await params.db<{ id: string; has_recipients: boolean; has_pending_attachments: boolean; revision: string | number }[]>`
      SELECT
        d.id,
        d.revision,
        jsonb_array_length(d.to_addresses)
          + jsonb_array_length(d.cc_addresses)
          + jsonb_array_length(d.bcc_addresses) > 0 AS has_recipients,
        EXISTS (
          SELECT 1
          FROM mail.draft_attachment_uploads upload
          WHERE upload.draft_id = d.id AND upload.state IN ('uploading', 'uploaded')
        ) AS has_pending_attachments
      FROM mail.drafts d
      JOIN mail.sender_identities si ON si.id = d.sender_identity_id
      WHERE d.id = ${params.prepared.draftId}::uuid
        AND d.mailbox_id = ${params.mailboxId}::uuid
        AND d.origin = ${params.draftOrigin}
        AND d.sender_identity_id = ${params.prepared.senderIdentityId}::uuid
        AND d.state = 'draft'
        AND si.status = 'verified'
      FOR UPDATE OF d
    `;
    if (!draft) return fail(err.badInput("Draft or sender identity is not ready for sending"));
    if (Number(draft.revision) !== params.prepared.expectedDraftRevision) {
      return fail({ code: "CONFLICT", message: "Draft changed before it could be sent", status: 409 });
    }
    if (draft.has_pending_attachments) {
      return fail({
        code: "CONFLICT",
        message: "Finish or cancel every attachment upload before sending the draft",
        status: 409,
      });
    }
    if (!draft.has_recipients) return fail(err.badInput("At least one recipient is required before sending"));
  }
  if (["create_folder", "rename_folder", "delete_folder", "set_folder_subscription"].includes(params.prepared.kind)) {
    const targetFolderId = (params.prepared.target.folderId ?? params.prepared.target.parentFolderId) as string | null | undefined;
    if (targetFolderId) {
      const [folder] = await params.db<{ id: string; role: string; discovery_state: string }[]>`
        SELECT folder.id, folder.role, folder.discovery_state
        FROM mail.folders folder
        JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
        WHERE folder.id = ${targetFolderId}::uuid
          AND resource.mailbox_id = ${params.mailboxId}::uuid
      `;
      if (!folder) return fail(err.notFound("Mail folder"));
      if (folder.discovery_state !== "active") return fail(err.badInput("Only an active remote folder can be administered"));
      if (params.prepared.kind === "delete_folder" && ["inbox", "all"].includes(folder.role)) {
        return fail(err.badInput("Protected provider folders cannot be deleted"));
      }
    }
  }
  return ok();
};

const createSendOutbox = async (params: {
  db: typeof sql;
  mailboxId: string;
  commandId: string;
  selectedBindingId: string;
  prepared: PreparedActorCommand;
  actor: ActorRef;
}): Promise<OutboundMessageProjection | null> => {
  const { prepared } = params;
  if (prepared.kind !== "send" || !prepared.draftId || !prepared.senderIdentityId) return null;
  const [draft] = await params.db<DraftForOutbox[]>`
    SELECT
      d.conversation_id,
      d.to_addresses,
      d.cc_addresses,
      d.bcc_addresses,
      d.subject,
      d.body_markdown,
      d.body_format,
      d.priority,
      d.request_delivery_receipt,
      d.request_read_receipt,
      d.origin,
      d.delivery_class,
      d.revision,
      d.intent,
      si.display_name,
      si.id AS sender_identity_id,
      si.from_address,
      si.reply_to,
      si.envelope_sender,
      si.vcard,
      identity_transport.revision AS identity_transport_revision,
      identity_transport.capabilities AS identity_transport_capabilities,
      identity_transport.last_verified_at AS identity_transport_verified_at,
      CASE WHEN d.intent IN ('reply', 'reply_all') THEN source.message_id ELSE NULL END AS parent_message_id,
      CASE WHEN d.intent IN ('reply', 'reply_all') THEN source.reference_ids ELSE ARRAY[]::text[] END AS reference_ids,
      COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', attachment.id,
              'blobId', attachment.blob_id,
              'filename', attachment.filename,
              'contentType', attachment.content_type,
              'byteLength', attachment.byte_length,
              'contentHash', attachment.content_hash
            ) ORDER BY attachment.position, attachment.id
          )
          FROM mail.draft_attachments attachment
          WHERE attachment.draft_id = d.id AND attachment.removed_at IS NULL
        ),
        '[]'::jsonb
      ) AS attachments
    FROM mail.drafts d
    JOIN mail.sender_identities si ON si.id = d.sender_identity_id
    LEFT JOIN mail.sender_identity_transports identity_transport
      ON identity_transport.sender_identity_id = si.id
     AND identity_transport.status = 'active'
     AND identity_transport.encrypted_secret IS NOT NULL
    LEFT JOIN mail.message_contents source ON source.id = d.source_message_id
    WHERE d.id = ${prepared.draftId}::uuid
      AND d.mailbox_id = ${params.mailboxId}::uuid
      AND d.sender_identity_id = ${prepared.senderIdentityId}::uuid
      AND d.revision = ${prepared.expectedDraftRevision}
      AND si.status = 'verified'
    FOR UPDATE OF d, si
  `;
  if (!draft) {
    const unavailable = err.badInput("Draft is no longer available");
    throw Object.assign(new Error(unavailable.message), unavailable);
  }
  const safety = await validateDraftComposeSafety({
    db: params.db,
    mailboxId: params.mailboxId,
    draftId: prepared.draftId,
    expectedRevision: prepared.expectedDraftRevision!,
    approval: prepared.safetyApproval ?? undefined,
  });
  if (!safety.ok) throw Object.assign(new Error(safety.error.message), safety.error);
  const content = internalDraftEditableContentInputSchema.safeParse({
    senderIdentityId: draft.sender_identity_id,
    to: draft.to_addresses,
    cc: draft.cc_addresses,
    bcc: draft.bcc_addresses,
    subject: draft.subject,
    body: draft.body_markdown,
    format: draft.body_format,
    priority: draft.priority,
    requestDeliveryReceipt: draft.request_delivery_receipt,
    requestReadReceipt: draft.request_read_receipt,
  });
  if (!content.success) {
    const invalid = err.badInput(content.error.issues[0]?.message ?? "Draft content is invalid");
    throw Object.assign(new Error(invalid.message), invalid);
  }
  const rendered = await renderComposeDraft({
    db: params.db,
    mailboxId: params.mailboxId,
    draft: content.data,
    actor: params.actor,
    renderLiquid: draft.origin === "user",
  });
  if (!rendered.ok) throw Object.assign(new Error(rendered.error.message), rendered.error);
  const senderDomain = draft.from_address.split("@")[1]?.toLowerCase() || "mail.invalid";
  const stableMessageId = `<${crypto.randomUUID()}@${senderDomain}>`;
  const references = [...(draft.reference_ids ?? []), ...(draft.parent_message_id ? [draft.parent_message_id] : [])].filter(
    (value, index, values) => value && values.indexOf(value) === index,
  );
  const scheduledAt = prepared.scheduledAt ? new Date(prepared.scheduledAt) : new Date();
  if (!Number.isFinite(scheduledAt.getTime())) {
    throw Object.assign(new Error("Invalid scheduled send time"), { code: "INVALID_SCHEDULE" });
  }
  if (prepared.scheduledAt && params.actor.kind !== "workflow" && scheduledAt.getTime() < Date.now() + 30_000) {
    const invalid = err.badInput("Choose a scheduled send time at least 30 seconds in the future");
    throw Object.assign(new Error(invalid.message), invalid);
  }
  const effectiveScheduledAt = prepared.scheduledAt ? scheduledAt : new Date();
  const undoUntil = new Date(effectiveScheduledAt.getTime() + prepared.undoSeconds * 1_000);
  const dispatchAt = prepared.scheduledAt
    ? effectiveScheduledAt
    : new Date(
        effectiveScheduledAt.getTime() + (prepared.undoSeconds > 0 ? prepared.undoSeconds + OUTBOX_DISPATCH_GRACE_SECONDS : 0) * 1_000,
      );
  const snapshot = outboundDraftSnapshotSchema.safeParse({
    revision: Number(draft.revision),
    from: { name: draft.display_name, address: draft.from_address },
    replyTo: draft.reply_to,
    envelopeFrom: draft.envelope_sender,
    useNullEnvelopeSender: draft.delivery_class === "automatic_reply",
    automaticReply: draft.delivery_class === "automatic_reply",
    priority: draft.priority,
    requestDeliveryReceipt: draft.request_delivery_receipt,
    requestReadReceipt: draft.request_read_receipt,
    receiptAddress: draft.from_address,
    vcard: draft.vcard,
    to: draft.to_addresses,
    cc: draft.cc_addresses,
    bcc: draft.bcc_addresses,
    subject: draft.subject,
    body: draft.body_markdown,
    format: draft.body_format,
    renderedText: rendered.data.text,
    renderedHtml: rendered.data.html,
    inReplyTo: draft.parent_message_id,
    references,
    attachments: draft.attachments,
  });
  if (!snapshot.success) {
    const message = snapshot.error.issues[0]?.message ?? "Rendered message is too large";
    throw Object.assign(new Error(message), err.badInput(message));
  }
  const mimeDate = new Date();
  const byteLength = await measureMimeStream({
    snapshot: snapshot.data,
    messageId: stableMessageId,
    date: mimeDate,
    openAttachment: createBlobReadable,
  });
  const providerLimits = await loadBindingProviderLimits(params.db, params.selectedBindingId);
  const rawIdentityTransportCapabilities =
    typeof draft.identity_transport_capabilities === "string"
      ? JSON.parse(draft.identity_transport_capabilities)
      : draft.identity_transport_capabilities;
  const identityTransportCapabilities =
    draft.identity_transport_revision === null ? null : smtpTransportCapabilitiesSchema.parse(rawIdentityTransportCapabilities);
  const smtpLimitBytes =
    draft.identity_transport_revision !== null
      ? (identityTransportCapabilities?.maxMessageBytes ?? null)
      : providerLimits
        ? activeSmtpMessageLimit(providerLimits)
        : null;
  const supportsDsn =
    draft.identity_transport_revision !== null ? identityTransportCapabilities?.dsn === true : providerLimits?.smtp.dsn === true;
  if (draft.request_delivery_receipt && !supportsDsn) {
    const unsupported = err.badInput("Delivery receipts are not supported by the selected SMTP server");
    throw Object.assign(new Error(unsupported.message), unsupported);
  }
  try {
    assertProviderMessageSize(byteLength, smtpLimitBytes);
  } catch (error) {
    const invalid = err.badInput(error instanceof Error ? error.message : "Message exceeds the provider limit");
    throw Object.assign(new Error(invalid.message), invalid);
  }
  const outboxRows = await withShortIdDb(
    params.db,
    "delivery",
    (db, shortId) => db<{ id: string }[]>`
    INSERT INTO mail.outbox_submissions (
      short_id,
      mailbox_id,
      draft_id,
      command_id,
      sender_identity_id,
      selected_binding_id,
      stable_message_id,
      state,
      requested_at,
      scheduled_at,
      undo_until,
      draft_snapshot,
      mime_date,
      preflight_byte_length,
      preflight_smtp_limit_bytes,
      preflight_checked_at,
      safety_review,
      selected_identity_transport_revision
    )
    VALUES (
      ${shortId},
      ${params.mailboxId}::uuid,
      ${prepared.draftId}::uuid,
      ${params.commandId}::uuid,
      ${prepared.senderIdentityId}::uuid,
      ${params.selectedBindingId}::uuid,
      ${stableMessageId},
      ${prepared.undoSeconds > 0 ? "undo_window" : "scheduled"},
      ${effectiveScheduledAt},
      ${dispatchAt},
      ${undoUntil},
      ${snapshot.data}::jsonb,
      ${mimeDate},
      ${byteLength},
      ${smtpLimitBytes},
      ${
        draft.identity_transport_revision === null
          ? smtpLimitBytes === null
            ? null
            : (providerLimits?.checkedAt ?? null)
          : draft.identity_transport_verified_at
      }::timestamptz,
      ${{
        fingerprint: safety.data.fingerprint,
        warningIds: safety.data.warnings.map((warning) => warning.id),
        approved: safety.data.warnings.length === 0 || prepared.safetyApproval !== null,
      }}::jsonb,
      ${draft.identity_transport_revision}
    )
    RETURNING id
  `,
  );
  const [outbox] = outboxRows;
  if (!outbox) throw new Error("Outbox submission insert returned no row");
  const projection = await materializeOutboundMessage({
    db: params.db,
    mailboxId: params.mailboxId,
    outboxId: outbox.id,
    stableMessageId,
    conversationId: draft.conversation_id,
    snapshot: snapshot.data,
    internalDate: effectiveScheduledAt,
    byteLength,
  });
  await params.db`
    UPDATE mail.drafts
    SET
      state = 'scheduled',
      last_editor_kind = (SELECT actor_kind FROM mail.commands WHERE id = ${params.commandId}::uuid),
      last_editor_id = (SELECT actor_id FROM mail.commands WHERE id = ${params.commandId}::uuid),
      updated_at = now()
    WHERE id = ${prepared.draftId}::uuid
  `;
  return projection;
};

type CreateActorCommandParams = {
  context: MailRequestContext;
  mailboxId: string;
  input: ActorCommandInput;
  enqueue?: boolean;
};

type CreateActorCommandInternalParams = Omit<CreateActorCommandParams, "context"> & {
  context: MailRequestContext | null;
  actorOverride?: ActorRef;
  beforeCreate?: (tx: typeof sql) => Promise<{ workflowExecutionGeneration: number } | void>;
  afterCreate?: (tx: typeof sql, command: MailCommand) => Promise<void>;
};

const createActorCommandInTransaction = async (params: CreateActorCommandInternalParams, tx: typeof sql): Promise<Result<MailCommand>> => {
  const resolved = await resolveActorCommandInput(params.input, params.mailboxId, tx);
  if (!resolved.ok) return resolved;
  const preparedResult = prepareActorCommand(resolved.data);
  if (!preparedResult.ok) return preparedResult;
  const prepared = preparedResult.data;
  const requestHash = sha256Json({ kind: prepared.kind, target: prepared.target, payload: prepared.payload });
  if (!params.context && params.actorOverride?.kind !== "workflow") {
    return fail(err.forbidden("Only an activated workflow may create a mailbox-owned command"));
  }
  const initiator = params.context ? actorRefFromRequest(params.context) : null;
  const actor = params.actorOverride ?? initiator;
  if (!actor) return fail(err.unauthenticated());
  const credential = params.context
    ? durableCredentialSnapshot(params.context)
    : { scopes: [], credentialId: null, credentialExpiresAt: null };
  if (!credential) return fail(err.forbidden("Durable Mail work requires a current service credential"));

  const [mailbox] = await tx<{ id: string }[]>`
    SELECT id FROM mail.mailboxes WHERE id = ${params.mailboxId}::uuid AND deleted_at IS NULL FOR UPDATE
  `;
  if (!mailbox) return fail(err.notFound("Mailbox"));
  if (params.context) {
    const permission = await requireMailboxPermission(params.context, params.mailboxId, prepared.requiredPermission, tx);
    if (!permission.ok) return permission;
  }
  const creationFence = await params.beforeCreate?.(tx);
  if (
    actor.kind === "workflow" &&
    (!creationFence || !Number.isSafeInteger(creationFence.workflowExecutionGeneration) || creationFence.workflowExecutionGeneration < 1)
  ) {
    return fail(err.internal("Workflow command is missing its execution fence"));
  }
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${params.mailboxId}:${prepared.kind}:${stableTargetKey(prepared.target)}`}, 0))`;

  const [existing] = await tx<DbCommand[]>`
    SELECT ${commandColumns}
    FROM mail.commands c
    WHERE c.mailbox_id = ${params.mailboxId}::uuid AND c.idempotency_key = ${prepared.idempotencyKey}
    FOR UPDATE
  `;
  if (existing) {
    if (!commandActorMatches(existing, actor)) return fail(capabilityIdempotencyConflict("Idempotency key is already in use"));
    if (
      actor.kind === "workflow" &&
      Number(existing.workflow_execution_generation) !== creationFence?.workflowExecutionGeneration &&
      !["confirmed", "failed", "cancelled", "reconciled", "needs_attention"].includes(existing.state)
    ) {
      return fail(err.conflict("Workflow command belongs to a stale execution generation"));
    }
    return existing.request_hash === requestHash
      ? ok(mapCommand(existing))
      : fail(capabilityIdempotencyConflict("Idempotency key with a different mail command"));
  }

  const targets = await validateCommandTargets({
    mailboxId: params.mailboxId,
    prepared,
    draftOrigin: actor.kind === "workflow" ? "workflow" : "user",
    db: tx,
  });
  if (!targets.ok) return targets;
  const execution = await resolveMailExecution({
    mailboxId: params.mailboxId,
    operation: params.context ? (prepared.kind === "send" ? "actorSend" : "actorMutation") : "automation",
    context: params.context,
    folderRequirements: prepared.folderRequirements,
    senderIdentityId: prepared.senderIdentityId,
    db: tx,
  });
  if (!execution.ok) return execution;
  if (!execution.data.bindingId) return fail(err.forbidden("A remote mutation requires an active provider binding"));

  const [row] = await tx<DbCommand[]>`
    INSERT INTO mail.commands AS c (
      mailbox_id,
      kind,
      actor_kind,
      actor_id,
      delegated_user_id,
      idempotency_key,
      request_hash,
      correlation_id,
      workflow_execution_generation,
      target,
      payload,
      selected_binding_id,
      selected_secret_revision,
      rights_snapshot,
      transport_metadata,
      initiator_actor_kind,
      initiator_actor_id,
      access_subject_kind,
      access_subject_id,
      credential_scopes,
      credential_id,
      credential_expires_at
    )
    VALUES (
      ${params.mailboxId}::uuid,
      ${prepared.kind},
      ${actor.kind},
      ${actorDatabaseId(actor)}::uuid,
      ${actor.kind === "service_account" ? actor.delegatedUserId : null}::uuid,
      ${prepared.idempotencyKey},
      ${requestHash},
      ${prepared.correlationId},
      ${actor.kind === "workflow" ? creationFence?.workflowExecutionGeneration : null},
      ${prepared.target}::jsonb,
      ${prepared.payload}::jsonb,
      ${execution.data.bindingId}::uuid,
      ${execution.data.secretRevision},
      ${execution.data.rightsSnapshot}::jsonb,
      ${{ sentDelivery: execution.data.sentDelivery }}::jsonb,
      ${initiator?.kind ?? null},
      ${initiator ? actorDatabaseId(initiator) : null}::uuid,
      ${params.context?.accessSubject.type ?? "system"},
      ${params.context ? accessSubjectDatabaseId(params.context) : null}::uuid,
      ${toPgTextArray(credential.scopes)}::text[],
      ${credential.credentialId}::uuid,
      ${credential.credentialExpiresAt}::timestamptz
    )
    RETURNING ${commandColumns}
  `;
  if (!row) throw new Error("Mail command insert returned no row");
  let command = mapCommand(row);
  await params.afterCreate?.(tx, command);
  const projection = await createSendOutbox({
    db: tx,
    mailboxId: params.mailboxId,
    commandId: row.id,
    selectedBindingId: execution.data.bindingId,
    prepared,
    actor,
  });
  if (projection) {
    const result = {
      ...command.result,
      outboxSubmissionId: projection.outboxId,
      outboundMessageId: projection.messageId,
      conversationId: projection.conversationId,
    };
    await tx`
      UPDATE mail.commands
      SET result = ${result}::jsonb
      WHERE id = ${command.id}::uuid
    `;
    command = { ...command, result };
  }
  await tx`
    INSERT INTO mail.activity_events (
      mailbox_id, command_id, actor_kind, actor_id, action, outcome, target_type, target_id, metadata
    )
    VALUES (
      ${params.mailboxId}::uuid,
      ${row.id}::uuid,
      ${actor.kind},
      ${actorDatabaseId(actor)}::uuid,
      ${`command.${prepared.kind}`},
      'requested',
      'command',
      ${row.id}::uuid,
      ${{
        selectedBindingId: execution.data.bindingId,
        correlationId: prepared.correlationId,
        scheduledAt: prepared.scheduledAt ?? null,
        undoSeconds: prepared.undoSeconds ?? null,
      }}::jsonb
    )
  `;
  await audit.record(
    {
      action: `mail.command.${prepared.kind}.request`,
      outcome: "allowed",
      actor: params.context ? auditActorFromRequest(params.context) : null,
      target: { type: "mailbox", id: params.mailboxId },
      requestId: params.context?.requestId ?? `mail-workflow:${actor.kind === "workflow" ? actor.workflowVersionId : row.id}`,
      metadata: {
        commandId: row.id,
        selectedBindingId: execution.data.bindingId,
        target: prepared.target,
        scheduledAt: prepared.scheduledAt ?? null,
        undoSeconds: prepared.undoSeconds ?? null,
        workflowVersionId: actor.kind === "workflow" ? actor.workflowVersionId : null,
      },
    },
    tx,
  );
  return ok(command);
};

const publishCreatedOutboundProjection = async (command: MailCommand): Promise<void> => {
  if (command.kind !== "send") return;
  const messageId = command.result.outboundMessageId;
  const conversationId = command.result.conversationId;
  const outboxId = command.result.outboxSubmissionId;
  if (typeof messageId !== "string" || typeof conversationId !== "string" || typeof outboxId !== "string") return;
  await publishMailCollaborationEvent({
    mailboxId: command.mailboxId,
    conversationId,
    reason: "outbound",
    targetId: messageId,
    activityId: `outbound-message-created:${outboxId}`,
  });
  await enqueueAttachmentExtractionsForMessage(messageId).catch((error) => {
    logAttachmentExtractionEnqueueFailure(messageId, error);
  });
};

export const enqueueCreatedActorCommands = async (commands: MailCommand[]): Promise<void> => {
  if (commands.length > 0) await notifyMailInvalidations();
  await Promise.all(
    commands.map(async (command) => {
      await enqueueMailCommand(command.id, command.kind).catch(() => undefined);
      await publishCreatedOutboundProjection(command);
    }),
  );
};

const invalidateSentDraftLeases = async (commands: MailCommand[]): Promise<void> => {
  for (const command of commands) {
    if (command.kind !== "send") continue;
    const draftId = command.target.draftId;
    if (typeof draftId !== "string") continue;
    const invalidated = await invalidateDraftLeaseAfterSend(draftId);
    if (!invalidated.ok) {
      log.warn("Failed to invalidate a consumed Mail draft lease", {
        draftId,
        code: invalidated.error.code,
      });
    }
  }
};

const createActorCommandWithActor = async (params: CreateActorCommandInternalParams): Promise<Result<MailCommand>> => {
  try {
    const result = await sql.begin((tx) => createActorCommandInTransaction(params, tx));
    if (result.ok) await notifyMailInvalidations();
    if (result.ok) await invalidateSentDraftLeases([result.data]);
    if (result.ok && params.enqueue !== false) await enqueueMailCommand(result.data.id, result.data.kind).catch(() => undefined);
    if (result.ok) await publishCreatedOutboundProjection(result.data);
    if (result.ok && params.input.kind === "send" && params.input.scheduledAt) {
      await publishMailMailboxEvent({
        mailboxId: params.mailboxId,
        conversationId: null,
        reason: "scheduled_send",
        targetId: result.data.id,
        activityId: `scheduled-send-created:${result.data.id}`,
      });
    }
    return result.ok ? ok(await normalizeCommand(result.data)) : result;
  } catch (error) {
    if (isServiceError(error)) return fail(error);
    log.error("Failed to create mail command", {
      error: error instanceof Error ? error.message : String(error),
    });
    return fail(err.internal("Failed to create mail command"));
  }
};

export const createActorCommand = (params: CreateActorCommandParams): Promise<Result<MailCommand>> => createActorCommandWithActor(params);

export const createActorCommandsInTransaction = async (
  params: {
    context: MailRequestContext;
    mailboxId: string;
    inputs: ActorCommandInput[];
    afterCreate?: (tx: typeof sql, commands: MailCommand[]) => Promise<void>;
  },
  tx: typeof sql,
): Promise<MailCommand[]> => {
  const commands: MailCommand[] = [];
  for (const input of params.inputs) {
    const command = await createActorCommandInTransaction(
      { context: params.context, mailboxId: params.mailboxId, input, enqueue: false },
      tx,
    );
    if (!command.ok) throw command.error;
    commands.push(command.data);
  }
  await params.afterCreate?.(tx, commands);
  return commands;
};

export const createWorkflowCommandInTransaction = (
  params: {
    context: MailRequestContext | null;
    mailboxId: string;
    workflowVersionId: string;
    input: ActorCommandInput;
    beforeCreate: (tx: typeof sql) => Promise<{ workflowExecutionGeneration: number }>;
    afterCreate?: (tx: typeof sql, command: MailCommand) => Promise<void>;
  },
  tx: typeof sql,
): Promise<Result<MailCommand>> =>
  createActorCommandInTransaction(
    {
      ...params,
      enqueue: false,
      actorOverride: { kind: "workflow", workflowVersionId: params.workflowVersionId },
    },
    tx,
  );

export const enqueueCreatedWorkflowCommand = async (command: MailCommand, input: ActorCommandInput): Promise<void> => {
  await notifyMailInvalidations();
  await enqueueMailCommand(command.id, command.kind).catch(() => undefined);
  await publishCreatedOutboundProjection(command);
  if (input.kind === "send" && input.scheduledAt) {
    await publishMailMailboxEvent({
      mailboxId: command.mailboxId,
      conversationId: null,
      reason: "scheduled_send",
      targetId: command.id,
      activityId: `scheduled-send-created:${command.id}`,
    });
  }
};

export const createWorkflowCommand = async (params: {
  context: MailRequestContext | null;
  mailboxId: string;
  workflowVersionId: string;
  input: ActorCommandInput;
  enqueue?: boolean;
  beforeCreate: (tx: typeof sql) => Promise<{ workflowExecutionGeneration: number }>;
  afterCreate?: (tx: typeof sql, command: MailCommand) => Promise<void>;
}): Promise<Result<MailCommand>> => {
  const result = await sql.begin((tx) => createWorkflowCommandInTransaction(params, tx));
  if (result.ok && params.enqueue === false) await notifyMailInvalidations();
  if (result.ok && params.enqueue !== false) await enqueueCreatedWorkflowCommand(result.data, params.input);
  return result.ok ? ok(await normalizeCommand(result.data)) : result;
};

export const createActorCommands = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  inputs: ActorCommandInput[];
  afterCreate?: (tx: typeof sql, commands: MailCommand[]) => Promise<void>;
}): Promise<Result<MailCommand[]>> => {
  try {
    const result = await sql.begin(async (tx) => {
      const commands = await createActorCommandsInTransaction(params, tx);
      return ok(commands);
    });
    if (result.ok) await invalidateSentDraftLeases(result.data);
    if (result.ok) await enqueueCreatedActorCommands(result.data);
    return result.ok ? ok(await normalizeCommands(result.data)) : result;
  } catch (error) {
    if (isServiceError(error)) return fail(error);
    return fail(err.internal("Failed to create mail commands"));
  }
};

const stableTargetKey = (target: Record<string, unknown>): string => sha256Json(target);

const prepareMaintenanceCommand = (
  input: MaintenanceCommandInput,
): { target: Record<string, unknown>; payload: Record<string, unknown> } => {
  if (input.kind === "sync_folder" || input.kind === "rebuild_folder") {
    return { target: { folderId: input.folderId }, payload: {} };
  }
  if (input.kind === "verify_binding") return { target: { bindingId: input.bindingId }, payload: { allowCredentialRevision: true } };
  if (input.kind === "discover_folders") return { target: { bindingId: input.bindingId ?? null }, payload: {} };
  if (input.kind === "reconcile_effect" || input.kind === "retry_command" || input.kind === "cancel_command") {
    return { target: { commandId: input.commandId }, payload: {} };
  }
  return { target: {}, payload: {} };
};

const validateMaintenanceTarget = async (params: {
  db: typeof sql;
  mailboxId: string;
  input: MaintenanceCommandInput;
}): Promise<Result<void>> => {
  // Provider-read maintenance commands are durable requests and may validly
  // resolve to a no-op when the mailbox is paused or already reconciled. Their
  // runtime rechecks current access and provider state before every effect.
  if (BASE_MAINTENANCE_KINDS.includes(params.input.kind as (typeof BASE_MAINTENANCE_KINDS)[number])) return ok();
  const action = await getOperatorActionEligibility({ db: params.db, mailboxId: params.mailboxId, input: params.input });
  return action.eligible ? ok() : fail(err.conflict(action.reason ?? "Mail operator action is not currently eligible"));
};

export const createMaintenanceCommand = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  input: MaintenanceCommandInput;
  enqueue?: boolean;
}): Promise<Result<MailCommand>> => {
  const actor = actorRefFromRequest(params.context);
  const credential = durableCredentialSnapshot(params.context);
  if (!credential) return fail(err.forbidden("Durable Mail work requires a current service credential"));

  try {
    const result = await sql.begin(async (tx) => {
      const [mailbox] = await tx<{ id: string }[]>`
        SELECT id FROM mail.mailboxes WHERE id = ${params.mailboxId}::uuid AND deleted_at IS NULL FOR UPDATE
      `;
      if (!mailbox) return fail(err.notFound("Mailbox"));
      const permission = await requireMailboxPermission(params.context, params.mailboxId, "admin", tx);
      if (!permission.ok) return permission;
      const input = params.input;
      const prepared = prepareMaintenanceCommand(input);
      const requestHash = sha256Json({ kind: input.kind, target: prepared.target, payload: prepared.payload });

      const [existing] = await tx<DbCommand[]>`
        SELECT ${commandColumns}
        FROM mail.commands c
        WHERE c.mailbox_id = ${params.mailboxId}::uuid AND c.idempotency_key = ${input.idempotencyKey.trim()}
        FOR UPDATE
      `;
      if (existing) {
        if (!commandActorMatches(existing, actor)) return fail(capabilityIdempotencyConflict("Idempotency key is already in use"));
        return existing.request_hash === requestHash
          ? ok(mapCommand(existing))
          : fail(capabilityIdempotencyConflict("Idempotency key with a different mail command"));
      }
      const target = await validateMaintenanceTarget({ db: tx, mailboxId: params.mailboxId, input });
      if (!target.ok) return target;

      const [row] = await tx<DbCommand[]>`
        INSERT INTO mail.commands AS c (
          mailbox_id, kind, actor_kind, actor_id, delegated_user_id, idempotency_key,
          request_hash, correlation_id, target, payload, transport_metadata,
          initiator_actor_kind, initiator_actor_id,
          access_subject_kind, access_subject_id, credential_scopes, credential_id, credential_expires_at
        )
        VALUES (
          ${params.mailboxId}::uuid,
          ${input.kind},
          ${actor.kind},
          ${actorDatabaseId(actor)}::uuid,
          ${actor.kind === "service_account" ? actor.delegatedUserId : null}::uuid,
          ${input.idempotencyKey.trim()},
          ${requestHash},
          ${input.correlationId?.trim() || null},
          ${prepared.target}::jsonb,
          ${prepared.payload}::jsonb,
          '{}'::jsonb,
          ${actor.kind},
          ${actorDatabaseId(actor)}::uuid,
          ${params.context.accessSubject.type},
          ${accessSubjectDatabaseId(params.context)}::uuid,
          ${toPgTextArray(credential.scopes)}::text[],
          ${credential.credentialId}::uuid,
          ${credential.credentialExpiresAt}::timestamptz
        )
        RETURNING ${commandColumns}
      `;
      if (!row) throw new Error("Mail maintenance command insert returned no row");
      await tx`
        INSERT INTO mail.activity_events (
          mailbox_id, command_id, actor_kind, actor_id, action, outcome, target_type, target_id, metadata
        )
        VALUES (
          ${params.mailboxId}::uuid,
          ${row.id}::uuid,
          ${actor.kind},
          ${actorDatabaseId(actor)}::uuid,
          ${`command.${input.kind}`},
          'requested',
          'command',
          ${row.id}::uuid,
          ${{ correlationId: input.correlationId ?? null }}::jsonb
        )
      `;
      await audit.record(
        {
          action: `mail.maintenance.${input.kind}.request`,
          outcome: "allowed",
          actor: auditActorFromRequest(params.context),
          target: { type: "mailbox", id: params.mailboxId },
          requestId: params.context.requestId,
          metadata: { commandId: row.id, target: prepared.target },
        },
        tx,
      );
      return ok(mapCommand(row));
    });
    if (result.ok) await notifyMailInvalidations();
    if (result.ok && params.enqueue !== false) await enqueueMailCommand(result.data.id, result.data.kind).catch(() => undefined);
    return result;
  } catch (error) {
    if (isServiceError(error)) return fail(error);
    return fail(err.internal("Failed to create mail maintenance command"));
  }
};

export const createMailCommand = (params: {
  context: MailRequestContext;
  mailboxId: string;
  input: MailCommandInput;
  enqueue?: boolean;
}): Promise<Result<MailCommand>> => {
  const actorKinds: ReadonlySet<string> = new Set([
    "set_flags",
    "change_message_state",
    "move",
    "copy",
    "delete",
    "create_folder",
    "rename_folder",
    "delete_folder",
    "set_folder_subscription",
    "send",
  ]);
  const isActorCommand = (input: MailCommandInput): input is ActorCommandInput => actorKinds.has(input.kind);
  return isActorCommand(params.input)
    ? createActorCommand({ ...params, input: params.input })
    : createMaintenanceCommand({ ...params, input: params.input });
};

export const getCommand = async (context: MailRequestContext, mailboxId: string, commandId: string): Promise<Result<MailCommand>> => {
  const access = await resolveMailExecution({ mailboxId, operation: "actorRead", context });
  if (!access.ok) return access;
  const [row] = await sql<DbCommand[]>`
    SELECT ${commandColumns}
    FROM mail.commands c
    WHERE c.id = ${commandId}::uuid AND c.mailbox_id = ${mailboxId}::uuid
  `;
  return row ? ok(await normalizeCommand(mapCommand(row))) : fail(err.notFound("Mail command"));
};

export const listCommands = async (context: MailRequestContext, mailboxId: string, limit = 50): Promise<Result<MailCommand[]>> => {
  const access = await resolveMailExecution({ mailboxId, operation: "actorRead", context });
  if (!access.ok) return access;
  const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
  const rows = await sql<DbCommand[]>`
    SELECT ${commandColumns}
    FROM mail.commands c
    WHERE c.mailbox_id = ${mailboxId}::uuid
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT ${boundedLimit}
  `;
  return ok(await normalizeCommands(rows.map(mapCommand)));
};
