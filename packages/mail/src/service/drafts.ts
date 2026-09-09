import { err, fail, ok, type Result } from "@k2b/stdlib";
import { capabilityIdempotencyConflict } from "@k2b/cloud/contracts";
import { logger } from "@k2b/cloud/services";
import { sql } from "bun";
import { convert } from "html-to-text";
import { z } from "zod";
import {
  type ActorRef,
  type ConversationDraftSummary,
  type CreateDeliveryRecoveryDraftInput,
  createDeliveryRecoveryDraftInputSchema,
  type DeriveDraftFromMessageInput,
  type DraftAttachment,
  type DraftContentInput,
  type DraftDeliveryClass,
  type DraftEditableContent,
  type DraftEditableContentInput,
  type DraftIntent,
  type DraftRecoveryCopy,
  type DraftSeedOrigin,
  deriveDraftFromMessageInputSchema,
  draftContentInputSchema,
  draftEditableContentInputSchema,
  MAX_DRAFT_ATTACHMENT_BYTES,
  type MailAddress,
  type MailComposeFormat,
  type MailDraft,
  type MailDraftSeed,
  type MailPriority,
  type MaterializeDraftSeedInput,
} from "../contracts";
import { withShortIdDb } from "../lib/short-id";
import { deriveReplyAddressObjects } from "../reply-recipients";
import { requireMailboxPermission } from "./access";
import { actorRefFromRequest, type MailRequestContext } from "./auth";
import { sha256Json } from "./canonical";
import { resolveDefaultSignatureSource } from "./compose-templates";
import { applyConversationReferenceToReplySubjectInTransaction } from "./conversation-reference";
import { withOwnedDraftLease } from "./draft-leases";
import { enqueueDraftProjection, enqueueDraftProjectionSnapshot, queueDraftProjectionInTransaction } from "./draft-provider-projection";
import { notifyMailInvalidations } from "./events";
import type { AttachmentDownload } from "./messages";

const InternalIdSchema = z.string().uuid();
const internalDraftEditableContentSchema = draftEditableContentInputSchema.extend({ senderIdentityId: InternalIdSchema });
const internalDraftContentSchema = draftContentInputSchema.extend({
  senderIdentityId: InternalIdSchema,
  conversationId: InternalIdSchema.nullable().optional(),
  sourceMessageId: InternalIdSchema.nullable().optional(),
});
const internalDeriveDraftFromMessageInputSchema = deriveDraftFromMessageInputSchema.extend({ senderIdentityId: InternalIdSchema });
const internalCreateDeliveryRecoveryDraftInputSchema = createDeliveryRecoveryDraftInputSchema;
const internalDraftSeedOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("compose"), input: internalDraftContentSchema }).strict(),
  z
    .object({
      kind: z.literal("derive"),
      messageId: InternalIdSchema,
      input: internalDeriveDraftFromMessageInputSchema.omit({ idempotencyKey: true }),
    })
    .strict(),
]);
const internalMaterializeDraftSeedInputSchema = z
  .object({
    idempotencyKey: z.string().uuid(),
    origin: internalDraftSeedOriginSchema,
    draft: internalDraftEditableContentSchema,
  })
  .strict();

type DraftActor = Extract<ActorRef, { kind: "user" | "service_account" | "workflow" | "system" }>;
type MutableActor = Extract<DraftActor, { kind: "user" | "service_account" }>;
const log = logger("mail:drafts");

const wakeDraftProjection = async <T extends { id: string }>(result: Result<T>): Promise<Result<T>> => {
  if (!result.ok) return result;
  try {
    await enqueueDraftProjection(result.data.id);
  } catch (error) {
    log.warn("Immediate draft projection enqueue failed; the reconciliation sweep will retry it", {
      draftId: result.data.id,
      error,
    });
  }
  return result;
};

type DbDraft = {
  id: string;
  mailbox_id: string;
  conversation_id: string | null;
  lifecycle_conversation_id?: string | null;
  intent: DraftIntent;
  source_message_id: string | null;
  derived_from_message_id: string | null;
  derivation_kind: MailDraft["derivationKind"];
  sender_identity_id: string;
  author_kind: DraftActor["kind"];
  author_id: string | null;
  last_editor_kind: DraftActor["kind"];
  last_editor_id: string | null;
  last_editor_display_name?: string;
  to_addresses: MailDraft["to"] | string;
  cc_addresses: MailDraft["cc"] | string;
  bcc_addresses: MailDraft["bcc"] | string;
  subject: string;
  body_markdown: string;
  body_format: MailDraft["format"];
  priority: MailPriority;
  request_delivery_receipt: boolean;
  request_read_receipt: boolean;
  delivery_class: DraftDeliveryClass;
  revision: string | number;
  state: MailDraft["state"];
  attachments: DraftAttachment[] | string;
  recovery_copy_count: string | number;
  created_at: Date | string;
  updated_at: Date | string;
};

type DbRecoveryCopy = {
  id: string;
  draft_id: string;
  base_revision: string | number;
  content: DraftEditableContent | string;
  creator_kind: DraftActor["kind"];
  creator_id: string | null;
  has_attachment_snapshot: boolean;
  created_at: Date | string;
  restored_at: Date | string | null;
  resulting_revision: string | number | null;
};

type DbConversationDraftSummary = {
  id: string;
  short_id: string;
  intent: DraftIntent;
  subject: string;
  body_preview_source: string;
  created_by_display_name: string;
  updated_at: Date | string;
};

const DRAFT_BODY_PREVIEW_SOURCE_LENGTH = 1_024;
const DRAFT_BODY_PREVIEW_LENGTH = 240;

const draftColumns = sql`
  d.id,
  d.mailbox_id,
  d.conversation_id,
  d.intent,
  d.source_message_id,
  d.derived_from_message_id,
  d.derivation_kind,
  d.sender_identity_id,
  d.author_kind,
  d.author_id,
  d.last_editor_kind,
  d.last_editor_id,
  d.to_addresses,
  d.cc_addresses,
  d.bcc_addresses,
  d.subject,
  d.body_markdown,
  d.body_format,
  d.priority,
  d.request_delivery_receipt,
  d.request_read_receipt,
  d.delivery_class,
  d.revision,
  d.state,
  COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', attachment.id,
          'filename', attachment.filename,
          'contentType', attachment.content_type,
          'byteLength', attachment.byte_length,
          'contentHash', attachment.content_hash,
          'position', attachment.position,
          'createdAt', to_char(attachment.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ) ORDER BY attachment.position, attachment.id
      )
      FROM mail.draft_attachments attachment
      WHERE attachment.draft_id = d.id AND attachment.removed_at IS NULL
    ),
    '[]'::jsonb
  ) AS attachments,
  (
    SELECT COUNT(*)::int
    FROM mail.draft_recovery_copies recovery
    WHERE recovery.draft_id = d.id AND recovery.restored_at IS NULL
  ) AS recovery_copy_count,
  d.created_at,
  d.updated_at
`;

const recoveryColumns = sql`
  recovery.id,
  recovery.draft_id,
  recovery.base_revision,
  recovery.content,
  recovery.creator_kind,
  recovery.creator_id,
  recovery.has_attachment_snapshot,
  recovery.created_at,
  recovery.restored_at,
  recovery.resulting_revision
`;

const parseArray = <T>(value: T[] | string): T[] => (typeof value === "string" ? (JSON.parse(value) as T[]) : value);
const parseRecord = <T>(value: T | string): T => (typeof value === "string" ? (JSON.parse(value) as T) : value);
const toIso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();
const draftBodyPreview = (value: string): string => value.replace(/\s+/gu, " ").trim().slice(0, DRAFT_BODY_PREVIEW_LENGTH);
const appendSignature = (body: string, signature: string | null, intent: DraftIntent): string => {
  if (!signature) return body;
  if (intent === "new") return [body.trimEnd(), signature].filter(Boolean).join("\n\n");
  const lines = body.split("\n");
  const quotedAt = lines.findIndex(
    (line, index) =>
      line.startsWith(">") ||
      line === "---------- Forwarded message ----------" ||
      (/\bwrote:\s*$/iu.test(line) && lines.slice(index + 1).some((candidate) => candidate.startsWith(">"))),
  );
  if (quotedAt < 0) return [body.trimEnd(), signature].filter(Boolean).join("\n\n");
  const reply = lines.slice(0, quotedAt).join("\n").trimEnd();
  const history = lines.slice(quotedAt).join("\n").trimStart();
  return [reply, signature, history].filter(Boolean).join("\n\n");
};
const reusableMessageBody = (plainText: string | null, sanitizedHtml: string | null): string => {
  if (plainText?.trim()) return plainText.trimEnd();
  if (!sanitizedHtml) return "";
  try {
    return convert(sanitizedHtml, {
      wordwrap: false,
      selectors: [{ selector: "a", options: { hideLinkHrefIfSameAsText: true } }],
    }).trimEnd();
  } catch {
    return "";
  }
};

const mutableActor = (context: MailRequestContext): MutableActor | null => {
  const actor = actorRefFromRequest(context);
  return actor.kind === "user" || actor.kind === "service_account" ? actor : null;
};

const actorId = (actor: MutableActor): string => (actor.kind === "user" ? actor.userId : actor.serviceAccountId);

const actorFromColumns = (kind: DraftActor["kind"], id: string | null): DraftActor =>
  kind === "user"
    ? { kind, userId: id! }
    : kind === "service_account"
      ? { kind, serviceAccountId: id!, delegatedUserId: null }
      : kind === "workflow"
        ? { kind, workflowVersionId: id! }
        : { kind: "system" };

const conflict = (message: string): Result<never> => fail({ code: "CONFLICT", message, status: 409 });

const mapDraft = (row: DbDraft): MailDraft => ({
  id: row.id,
  mailboxId: row.mailbox_id,
  conversationId: row.lifecycle_conversation_id ?? row.conversation_id,
  intent: row.intent,
  sourceMessageId: row.source_message_id,
  derivedFromMessageId: row.derived_from_message_id,
  derivationKind: row.derivation_kind,
  senderIdentityId: row.sender_identity_id,
  to: parseArray(row.to_addresses),
  cc: parseArray(row.cc_addresses),
  bcc: parseArray(row.bcc_addresses),
  subject: row.subject,
  body: row.body_markdown,
  format: row.body_format,
  priority: row.priority,
  requestDeliveryReceipt: row.request_delivery_receipt,
  requestReadReceipt: row.request_read_receipt,
  attachments: parseArray(row.attachments),
  createdBy: actorFromColumns(row.author_kind, row.author_id),
  lastEditedBy: actorFromColumns(row.last_editor_kind, row.last_editor_id),
  lastEditedByDisplayName:
    row.last_editor_display_name ??
    (row.last_editor_kind === "user"
      ? "User"
      : row.last_editor_kind === "service_account"
        ? "Service account"
        : row.last_editor_kind === "workflow"
          ? "Workflow"
          : "Mail provider"),
  recoveryCopyCount: Number(row.recovery_copy_count),
  revision: Number(row.revision),
  state: row.state,
  deliveryClass: row.delivery_class,
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

const mapRecoveryCopy = (row: DbRecoveryCopy): DraftRecoveryCopy => ({
  id: row.id,
  draftId: row.draft_id,
  baseRevision: Number(row.base_revision),
  content: parseRecord(row.content),
  createdBy: actorFromColumns(row.creator_kind, row.creator_id),
  createdAt: toIso(row.created_at),
  restoredAt: row.restored_at ? toIso(row.restored_at) : null,
  resultingRevision: row.resulting_revision === null ? null : Number(row.resulting_revision),
});

const validateIdentity = async (params: {
  mailboxId: string;
  senderIdentityId: string;
  db: typeof sql;
}): Promise<
  Result<{
    defaultCc: MailAddress[];
    defaultBcc: MailAddress[];
    defaultFormat: MailComposeFormat;
    defaultPriority: MailPriority;
    defaultDeliveryReceipt: boolean;
    defaultReadReceipt: boolean;
  }>
> => {
  const [identity] = await params.db<
    {
      default_cc: MailAddress[] | string;
      default_bcc: MailAddress[] | string;
      default_format: MailComposeFormat;
      default_priority: MailPriority;
      default_delivery_receipt: boolean;
      default_read_receipt: boolean;
    }[]
  >`
    SELECT
      default_cc,
      default_bcc,
      default_format,
      default_priority,
      default_delivery_receipt,
      default_read_receipt
    FROM mail.sender_identities
    WHERE id = ${params.senderIdentityId}::uuid
      AND mailbox_id = ${params.mailboxId}::uuid
      AND status = 'verified'
    FOR SHARE
  `;
  if (!identity) return fail(err.badInput("A verified sender identity is required"));
  return ok({
    defaultCc: typeof identity.default_cc === "string" ? (JSON.parse(identity.default_cc) as MailAddress[]) : identity.default_cc,
    defaultBcc: typeof identity.default_bcc === "string" ? (JSON.parse(identity.default_bcc) as MailAddress[]) : identity.default_bcc,
    defaultFormat: identity.default_format,
    defaultPriority: identity.default_priority,
    defaultDeliveryReceipt: identity.default_delivery_receipt,
    defaultReadReceipt: identity.default_read_receipt,
  });
};

const mergeDefaultCc = (params: { to: MailAddress[]; cc: MailAddress[]; bcc: MailAddress[]; defaultCc: MailAddress[] }): MailAddress[] => {
  const blocked = new Set([...params.to, ...params.bcc].map((recipient) => recipient.address.trim().toLowerCase()));
  const merged = new Map<string, MailAddress>();
  for (const recipient of [...params.cc, ...params.defaultCc]) {
    const key = recipient.address.trim().toLowerCase();
    if (blocked.has(key) || merged.has(key)) continue;
    merged.set(key, {
      ...(recipient.name?.trim() ? { name: recipient.name.trim() } : {}),
      address: key,
    });
  }
  return [...merged.values()];
};

const mergeDefaultBcc = (params: {
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  defaultBcc: MailAddress[];
}): MailAddress[] => {
  const blocked = new Set([...params.to, ...params.cc].map((recipient) => recipient.address.trim().toLowerCase()));
  const merged = new Map<string, MailAddress>();
  for (const recipient of [...params.bcc, ...params.defaultBcc]) {
    const key = recipient.address.trim().toLowerCase();
    if (blocked.has(key) || merged.has(key)) continue;
    merged.set(key, {
      ...(recipient.name?.trim() ? { name: recipient.name.trim() } : {}),
      address: key,
    });
  }
  return [...merged.values()];
};

const resolveDraftContext = async (params: {
  mailboxId: string;
  input: DraftContentInput;
  db: typeof sql;
}): Promise<Result<{ conversationId: string | null; intent: DraftIntent; sourceMessageId: string | null }>> => {
  const conversationId = params.input.conversationId ?? null;
  const intent = params.input.intent ?? (conversationId ? "reply" : "new");
  if (intent === "new") {
    if (conversationId || params.input.sourceMessageId) {
      return fail(err.badInput("A new-message draft cannot reference a conversation or source message"));
    }
    return ok({ conversationId: null, intent, sourceMessageId: null });
  }
  if (!conversationId) return fail(err.badInput(`${intent} drafts require a conversation`));
  const sourceMessageId = params.input.sourceMessageId ?? null;

  const [source] = await params.db<{ message_id: string }[]>`
    SELECT conversation_message.message_id
    FROM mail.conversation_messages conversation_message
    JOIN mail.conversations conversation ON conversation.id = conversation_message.conversation_id
    JOIN mail.message_contents message ON message.id = conversation_message.message_id
    WHERE conversation_message.conversation_id = ${conversationId}::uuid
      AND conversation.mailbox_id = ${params.mailboxId}::uuid
      AND (${sourceMessageId}::uuid IS NULL OR conversation_message.message_id = ${sourceMessageId}::uuid)
    ORDER BY conversation_message.position DESC, message.internal_date DESC, message.id DESC
    LIMIT 1
    FOR SHARE OF conversation, message
  `;
  if (!source) return fail(err.badInput("The draft source message does not belong to the selected conversation"));
  return ok({ conversationId, intent, sourceMessageId: source.message_id });
};

const resolveInitialReplyRecipients = async (params: {
  db: typeof sql;
  mailboxId: string;
  sourceMessageId: string;
  intent: Extract<DraftIntent, "reply" | "reply_all">;
}): Promise<Result<{ to: MailDraft["to"]; cc: MailDraft["cc"] }>> => {
  const [addresses, identities] = await Promise.all([
    params.db<{ role: "from" | "reply_to" | "to" | "cc"; display_name: string | null; email: string }[]>`
      SELECT role, display_name, email
      FROM mail.message_addresses
      WHERE message_id = ${params.sourceMessageId}::uuid
        AND role IN ('from', 'reply_to', 'to', 'cc')
      ORDER BY role, position
    `,
    params.db<{ from_address: string; reply_to: string | null }[]>`
      SELECT from_address, reply_to
      FROM mail.sender_identities
      WHERE mailbox_id = ${params.mailboxId}::uuid
        AND status <> 'disabled'
      ORDER BY id
    `,
  ]);
  const byRole = (role: "from" | "reply_to" | "to" | "cc") =>
    addresses.filter((row) => row.role === role).map((row) => ({ name: row.display_name, address: row.email }));
  const recipients = deriveReplyAddressObjects(
    { from: byRole("from"), replyTo: byRole("reply_to"), to: byRole("to"), cc: byRole("cc") },
    params.intent,
    identities.map((identity) => ({ fromAddress: identity.from_address, replyTo: identity.reply_to })),
  );
  return recipients.to.length > 0 ? ok(recipients) : fail(err.badInput("The source message has no reply recipient"));
};

const insertActivity = async (params: {
  db: typeof sql;
  mailboxId: string;
  conversationId: string | null;
  actor: MutableActor;
  action: string;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown>;
}): Promise<void> => {
  await params.db`
    INSERT INTO mail.activity_events (
      mailbox_id, conversation_id, actor_kind, actor_id, action, outcome, target_type, target_id, metadata
    ) VALUES (
      ${params.mailboxId}::uuid,
      ${params.conversationId}::uuid,
      ${params.actor.kind},
      ${actorId(params.actor)}::uuid,
      ${params.action},
      'confirmed',
      ${params.targetType},
      ${params.targetId}::uuid,
      ${params.metadata}::jsonb
    )
  `;
};

const copyForwardAttachments = async (params: { db: typeof sql; draftId: string; sourceMessageId: string }): Promise<Result<number>> => {
  const [invalid] = await params.db<{ invalid: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM mail.attachments attachment
      LEFT JOIN mail.message_part_blobs blob ON blob.id = attachment.blob_id
      WHERE attachment.message_id = ${params.sourceMessageId}::uuid
        AND (blob.id IS NULL OR blob.complete = false OR blob.byte_length > ${MAX_DRAFT_ATTACHMENT_BYTES})
    ) AS invalid
  `;
  if (invalid?.invalid) {
    return fail(err.badInput("One or more original attachments cannot be forwarded"));
  }

  const source = await params.db<
    { blob_id: string; filename: string; content_type: string; byte_length: string | number; content_hash: string; position: number }[]
  >`
    SELECT
      attachment.blob_id,
      left(COALESCE(NULLIF(attachment.filename, ''), 'attachment'), 255) AS filename,
      left(COALESCE(NULLIF(attachment.content_type, ''), 'application/octet-stream'), 255) AS content_type,
      blob.byte_length,
      blob.content_hash,
      (row_number() OVER (ORDER BY attachment.id) - 1)::int AS position
    FROM mail.attachments attachment
    JOIN mail.message_part_blobs blob ON blob.id = attachment.blob_id AND blob.complete = true
    WHERE attachment.message_id = ${params.sourceMessageId}::uuid
    ORDER BY attachment.id
  `;
  for (const attachment of source) {
    await withShortIdDb(
      params.db,
      "draftAttachment",
      (db, shortId) => db`
      INSERT INTO mail.draft_attachments (
        short_id, draft_id, blob_id, filename, content_type, byte_length, content_hash, position
      ) VALUES (
        ${shortId}, ${params.draftId}::uuid, ${attachment.blob_id}::uuid, ${attachment.filename},
        ${attachment.content_type}, ${attachment.byte_length}, ${attachment.content_hash}, ${attachment.position}
      )
    `,
    );
  }
  return ok(source.length);
};

const storeRecoveryCopy = async (params: {
  db: typeof sql;
  draftId: string;
  baseRevision: number;
  content: DraftEditableContent;
  actor: MutableActor;
}): Promise<void> => {
  const contentHash = sha256Json(params.content);
  await params.db`
    INSERT INTO mail.draft_recovery_copies (
      draft_id, base_revision, content, content_hash, creator_kind, creator_id
    ) VALUES (
      ${params.draftId}::uuid,
      ${params.baseRevision},
      ${params.content}::jsonb,
      ${contentHash},
      ${params.actor.kind},
      ${actorId(params.actor)}::uuid
    )
    ON CONFLICT (draft_id, base_revision, creator_kind, creator_id, content_hash) DO NOTHING
  `;
};

type PreparedComposeDraft = {
  conversationId: string | null;
  intent: DraftIntent;
  sourceMessageId: string | null;
  content: DraftEditableContent;
  attachments: DraftAttachment[];
  initialSignatureSource: string | null;
};

const sourceAttachmentPreviews = async (db: typeof sql, sourceMessageId: string | null): Promise<DraftAttachment[]> => {
  if (!sourceMessageId) return [];
  const rows = await db<
    Array<{
      id: string;
      filename: string;
      content_type: string;
      byte_length: string | number;
      content_hash: string;
      position: string | number;
      created_at: Date | string;
    }>
  >`
    SELECT
      attachment.id,
      left(COALESCE(NULLIF(attachment.filename, ''), 'attachment'), 255) AS filename,
      left(COALESCE(NULLIF(attachment.content_type, ''), 'application/octet-stream'), 255) AS content_type,
      blob.byte_length,
      blob.content_hash,
      (row_number() OVER (ORDER BY attachment.id) - 1)::int AS position,
      attachment.created_at
    FROM mail.attachments attachment
    JOIN mail.message_part_blobs blob ON blob.id = attachment.blob_id AND blob.complete = true
    WHERE attachment.message_id = ${sourceMessageId}::uuid
    ORDER BY attachment.id
  `;
  return rows.map((row) => ({
    id: row.id,
    filename: row.filename,
    contentType: row.content_type,
    byteLength: Number(row.byte_length),
    contentHash: row.content_hash,
    position: Number(row.position),
    createdAt: toIso(row.created_at),
  }));
};

const prepareSourceAttachments = async (db: typeof sql, sourceMessageId: string | null): Promise<Result<DraftAttachment[]>> => {
  if (!sourceMessageId) return ok([]);
  const [invalid] = await db<{ invalid: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM mail.attachments attachment
      LEFT JOIN mail.message_part_blobs blob ON blob.id = attachment.blob_id
      WHERE attachment.message_id = ${sourceMessageId}::uuid
        AND (blob.id IS NULL OR blob.complete = false OR blob.byte_length > ${MAX_DRAFT_ATTACHMENT_BYTES})
    ) AS invalid
  `;
  return invalid?.invalid
    ? fail(err.badInput("One or more original attachments cannot be forwarded"))
    : ok(await sourceAttachmentPreviews(db, sourceMessageId));
};

const prepareComposeDraftInTransaction = async (params: {
  db: typeof sql;
  context: MailRequestContext;
  mailboxId: string;
  input: DraftContentInput;
}): Promise<Result<PreparedComposeDraft>> => {
  const parsed = internalDraftContentSchema.safeParse(params.input);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid draft"));
  const [mailbox] = await params.db<{ id: string }[]>`
    SELECT id FROM mail.mailboxes
    WHERE id = ${params.mailboxId}::uuid AND deleted_at IS NULL
    FOR SHARE
  `;
  if (!mailbox) return fail(err.notFound("Mailbox"));
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "write", params.db);
  if (!allowed.ok) return allowed;
  const identity = await validateIdentity({
    mailboxId: params.mailboxId,
    senderIdentityId: parsed.data.senderIdentityId,
    db: params.db,
  });
  if (!identity.ok) return identity;
  const draftContext = await resolveDraftContext({
    mailboxId: params.mailboxId,
    input: parsed.data,
    db: params.db,
  });
  if (!draftContext.ok) return draftContext;
  if (parsed.data.includeSourceAttachments && draftContext.data.intent !== "forward") {
    return fail(err.badInput("Original attachments can only be included when forwarding a message"));
  }
  const defaultSignature = await resolveDefaultSignatureSource({
    db: params.db,
    context: params.context,
    mailboxId: params.mailboxId,
    senderIdentityId: parsed.data.senderIdentityId,
  });
  const initialSubject =
    draftContext.data.intent === "reply" || draftContext.data.intent === "reply_all"
      ? await applyConversationReferenceToReplySubjectInTransaction({
          db: params.db,
          mailboxId: params.mailboxId,
          conversationId: draftContext.data.conversationId!,
          subject: parsed.data.subject,
        })
      : parsed.data.subject;
  const initialRecipients =
    draftContext.data.intent === "reply" || draftContext.data.intent === "reply_all"
      ? await resolveInitialReplyRecipients({
          db: params.db,
          mailboxId: params.mailboxId,
          sourceMessageId: draftContext.data.sourceMessageId!,
          intent: draftContext.data.intent,
        })
      : ok({ to: parsed.data.to, cc: parsed.data.cc });
  if (!initialRecipients.ok) return initialRecipients;
  const initialCc = mergeDefaultCc({
    to: initialRecipients.data.to,
    cc: initialRecipients.data.cc,
    bcc: parsed.data.bcc,
    defaultCc: identity.data.defaultCc,
  });
  const initialContent = internalDraftEditableContentSchema.safeParse({
    senderIdentityId: parsed.data.senderIdentityId,
    to: initialRecipients.data.to,
    cc: initialCc,
    bcc: mergeDefaultBcc({
      to: initialRecipients.data.to,
      cc: initialCc,
      bcc: parsed.data.bcc,
      defaultBcc: identity.data.defaultBcc,
    }),
    subject: initialSubject,
    body: appendSignature(parsed.data.body, defaultSignature, draftContext.data.intent),
    format: parsed.data.format ?? identity.data.defaultFormat,
    priority: parsed.data.priority ?? identity.data.defaultPriority,
    requestDeliveryReceipt: parsed.data.requestDeliveryReceipt ?? identity.data.defaultDeliveryReceipt,
    requestReadReceipt: parsed.data.requestReadReceipt ?? identity.data.defaultReadReceipt,
  });
  if (!initialContent.success) {
    return fail(err.badInput(initialContent.error.issues[0]?.message ?? "Default signature makes the draft too large"));
  }
  const attachments = parsed.data.includeSourceAttachments
    ? await prepareSourceAttachments(params.db, draftContext.data.sourceMessageId)
    : ok([]);
  if (!attachments.ok) return attachments;
  return ok({
    ...draftContext.data,
    content: initialContent.data,
    attachments: attachments.data,
    initialSignatureSource: defaultSignature,
  });
};

const insertComposeDraftInTransaction = async (params: {
  db: typeof sql;
  mailboxId: string;
  actor: MutableActor;
  prepared: PreparedComposeDraft;
  content: DraftEditableContent;
  materializationKey?: string;
  materializationRequestHash?: string;
}): Promise<Result<MailDraft>> => {
  const identity = await validateIdentity({
    mailboxId: params.mailboxId,
    senderIdentityId: params.content.senderIdentityId,
    db: params.db,
  });
  if (!identity.ok) return identity;
  const rows = await withShortIdDb(
    params.db,
    "draft",
    (db, shortId) => db<DbDraft[]>`
    INSERT INTO mail.drafts AS d (
      short_id, mailbox_id, conversation_id, intent, source_message_id, sender_identity_id,
      author_kind, author_id, last_editor_kind, last_editor_id,
      to_addresses, cc_addresses, bcc_addresses, subject, body_markdown, body_format,
      priority, request_delivery_receipt, request_read_receipt,
      materialization_key, materialization_request_hash
    ) VALUES (
      ${shortId},
      ${params.mailboxId}::uuid,
      ${params.prepared.conversationId}::uuid,
      ${params.prepared.intent},
      ${params.prepared.sourceMessageId}::uuid,
      ${params.content.senderIdentityId}::uuid,
      ${params.actor.kind},
      ${actorId(params.actor)}::uuid,
      ${params.actor.kind},
      ${actorId(params.actor)}::uuid,
      ${params.content.to}::jsonb,
      ${params.content.cc}::jsonb,
      ${params.content.bcc}::jsonb,
      ${params.content.subject},
      ${params.content.body},
      ${params.content.format},
      ${params.content.priority},
      ${params.content.requestDeliveryReceipt},
      ${params.content.requestReadReceipt},
      ${params.materializationKey ?? null},
      ${params.materializationRequestHash ?? null}
    )
    RETURNING ${draftColumns}
  `,
  );
  const [row] = rows;
  if (!row) return fail(err.internal("Draft insert returned no row"));
  let attachmentCount = 0;
  if (params.prepared.attachments.length > 0 && params.prepared.sourceMessageId) {
    const copied = await copyForwardAttachments({
      db: params.db,
      draftId: row.id,
      sourceMessageId: params.prepared.sourceMessageId,
    });
    if (!copied.ok) return copied;
    attachmentCount = copied.data;
  }
  const [created] = await params.db<DbDraft[]>`
    SELECT ${draftColumns}
    FROM mail.drafts d
    WHERE d.id = ${row.id}::uuid
  `;
  if (!created) return fail(err.internal("Created draft could not be loaded"));
  await insertActivity({
    db: params.db,
    mailboxId: params.mailboxId,
    conversationId: params.prepared.conversationId,
    actor: params.actor,
    action: "draft.created",
    targetType: "draft",
    targetId: row.id,
    metadata: {
      revision: Number(created.revision),
      intent: params.prepared.intent,
      sourceMessageId: params.prepared.sourceMessageId,
      attachmentCount,
    },
  });
  await queueDraftProjectionInTransaction({ db: params.db, draftId: row.id });
  return ok({
    ...mapDraft(created),
    initialSignatureSource: params.prepared.initialSignatureSource,
  });
};

export const createDraft = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  input: DraftContentInput;
}): Promise<Result<MailDraft>> => {
  const actor = mutableActor(params.context);
  if (!actor) return fail(err.forbidden("Draft author is invalid"));
  try {
    const result = await sql.begin(async (tx) => {
      const prepared = await prepareComposeDraftInTransaction({
        ...params,
        db: tx,
      });
      if (!prepared.ok) return prepared;
      return insertComposeDraftInTransaction({
        db: tx,
        mailboxId: params.mailboxId,
        actor,
        prepared: prepared.data,
        content: prepared.data.content,
      });
    });
    return wakeDraftProjection(result);
  } catch (error) {
    log.error("Failed to create draft", { mailboxId: params.mailboxId, error });
    return fail(err.internal("Failed to create draft"));
  }
};

type PreparedDerivedDraft = {
  messageId: string;
  kind: MailDraft["derivationKind"] & {};
  content: DraftEditableContent;
  attachments: DraftAttachment[];
};

const prepareDerivedDraftInTransaction = async (params: {
  db: typeof sql;
  mailboxId: string;
  messageId: string;
  input: Omit<DeriveDraftFromMessageInput, "idempotencyKey">;
}): Promise<Result<PreparedDerivedDraft>> => {
  const identity = await validateIdentity({
    mailboxId: params.mailboxId,
    senderIdentityId: params.input.senderIdentityId,
    db: params.db,
  });
  if (!identity.ok) return identity;
  const [source] = await params.db<
    {
      id: string;
      subject: string;
      plain_text: string | null;
      sanitized_html: string | null;
      from_addresses: MailAddress[] | string;
      to_addresses: MailAddress[] | string;
      cc_addresses: MailAddress[] | string;
      bcc_addresses: MailAddress[] | string;
    }[]
  >`
    SELECT
      message.id,
      message.subject,
      message.plain_text,
      message.sanitized_html,
      COALESCE(addresses.from_addresses, '[]'::jsonb) AS from_addresses,
      COALESCE(addresses.to_addresses, '[]'::jsonb) AS to_addresses,
      COALESCE(addresses.cc_addresses, '[]'::jsonb) AS cc_addresses,
      COALESCE(addresses.bcc_addresses, '[]'::jsonb) AS bcc_addresses
    FROM mail.message_contents message
    LEFT JOIN LATERAL (
      SELECT
        jsonb_agg(jsonb_build_object('name', display_name, 'address', email) ORDER BY position)
          FILTER (WHERE role = 'from') AS from_addresses,
        jsonb_agg(jsonb_build_object('name', display_name, 'address', email) ORDER BY position)
          FILTER (WHERE role = 'to') AS to_addresses,
        jsonb_agg(jsonb_build_object('name', display_name, 'address', email) ORDER BY position)
          FILTER (WHERE role = 'cc') AS cc_addresses,
        jsonb_agg(jsonb_build_object('name', display_name, 'address', email) ORDER BY position)
          FILTER (WHERE role = 'bcc') AS bcc_addresses
      FROM mail.message_addresses
      WHERE message_id = message.id
    ) addresses ON true
    WHERE message.id = ${params.messageId}::uuid
      AND message.mailbox_id = ${params.mailboxId}::uuid
    FOR SHARE OF message
  `;
  if (!source) return fail(err.notFound("Message"));
  if (params.input.kind === "resend") {
    const from = parseArray(source.from_addresses).map((address) => address.address.trim().toLowerCase());
    const [owned] = await params.db<{ id: string }[]>`
      SELECT id
      FROM mail.sender_identities
      WHERE mailbox_id = ${params.mailboxId}::uuid
        AND status = 'verified'
        AND lower(from_address) IN (
          SELECT value
          FROM jsonb_array_elements_text(${from}::jsonb)
        )
      LIMIT 1
    `;
    if (!owned) return fail(err.badInput("Only a message sent by this mailbox can be resent"));
  }
  const content = internalDraftEditableContentSchema.safeParse({
    senderIdentityId: params.input.senderIdentityId,
    to: parseArray(source.to_addresses),
    cc: parseArray(source.cc_addresses),
    bcc: parseArray(source.bcc_addresses),
    subject: source.subject,
    body: reusableMessageBody(source.plain_text, source.sanitized_html),
    format: "plain",
    priority: identity.data.defaultPriority,
    requestDeliveryReceipt: identity.data.defaultDeliveryReceipt,
    requestReadReceipt: identity.data.defaultReadReceipt,
  });
  if (!content.success) return fail(err.badInput(content.error.issues[0]?.message ?? "Source message cannot be reused"));
  const attachments = params.input.includeAttachments ? await prepareSourceAttachments(params.db, params.messageId) : ok([]);
  if (!attachments.ok) return attachments;
  return ok({
    messageId: params.messageId,
    kind: params.input.kind,
    content: content.data,
    attachments: attachments.data,
  });
};

const insertDerivedDraftInTransaction = async (params: {
  db: typeof sql;
  mailboxId: string;
  actor: MutableActor;
  prepared: PreparedDerivedDraft;
  content: DraftEditableContent;
  idempotencyKey: string;
  requestHash: string;
}): Promise<Result<MailDraft>> => {
  const identity = await validateIdentity({
    mailboxId: params.mailboxId,
    senderIdentityId: params.content.senderIdentityId,
    db: params.db,
  });
  if (!identity.ok) return identity;
  const createdRows = await withShortIdDb(
    params.db,
    "draft",
    (db, shortId) => db<DbDraft[]>`
    INSERT INTO mail.drafts AS d (
      short_id, mailbox_id, conversation_id, intent, source_message_id,
      derived_from_message_id, derivation_kind, derivation_key, derivation_request_hash,
      sender_identity_id,
      author_kind, author_id, last_editor_kind, last_editor_id,
      to_addresses, cc_addresses, bcc_addresses, subject, body_markdown, body_format,
      priority, request_delivery_receipt, request_read_receipt
    ) VALUES (
      ${shortId},
      ${params.mailboxId}::uuid, NULL, 'new', NULL,
      ${params.prepared.messageId}::uuid, ${params.prepared.kind}, ${params.idempotencyKey}, ${params.requestHash},
      ${params.content.senderIdentityId}::uuid,
      ${params.actor.kind}, ${actorId(params.actor)}::uuid, ${params.actor.kind}, ${actorId(params.actor)}::uuid,
      ${params.content.to}::jsonb, ${params.content.cc}::jsonb, ${params.content.bcc}::jsonb,
      ${params.content.subject}, ${params.content.body}, ${params.content.format},
      ${params.content.priority}, ${params.content.requestDeliveryReceipt}, ${params.content.requestReadReceipt}
    )
    RETURNING ${draftColumns}
  `,
  );
  const [created] = createdRows;
  if (!created) return fail(err.internal("Draft insert returned no row"));
  let attachmentCount = 0;
  if (params.prepared.attachments.length > 0) {
    const copied = await copyForwardAttachments({
      db: params.db,
      draftId: created.id,
      sourceMessageId: params.prepared.messageId,
    });
    if (!copied.ok) return copied;
    attachmentCount = copied.data;
  }
  const [loaded] = await params.db<DbDraft[]>`
    SELECT ${draftColumns}
    FROM mail.drafts d
    WHERE d.id = ${created.id}::uuid
  `;
  if (!loaded) return fail(err.internal("Derived draft could not be loaded"));
  await insertActivity({
    db: params.db,
    mailboxId: params.mailboxId,
    conversationId: null,
    actor: params.actor,
    action: "draft.derived",
    targetType: "draft",
    targetId: created.id,
    metadata: {
      sourceMessageId: params.prepared.messageId,
      derivationKind: params.prepared.kind,
      attachmentCount,
    },
  });
  await queueDraftProjectionInTransaction({
    db: params.db,
    draftId: created.id,
  });
  return ok(mapDraft(loaded));
};

const prepareDraftSeedOriginInTransaction = async (params: {
  db: typeof sql;
  context: MailRequestContext;
  mailboxId: string;
  origin: DraftSeedOrigin;
}): Promise<Result<Omit<MailDraftSeed, "id" | "mailboxId" | "origin" | "createdAt">>> => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "write", params.db);
  if (!allowed.ok) return allowed;
  if (params.origin.kind === "compose") {
    const prepared = await prepareComposeDraftInTransaction({
      db: params.db,
      context: params.context,
      mailboxId: params.mailboxId,
      input: params.origin.input,
    });
    if (!prepared.ok) return prepared;
    return ok({
      conversationId: prepared.data.conversationId,
      intent: prepared.data.intent,
      sourceMessageId: prepared.data.sourceMessageId,
      derivedFromMessageId: null,
      derivationKind: null,
      content: prepared.data.content,
      attachments: prepared.data.attachments,
      initialSignatureSource: prepared.data.initialSignatureSource,
    });
  }
  const prepared = await prepareDerivedDraftInTransaction({
    db: params.db,
    mailboxId: params.mailboxId,
    messageId: params.origin.messageId,
    input: params.origin.input,
  });
  if (!prepared.ok) return prepared;
  return ok({
    conversationId: null,
    intent: "new",
    sourceMessageId: null,
    derivedFromMessageId: prepared.data.messageId,
    derivationKind: prepared.data.kind,
    content: prepared.data.content,
    attachments: prepared.data.attachments,
    initialSignatureSource: null,
  });
};

export const prepareDraftSeed = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  origin: DraftSeedOrigin;
}): Promise<Result<MailDraftSeed>> => {
  const parsed = internalDraftSeedOriginSchema.safeParse(params.origin);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid compose request"));
  if (!mutableActor(params.context)) return fail(err.forbidden("Draft author is invalid"));
  try {
    return await sql.begin(async (tx) => {
      const prepared = await prepareDraftSeedOriginInTransaction({
        db: tx,
        context: params.context,
        mailboxId: params.mailboxId,
        origin: parsed.data,
      });
      if (!prepared.ok) return prepared;
      const seedOrigin: DraftSeedOrigin =
        parsed.data.kind === "compose"
          ? {
              kind: "compose",
              input: {
                senderIdentityId: parsed.data.input.senderIdentityId,
                to: [],
                cc: [],
                bcc: [],
                subject: "",
                body: "",
                conversationId: prepared.data.conversationId,
                intent: prepared.data.intent,
                sourceMessageId: prepared.data.sourceMessageId,
                includeSourceAttachments: prepared.data.attachments.length > 0,
              },
            }
          : parsed.data;
      return ok({
        id: crypto.randomUUID(),
        mailboxId: params.mailboxId,
        origin: seedOrigin,
        createdAt: new Date().toISOString(),
        ...prepared.data,
      });
    });
  } catch (error) {
    log.error("Failed to prepare draft seed", {
      mailboxId: params.mailboxId,
      error,
    });
    return fail(err.internal("Failed to prepare message"));
  }
};

export const materializeDraftSeed = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  input: MaterializeDraftSeedInput;
}): Promise<Result<MailDraft>> => {
  const parsed = internalMaterializeDraftSeedInputSchema.safeParse(params.input);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid compose request"));
  const actor = mutableActor(params.context);
  if (!actor) return fail(err.forbidden("Draft author is invalid"));
  try {
    const result = await sql.begin(async (tx) => {
      const requestHash = await sha256Json(parsed.data.origin);
      const keyColumn = parsed.data.origin.kind === "derive" ? "derivation" : "materialization";
      const lockKey = [params.mailboxId, actor.kind, actorId(actor), keyColumn, parsed.data.idempotencyKey].join(":");
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      const existing =
        parsed.data.origin.kind === "derive"
          ? (
              await tx<(DbDraft & { request_hash: string })[]>`
                SELECT ${draftColumns}, d.derivation_request_hash AS request_hash
                FROM mail.drafts d
                WHERE d.mailbox_id = ${params.mailboxId}::uuid
                  AND d.author_kind = ${actor.kind}
                  AND d.author_id = ${actorId(actor)}::uuid
                  AND d.derivation_key = ${parsed.data.idempotencyKey}
              `
            )[0]
          : (
              await tx<(DbDraft & { request_hash: string })[]>`
                SELECT ${draftColumns}, d.materialization_request_hash AS request_hash
                FROM mail.drafts d
                WHERE d.mailbox_id = ${params.mailboxId}::uuid
                  AND d.author_kind = ${actor.kind}
                  AND d.author_id = ${actorId(actor)}::uuid
                  AND d.materialization_key = ${parsed.data.idempotencyKey}
              `
            )[0];
      if (existing) {
        return existing.request_hash === requestHash
          ? ok(mapDraft(existing))
          : fail(capabilityIdempotencyConflict("Compose idempotency key conflicts with a different request"));
      }
      const validationOrigin: DraftSeedOrigin =
        parsed.data.origin.kind === "compose"
          ? {
              ...parsed.data.origin,
              input: {
                ...parsed.data.origin.input,
                senderIdentityId: parsed.data.draft.senderIdentityId,
              },
            }
          : {
              ...parsed.data.origin,
              input: {
                ...parsed.data.origin.input,
                senderIdentityId: parsed.data.draft.senderIdentityId,
              },
            };
      const preparedSeed = await prepareDraftSeedOriginInTransaction({
        db: tx,
        context: params.context,
        mailboxId: params.mailboxId,
        origin: validationOrigin,
      });
      if (!preparedSeed.ok) return preparedSeed;
      if (parsed.data.origin.kind === "derive") {
        const prepared: PreparedDerivedDraft = {
          messageId: preparedSeed.data.derivedFromMessageId!,
          kind: preparedSeed.data.derivationKind!,
          content: preparedSeed.data.content,
          attachments: preparedSeed.data.attachments,
        };
        return insertDerivedDraftInTransaction({
          db: tx,
          mailboxId: params.mailboxId,
          actor,
          prepared,
          content: parsed.data.draft,
          idempotencyKey: parsed.data.idempotencyKey,
          requestHash,
        });
      }
      const prepared: PreparedComposeDraft = {
        conversationId: preparedSeed.data.conversationId,
        intent: preparedSeed.data.intent,
        sourceMessageId: preparedSeed.data.sourceMessageId,
        content: preparedSeed.data.content,
        attachments: preparedSeed.data.attachments,
        initialSignatureSource: preparedSeed.data.initialSignatureSource,
      };
      return insertComposeDraftInTransaction({
        db: tx,
        mailboxId: params.mailboxId,
        actor,
        prepared,
        content: parsed.data.draft,
        materializationKey: parsed.data.idempotencyKey,
        materializationRequestHash: requestHash,
      });
    });
    return wakeDraftProjection(result);
  } catch (error) {
    log.error("Failed to materialize draft seed", {
      mailboxId: params.mailboxId,
      error,
    });
    return fail(err.internal("Failed to save draft"));
  }
};

export const deriveDraftFromMessage = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  messageId: string;
  input: DeriveDraftFromMessageInput;
}): Promise<Result<MailDraft>> => {
  const parsed = internalDeriveDraftFromMessageInputSchema.safeParse(params.input);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid draft derivation"));
  const actor = mutableActor(params.context);
  if (!actor) return fail(err.forbidden("Draft author is invalid"));
  try {
    const result = await sql.begin(async (tx) => {
      const allowed = await requireMailboxPermission(params.context, params.mailboxId, "write", tx);
      if (!allowed.ok) return allowed;
      const request = {
        messageId: params.messageId,
        kind: parsed.data.kind,
        senderIdentityId: parsed.data.senderIdentityId,
        includeAttachments: parsed.data.includeAttachments,
      };
      const requestHash = await sha256Json(request);
      const derivationLockKey = [params.mailboxId, actor.kind, actorId(actor), "derive", parsed.data.idempotencyKey].join(":");
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${derivationLockKey}, 0))`;
      const [existing] = await tx<(DbDraft & { derivation_request_hash: string })[]>`
        SELECT ${draftColumns}, d.derivation_request_hash
        FROM mail.drafts d
        WHERE d.mailbox_id = ${params.mailboxId}::uuid
          AND d.author_kind = ${actor.kind}
          AND d.author_id = ${actorId(actor)}::uuid
          AND d.derivation_key = ${parsed.data.idempotencyKey}
      `;
      if (existing) {
        return existing.derivation_request_hash === requestHash
          ? ok(mapDraft(existing))
          : fail(capabilityIdempotencyConflict("Draft derivation idempotency key conflicts with a different request"));
      }
      const prepared = await prepareDerivedDraftInTransaction({
        db: tx,
        mailboxId: params.mailboxId,
        messageId: params.messageId,
        input: parsed.data,
      });
      if (!prepared.ok) return prepared;
      return insertDerivedDraftInTransaction({
        db: tx,
        mailboxId: params.mailboxId,
        actor,
        prepared: prepared.data,
        content: prepared.data.content,
        idempotencyKey: parsed.data.idempotencyKey,
        requestHash,
      });
    });
    return wakeDraftProjection(result);
  } catch (error) {
    log.error("Failed to derive draft from message", {
      mailboxId: params.mailboxId,
      messageId: params.messageId,
      kind: parsed.data.kind,
      error,
    });
    return fail(err.internal("Failed to create draft from message"));
  }
};

const deliveryRecipientAddresses = (value: Record<string, unknown> | string): { accepted: string[]; rejected: string[] } => {
  try {
    const parsed = typeof value === "string" ? (JSON.parse(value) as Record<string, unknown>) : value;
    const addresses = (key: "accepted" | "rejected") =>
      Array.isArray(parsed[key]) ? parsed[key].filter((address): address is string => typeof address === "string") : [];
    return { accepted: addresses("accepted"), rejected: addresses("rejected") };
  } catch {
    return { accepted: [], rejected: [] };
  }
};

const normalizedAddress = (value: string): string => value.trim().toLowerCase();

export const createDeliveryRecoveryDraft = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  deliveryId: string;
  input: CreateDeliveryRecoveryDraftInput;
}): Promise<Result<MailDraft>> => {
  const parsed = internalCreateDeliveryRecoveryDraftInputSchema.safeParse(params.input);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid delivery recovery request"));
  const actor = mutableActor(params.context);
  if (!actor) return fail(err.forbidden("Draft author is invalid"));
  try {
    const result = await sql.begin(async (tx) => {
      const allowed = await requireMailboxPermission(params.context, params.mailboxId, "write", tx);
      if (!allowed.ok) return allowed;
      const [delivery] = await tx<
        {
          message_id: string;
          sender_identity_id: string;
          state: string;
          last_error_code: string | null;
          provider_response: Record<string, unknown> | string;
        }[]
      >`
        SELECT message_id, sender_identity_id, state, last_error_code, provider_response
        FROM mail.outbox_submissions
        WHERE id = ${params.deliveryId}::uuid
          AND mailbox_id = ${params.mailboxId}::uuid
        FOR SHARE
      `;
      if (!delivery) return fail(err.notFound("Delivery"));
      const partial = delivery.last_error_code === "SMTP_PARTIAL_ACCEPTANCE" && delivery.state === "needs_attention";
      const ambiguous = delivery.state === "unknown" || delivery.last_error_code === "AMBIGUOUS_SMTP_OUTCOME";
      if (parsed.data.recipientMode === "remaining" && !partial) {
        return fail(err.badInput("Only a partially sent message has remaining recipients"));
      }
      if (parsed.data.recipientMode === "all" && !partial && !ambiguous) {
        return fail(err.badInput("This delivery does not support creating a resend draft"));
      }
      const request = {
        deliveryId: params.deliveryId,
        recipientMode: parsed.data.recipientMode,
        includeAttachments: parsed.data.includeAttachments,
      };
      const requestHash = await sha256Json(request);
      const lockKey = [params.mailboxId, actor.kind, actorId(actor), "delivery-recovery", parsed.data.idempotencyKey].join(":");
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      const [existing] = await tx<(DbDraft & { derivation_request_hash: string })[]>`
        SELECT ${draftColumns}, d.derivation_request_hash
        FROM mail.drafts d
        WHERE d.mailbox_id = ${params.mailboxId}::uuid
          AND d.author_kind = ${actor.kind}
          AND d.author_id = ${actorId(actor)}::uuid
          AND d.derivation_key = ${parsed.data.idempotencyKey}
      `;
      if (existing) {
        return existing.derivation_request_hash === requestHash
          ? ok(mapDraft(existing))
          : fail(capabilityIdempotencyConflict("Delivery recovery idempotency key conflicts with a different request"));
      }
      const prepared = await prepareDerivedDraftInTransaction({
        db: tx,
        mailboxId: params.mailboxId,
        messageId: delivery.message_id,
        input: {
          kind: "resend",
          senderIdentityId: delivery.sender_identity_id,
          includeAttachments: parsed.data.includeAttachments,
        },
      });
      if (!prepared.ok) return prepared;
      if (parsed.data.recipientMode === "remaining") {
        const rejected = new Set(deliveryRecipientAddresses(delivery.provider_response).rejected.map(normalizedAddress));
        if (rejected.size === 0) return fail(err.badInput("No remaining recipients were recorded for this delivery"));
        const keepRejected = (address: MailAddress) => rejected.has(normalizedAddress(address.address));
        prepared.data.content = {
          ...prepared.data.content,
          to: prepared.data.content.to.filter(keepRejected),
          cc: prepared.data.content.cc.filter(keepRejected),
          bcc: prepared.data.content.bcc.filter(keepRejected),
        };
        if (prepared.data.content.to.length + prepared.data.content.cc.length + prepared.data.content.bcc.length === 0) {
          return fail(err.badInput("The remaining recipients could not be matched to the original message"));
        }
      }
      return insertDerivedDraftInTransaction({
        db: tx,
        mailboxId: params.mailboxId,
        actor,
        prepared: prepared.data,
        content: prepared.data.content,
        idempotencyKey: parsed.data.idempotencyKey,
        requestHash,
      });
    });
    return wakeDraftProjection(result);
  } catch (error) {
    log.error("Failed to create delivery recovery draft", { mailboxId: params.mailboxId, deliveryId: params.deliveryId, error });
    return fail(err.internal("Failed to create a recovery draft"));
  }
};

type WorkflowDraftResult = {
  id: string;
  revision: number;
  senderIdentityId: string;
  deliveryClass: DraftDeliveryClass;
};

const insertWorkflowReplyDraftInTransaction = async (params: {
  db: typeof sql;
  mailboxId: string;
  workflowVersionId: string;
  draftId: string;
  conversationId: string;
  sourceMessageId: string;
  senderIdentityId: string;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  body: string;
  format: "plain" | "markdown";
  deliveryClass: DraftDeliveryClass;
}): Promise<Result<WorkflowDraftResult>> => {
  const content = internalDraftContentSchema.safeParse({
    conversationId: params.conversationId,
    intent: "reply",
    sourceMessageId: params.sourceMessageId,
    senderIdentityId: params.senderIdentityId,
    to: params.to,
    cc: params.cc,
    bcc: params.bcc,
    subject: params.subject,
    body: params.body,
    format: params.format,
  });
  if (!content.success) return fail(err.badInput(content.error.issues[0]?.message ?? "Invalid workflow reply draft"));
  const [source] = await params.db<{ id: string }[]>`
    SELECT message.id
    FROM mail.message_contents message
    JOIN mail.conversation_messages link ON link.message_id = message.id
    JOIN mail.conversations conversation ON conversation.id = link.conversation_id
    WHERE message.id = ${params.sourceMessageId}::uuid
      AND conversation.id = ${params.conversationId}::uuid
      AND conversation.mailbox_id = ${params.mailboxId}::uuid
    FOR SHARE OF message, conversation
  `;
  if (!source) return fail(err.badInput("Workflow reply source is no longer part of the conversation"));
  const [identity] = await params.db<{ id: string }[]>`
    SELECT id
    FROM mail.sender_identities
    WHERE id = ${params.senderIdentityId}::uuid
      AND mailbox_id = ${params.mailboxId}::uuid
      AND status = 'verified'
      AND automation_policy = 'mailbox'
    FOR SHARE
  `;
  if (!identity) return fail(err.forbidden("Sender identity no longer permits mailbox automation"));
  const subject = await applyConversationReferenceToReplySubjectInTransaction({
    db: params.db,
    mailboxId: params.mailboxId,
    conversationId: params.conversationId,
    subject: content.data.subject,
  });
  const draftRows = await withShortIdDb(
    params.db,
    "draft",
    (db, shortId) => db<{ id: string; revision: string | number }[]>`
    INSERT INTO mail.drafts (
      id, short_id, mailbox_id, conversation_id, intent, source_message_id, sender_identity_id,
      author_kind, author_id, last_editor_kind, last_editor_id, origin, delivery_class,
      to_addresses, cc_addresses, bcc_addresses, subject, body_markdown, body_format
    ) VALUES (
      ${params.draftId}::uuid, ${shortId}, ${params.mailboxId}::uuid, ${params.conversationId}::uuid, 'reply', ${params.sourceMessageId}::uuid,
      ${params.senderIdentityId}::uuid, 'workflow', ${params.workflowVersionId}::uuid, 'workflow', ${params.workflowVersionId}::uuid,
      ${params.deliveryClass === "normal" ? "user" : "workflow"}, ${params.deliveryClass},
      ${content.data.to}::jsonb, ${content.data.cc}::jsonb, ${content.data.bcc}::jsonb,
      ${subject}, ${content.data.body}, ${content.data.format}
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id, revision
  `,
  );
  const [draft] = draftRows;
  if (draft) {
    return ok({
      id: draft.id,
      revision: Number(draft.revision),
      senderIdentityId: params.senderIdentityId,
      deliveryClass: params.deliveryClass,
    });
  }
  const [existing] = await params.db<{ id: string; revision: string | number; sender_identity_id: string }[]>`
    SELECT id, revision, sender_identity_id
    FROM mail.drafts
    WHERE id = ${params.draftId}::uuid
      AND mailbox_id = ${params.mailboxId}::uuid
      AND origin = ${params.deliveryClass === "normal" ? "user" : "workflow"}
      AND delivery_class = ${params.deliveryClass}
      AND author_kind = 'workflow'
      AND author_id = ${params.workflowVersionId}::uuid
    FOR UPDATE
  `;
  return existing
    ? ok({
        id: existing.id,
        revision: Number(existing.revision),
        senderIdentityId: existing.sender_identity_id,
        deliveryClass: params.deliveryClass,
      })
    : fail(err.conflict("Workflow reply draft id is in use"));
};

export const createWorkflowReplyDraftInTransaction = async (params: {
  db: typeof sql;
  mailboxId: string;
  workflowVersionId: string;
  draftId: string;
  conversationId: string;
  sourceMessageId: string;
  senderIdentityId: string;
  recipient: { name: string | null; address: string };
  subject: string;
  body: string;
  format: "plain" | "markdown";
}): Promise<Result<{ id: string; revision: number }>> =>
  insertWorkflowReplyDraftInTransaction({
    ...params,
    to: [params.recipient],
    cc: [],
    bcc: [],
    deliveryClass: "automatic_reply",
  });

export const createWorkflowReviewReplyDraftInTransaction = async (params: {
  db: typeof sql;
  mailboxId: string;
  workflowVersionId: string;
  draftId: string;
  conversationId: string;
  sourceMessageId: string;
  senderIdentityId: string;
  body: string;
  format: "plain" | "markdown";
}): Promise<Result<WorkflowDraftResult>> => {
  const [source] = await params.db<{ subject: string }[]>`
    SELECT subject
    FROM mail.message_contents
    WHERE id = ${params.sourceMessageId}::uuid
      AND mailbox_id = ${params.mailboxId}::uuid
    FOR SHARE
  `;
  if (!source) return fail(err.badInput("Workflow reply source is unavailable"));
  const recipients = await resolveInitialReplyRecipients({
    db: params.db,
    mailboxId: params.mailboxId,
    sourceMessageId: params.sourceMessageId,
    intent: "reply",
  });
  if (!recipients.ok) return recipients;
  const subject = /^\s*re\s*:/iu.test(source.subject) ? source.subject : `Re: ${source.subject}`;
  return insertWorkflowReplyDraftInTransaction({
    ...params,
    ...recipients.data,
    bcc: [],
    subject,
    deliveryClass: "normal",
  });
};

export const createWorkflowDraftInTransaction = async (params: {
  db: typeof sql;
  mailboxId: string;
  workflowVersionId: string;
  draftId: string;
  senderIdentityId: string;
  to: Array<{ name?: string | null; address: string }>;
  cc: Array<{ name?: string | null; address: string }>;
  bcc: Array<{ name?: string | null; address: string }>;
  subject: string;
  body: string;
  format: "plain" | "markdown";
}): Promise<Result<{ id: string; revision: number; senderIdentityId: string; deliveryClass: "normal" }>> => {
  const content = internalDraftContentSchema.safeParse({
    intent: "new",
    senderIdentityId: params.senderIdentityId,
    to: params.to,
    cc: params.cc,
    bcc: params.bcc,
    subject: params.subject,
    body: params.body,
    format: params.format,
  });
  if (!content.success) return fail(err.badInput(content.error.issues[0]?.message ?? "Invalid workflow draft"));
  const [identity] = await params.db<{ id: string }[]>`
    SELECT id
    FROM mail.sender_identities
    WHERE id = ${params.senderIdentityId}::uuid
      AND mailbox_id = ${params.mailboxId}::uuid
      AND status = 'verified'
      AND automation_policy = 'mailbox'
    FOR SHARE
  `;
  if (!identity) return fail(err.forbidden("Sender identity no longer permits mailbox automation"));
  const draftRows = await withShortIdDb(
    params.db,
    "draft",
    (db, shortId) => db<{ id: string; revision: string | number }[]>`
    INSERT INTO mail.drafts (
      id, short_id, mailbox_id, conversation_id, intent, source_message_id, sender_identity_id,
      author_kind, author_id, last_editor_kind, last_editor_id, origin, delivery_class,
      to_addresses, cc_addresses, bcc_addresses, subject, body_markdown, body_format
    ) VALUES (
      ${params.draftId}::uuid, ${shortId}, ${params.mailboxId}::uuid, NULL, 'new', NULL, ${params.senderIdentityId}::uuid,
      'workflow', ${params.workflowVersionId}::uuid, 'workflow', ${params.workflowVersionId}::uuid,
      'user', 'normal', ${content.data.to}::jsonb, ${content.data.cc}::jsonb, ${content.data.bcc}::jsonb,
      ${content.data.subject}, ${content.data.body}, ${content.data.format}
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id, revision
  `,
  );
  const [draft] = draftRows;
  if (draft) {
    return ok({ id: draft.id, revision: Number(draft.revision), senderIdentityId: params.senderIdentityId, deliveryClass: "normal" });
  }
  const [existing] = await params.db<{ id: string; revision: string | number; sender_identity_id: string }[]>`
    SELECT id, revision, sender_identity_id
    FROM mail.drafts
    WHERE id = ${params.draftId}::uuid
      AND mailbox_id = ${params.mailboxId}::uuid
      AND origin = 'user'
      AND delivery_class = 'normal'
      AND author_kind = 'workflow'
      AND author_id = ${params.workflowVersionId}::uuid
    FOR UPDATE
  `;
  return existing
    ? ok({ id: existing.id, revision: Number(existing.revision), senderIdentityId: existing.sender_identity_id, deliveryClass: "normal" })
    : fail(err.conflict("Workflow draft id is in use"));
};

export const updateDraft = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  draftId: string;
  expectedRevision: number;
  input: DraftEditableContentInput;
}): Promise<Result<MailDraft>> => {
  const parsed = internalDraftEditableContentSchema.safeParse(params.input);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid draft"));
  if (!Number.isInteger(params.expectedRevision) || params.expectedRevision < 1) return fail(err.badInput("Invalid draft revision"));
  const actor = mutableActor(params.context);
  if (!actor) return fail(err.forbidden("Draft author is invalid"));
  try {
    const result = await sql.begin(async (tx) => {
      const allowed = await requireMailboxPermission(params.context, params.mailboxId, "write", tx);
      if (!allowed.ok) return allowed;
      const draftId = params.draftId;
      const [current] = await tx<{ state: string; revision: string | number }[]>`
        SELECT state, revision
        FROM mail.drafts
        WHERE id = ${draftId}::uuid AND mailbox_id = ${params.mailboxId}::uuid AND origin = 'user'
        FOR UPDATE
      `;
      if (!current) return fail(err.notFound("Draft"));
      if (current.state !== "draft") {
        await storeRecoveryCopy({ db: tx, draftId, baseRevision: params.expectedRevision, content: parsed.data, actor });
        return conflict("Draft can no longer be edited; the submitted content was saved as a recovery copy");
      }
      if (Number(current.revision) !== params.expectedRevision) {
        await storeRecoveryCopy({ db: tx, draftId, baseRevision: params.expectedRevision, content: parsed.data, actor });
        return conflict("Draft changed; the submitted content was saved as a recovery copy");
      }
      const identity = await validateIdentity({ mailboxId: params.mailboxId, senderIdentityId: parsed.data.senderIdentityId, db: tx });
      if (!identity.ok) {
        await storeRecoveryCopy({ db: tx, draftId, baseRevision: params.expectedRevision, content: parsed.data, actor });
        return conflict("Sender identity is no longer available; the submitted content was saved as a recovery copy");
      }
      const [row] = await tx<DbDraft[]>`
        UPDATE mail.drafts d
        SET
          sender_identity_id = ${parsed.data.senderIdentityId}::uuid,
          to_addresses = ${parsed.data.to}::jsonb,
          cc_addresses = ${parsed.data.cc}::jsonb,
          bcc_addresses = ${parsed.data.bcc}::jsonb,
          subject = ${parsed.data.subject},
          body_markdown = ${parsed.data.body},
          body_format = ${parsed.data.format},
          priority = ${parsed.data.priority},
          request_delivery_receipt = ${parsed.data.requestDeliveryReceipt},
          request_read_receipt = ${parsed.data.requestReadReceipt},
          last_editor_kind = ${actor.kind},
          last_editor_id = ${actorId(actor)}::uuid,
          revision = revision + 1
        WHERE d.id = ${draftId}::uuid AND d.origin = 'user'
        RETURNING ${draftColumns}
      `;
      if (row) await queueDraftProjectionInTransaction({ db: tx, draftId: row.id });
      return row ? ok(mapDraft(row)) : fail(err.internal("Draft update returned no row"));
    });
    return wakeDraftProjection(result);
  } catch {
    return fail(err.internal("Failed to update draft"));
  }
};

export const listDrafts = async (context: MailRequestContext, mailboxId: string, limit = 100): Promise<Result<MailDraft[]>> => {
  const allowed = await requireMailboxPermission(context, mailboxId, "read");
  if (!allowed.ok) return allowed;
  const rows = await sql<DbDraft[]>`
    SELECT ${draftColumns}
    FROM mail.drafts d
    WHERE d.mailbox_id = ${mailboxId}::uuid AND d.origin = 'user' AND d.state IN ('draft', 'scheduled', 'sending')
    ORDER BY d.updated_at DESC, d.id DESC
    LIMIT ${Math.min(Math.max(Math.floor(limit), 1), 200)}
  `;
  return ok(rows.map(mapDraft));
};

export const listConversationDrafts = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
  limit?: number;
}): Promise<Result<ConversationDraftSummary[]>> => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "read");
  if (!allowed.ok) return allowed;
  const rows = await sql<DbConversationDraftSummary[]>`
    SELECT
      d.id,
      d.short_id,
      d.intent,
      d.subject,
      LEFT(d.body_markdown, ${DRAFT_BODY_PREVIEW_SOURCE_LENGTH}) AS body_preview_source,
      COALESCE(
        NULLIF(author_user.display_name, ''),
        author_user.uid,
        author_service.name,
        CASE d.author_kind
          WHEN 'workflow' THEN 'Workflow'
          WHEN 'system' THEN 'Mail provider'
          WHEN 'user' THEN 'Former user'
          ELSE 'Former service account'
        END
      ) AS created_by_display_name,
      d.updated_at
    FROM mail.drafts d
    LEFT JOIN auth.users author_user ON d.author_kind = 'user' AND author_user.id = d.author_id
    LEFT JOIN auth.service_accounts author_service ON d.author_kind = 'service_account' AND author_service.id = d.author_id
    WHERE d.mailbox_id = ${params.mailboxId}::uuid
      AND d.conversation_id = ${params.conversationId}::uuid
      AND d.origin = 'user'
      AND d.state = 'draft'
    ORDER BY d.updated_at DESC, d.id DESC
    LIMIT ${Math.min(Math.max(Math.floor(params.limit ?? 20), 1), 50)}
  `;
  return ok(
    rows.map((row) => ({
      id: row.id,
      intent: row.intent,
      subject: row.subject,
      bodyPreview: draftBodyPreview(row.body_preview_source),
      createdByDisplayName: row.created_by_display_name,
      updatedAt: toIso(row.updated_at),
    })),
  );
};

export const getDraft = async (context: MailRequestContext, mailboxId: string, draftId: string): Promise<Result<MailDraft>> => {
  const allowed = await requireMailboxPermission(context, mailboxId, "read");
  if (!allowed.ok) return allowed;
  const [row] = await sql<DbDraft[]>`
    SELECT
      ${draftColumns},
      lifecycle.conversation_id AS lifecycle_conversation_id,
      CASE d.last_editor_kind
        WHEN 'user' THEN COALESCE(editor_user.display_name, 'Former user')
        WHEN 'service_account' THEN COALESCE(editor_service.name, 'Former service account')
        WHEN 'workflow' THEN 'Workflow'
        ELSE 'Mail provider'
      END AS last_editor_display_name
    FROM mail.drafts d
    LEFT JOIN auth.users editor_user ON d.last_editor_kind = 'user' AND editor_user.id = d.last_editor_id
    LEFT JOIN auth.service_accounts editor_service
      ON d.last_editor_kind = 'service_account' AND editor_service.id = d.last_editor_id
    LEFT JOIN LATERAL (
      SELECT link.conversation_id
      FROM mail.outbox_submissions outbox
      JOIN mail.conversation_messages link ON link.message_id = outbox.message_id
      WHERE outbox.draft_id = d.id
      ORDER BY outbox.created_at DESC, outbox.id DESC
      LIMIT 1
    ) lifecycle ON true
    WHERE d.id = ${draftId}::uuid AND d.mailbox_id = ${mailboxId}::uuid AND d.origin = 'user'
  `;
  return row ? ok(mapDraft(row)) : fail(err.notFound("Draft"));
};

export const listDraftRecoveryCopies = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  draftId: string;
}): Promise<Result<DraftRecoveryCopy[]>> => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "read");
  if (!allowed.ok) return allowed;
  const rows = await sql<DbRecoveryCopy[]>`
    SELECT ${recoveryColumns}
    FROM mail.draft_recovery_copies recovery
    JOIN mail.drafts draft ON draft.id = recovery.draft_id
    WHERE recovery.draft_id = ${params.draftId}::uuid
      AND draft.mailbox_id = ${params.mailboxId}::uuid
      AND draft.origin = 'user'
    ORDER BY recovery.created_at DESC, recovery.id DESC
    LIMIT 100
  `;
  return ok(rows.map(mapRecoveryCopy));
};

export const restoreDraftRecoveryCopy = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  draftId: string;
  recoveryCopyId: string;
  expectedRevision: number;
  leaseToken: string;
}): Promise<Result<MailDraft>> => {
  if (!Number.isInteger(params.expectedRevision) || params.expectedRevision < 1) return fail(err.badInput("Invalid draft revision"));
  const actor = mutableActor(params.context);
  if (!actor) return fail(err.forbidden("Draft editor is invalid"));
  const draftId = params.draftId;
  try {
    const result = await withOwnedDraftLease({
      context: params.context,
      mailboxId: params.mailboxId,
      draftId: params.draftId,
      token: params.leaseToken,
      operation: () =>
        sql.begin(async (tx) => {
          const allowed = await requireMailboxPermission(params.context, params.mailboxId, "write", tx);
          if (!allowed.ok) return allowed;
          const [draft] = await tx<{ revision: string | number; state: string }[]>`
        SELECT revision, state
        FROM mail.drafts
        WHERE id = ${draftId}::uuid AND mailbox_id = ${params.mailboxId}::uuid AND origin = 'user'
        FOR UPDATE
      `;
          if (!draft) return fail(err.notFound("Draft"));
          if (draft.state !== "draft") return fail(err.badInput("Draft can no longer be edited"));
          if (Number(draft.revision) !== params.expectedRevision)
            return conflict("Draft changed before the recovery copy could be restored");
          const [copy] = await tx<DbRecoveryCopy[]>`
        SELECT ${recoveryColumns}
        FROM mail.draft_recovery_copies recovery
        WHERE recovery.id = ${params.recoveryCopyId}::uuid
          AND recovery.draft_id = ${draftId}::uuid
          AND recovery.restored_at IS NULL
        FOR UPDATE
      `;
          if (!copy) return fail(err.notFound("Draft recovery copy"));
          const content = internalDraftEditableContentSchema.safeParse(parseRecord(copy.content));
          if (!content.success) return fail(err.internal("Draft recovery copy is invalid"));
          const identity = await validateIdentity({ mailboxId: params.mailboxId, senderIdentityId: content.data.senderIdentityId, db: tx });
          if (!identity.ok) return identity;
          const recoveryAttachments = copy.has_attachment_snapshot
            ? await tx<
                {
                  blob_id: string;
                  filename: string;
                  content_type: string;
                  byte_length: string | number;
                  content_hash: string;
                  position: number;
                }[]
              >`
                SELECT blob_id, filename, content_type, byte_length, content_hash, position
                FROM mail.draft_recovery_attachments
                WHERE recovery_copy_id = ${copy.id}::uuid
                ORDER BY position
              `
            : null;
          if (recoveryAttachments) {
            await tx`DELETE FROM mail.draft_attachments WHERE draft_id = ${draftId}::uuid`;
            for (const attachment of recoveryAttachments) {
              await withShortIdDb(
                tx,
                "draftAttachment",
                (db, shortId) => db`
                INSERT INTO mail.draft_attachments (
                  short_id, draft_id, blob_id, filename, content_type, byte_length, content_hash, position
                ) VALUES (
                  ${shortId},
                  ${draftId}::uuid,
                  ${attachment.blob_id}::uuid,
                  ${attachment.filename},
                  ${attachment.content_type},
                  ${Number(attachment.byte_length)},
                  ${attachment.content_hash},
                  ${attachment.position}
                )
              `,
              );
            }
          }
          const [updated] = await tx<DbDraft[]>`
        UPDATE mail.drafts d
        SET
          sender_identity_id = ${content.data.senderIdentityId}::uuid,
          to_addresses = ${content.data.to}::jsonb,
          cc_addresses = ${content.data.cc}::jsonb,
          bcc_addresses = ${content.data.bcc}::jsonb,
          subject = ${content.data.subject},
          body_markdown = ${content.data.body},
          body_format = ${content.data.format},
          priority = ${content.data.priority},
          request_delivery_receipt = ${content.data.requestDeliveryReceipt},
          request_read_receipt = ${content.data.requestReadReceipt},
          last_editor_kind = ${actor.kind},
          last_editor_id = ${actorId(actor)}::uuid,
          revision = revision + 1
        WHERE d.id = ${draftId}::uuid AND d.origin = 'user'
        RETURNING ${draftColumns}
      `;
          if (!updated) return fail(err.internal("Draft recovery returned no row"));
          await tx`
        UPDATE mail.draft_recovery_copies
        SET
          restored_at = now(),
          restored_by_kind = ${actor.kind},
          restored_by_id = ${actorId(actor)}::uuid,
          resulting_revision = ${Number(updated.revision)}
        WHERE id = ${copy.id}::uuid
      `;
          await insertActivity({
            db: tx,
            mailboxId: params.mailboxId,
            conversationId: updated.conversation_id,
            actor,
            action: "draft.recovery_restored",
            targetType: "draft",
            targetId: draftId,
            metadata: { recoveryCopyId: copy.id, revision: Number(updated.revision) },
          });
          await queueDraftProjectionInTransaction({ db: tx, draftId: updated.id });
          const [refreshed] = await tx<DbDraft[]>`
        SELECT ${draftColumns}
        FROM mail.drafts d
        WHERE d.id = ${draftId}::uuid AND d.origin = 'user'
      `;
          return refreshed ? ok(mapDraft(refreshed)) : fail(err.internal("Restored draft could not be reloaded"));
        }),
    });
    return wakeDraftProjection(result);
  } catch {
    return fail(err.internal("Failed to restore draft recovery copy"));
  }
};

export const sanitizeFilename = (value: string): string => {
  const normalized = value
    .normalize("NFC")
    .trim()
    .replace(/[\\/\u0000-\u001f\u007f]/g, "_");
  return [...normalized].slice(0, 255).join("") || "attachment";
};

export const sanitizeContentType = (value: string): string =>
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(value) ? value.toLowerCase() : "application/octet-stream";

export const removeDraftAttachment = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  draftId: string;
  attachmentId: string;
  expectedRevision: number;
}): Promise<Result<MailDraft>> => {
  if (!Number.isInteger(params.expectedRevision) || params.expectedRevision < 1) return fail(err.badInput("Invalid draft revision"));
  const actor = mutableActor(params.context);
  if (!actor) return fail(err.forbidden("Draft author is invalid"));
  try {
    const result = await sql.begin(async (tx) => {
      const allowed = await requireMailboxPermission(params.context, params.mailboxId, "write", tx);
      if (!allowed.ok) return allowed;
      const { draftId, attachmentId } = params;
      const [draft] = await tx<{ revision: string | number; state: string }[]>`
        SELECT revision, state FROM mail.drafts
        WHERE id = ${draftId}::uuid AND mailbox_id = ${params.mailboxId}::uuid AND origin = 'user'
        FOR UPDATE
      `;
      if (!draft) return fail(err.notFound("Draft"));
      if (draft.state !== "draft") return fail(err.badInput("Draft can no longer be edited"));
      if (Number(draft.revision) !== params.expectedRevision) return conflict("Draft changed before the attachment could be removed");
      const [removed] = await tx<{ id: string }[]>`
        UPDATE mail.draft_attachments
        SET removed_at = now()
        WHERE id = ${attachmentId}::uuid AND draft_id = ${draftId}::uuid AND removed_at IS NULL
        RETURNING id
      `;
      if (!removed) return fail(err.notFound("Draft attachment"));
      const [updated] = await tx<DbDraft[]>`
        UPDATE mail.drafts d
        SET
          revision = revision + 1,
          last_editor_kind = ${actor.kind},
          last_editor_id = ${actorId(actor)}::uuid
        WHERE d.id = ${draftId}::uuid AND d.origin = 'user'
        RETURNING ${draftColumns}
      `;
      if (!updated) return fail(err.internal("Draft attachment removal returned no draft"));
      await insertActivity({
        db: tx,
        mailboxId: params.mailboxId,
        conversationId: updated.conversation_id,
        actor,
        action: "draft.attachment_removed",
        targetType: "draft_attachment",
        targetId: removed.id,
        metadata: { draftId, revision: Number(updated.revision) },
      });
      await queueDraftProjectionInTransaction({ db: tx, draftId: updated.id });
      return ok(mapDraft(updated));
    });
    return wakeDraftProjection(result);
  } catch {
    return fail(err.internal("Failed to remove draft attachment"));
  }
};

export const openDraftAttachment = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  draftId: string;
  attachmentId: string;
}): Promise<Result<AttachmentDownload>> => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "read");
  if (!allowed.ok) return allowed;
  const { draftId, attachmentId } = params;
  const [attachment] = await sql<
    {
      blob_id: string;
      content_type: string;
      filename: string;
      content_hash: string;
      byte_length: string | number;
      chunk_size: number;
      chunk_count: number;
    }[]
  >`
    SELECT
      attachment.blob_id,
      attachment.content_type,
      attachment.filename,
      blob.content_hash,
      blob.byte_length,
      blob.chunk_size,
      blob.chunk_count
    FROM mail.draft_attachments attachment
    JOIN mail.drafts draft ON draft.id = attachment.draft_id
    JOIN mail.message_part_blobs blob ON blob.id = attachment.blob_id AND blob.complete = true
    WHERE attachment.id = ${attachmentId}::uuid
      AND attachment.draft_id = ${draftId}::uuid
      AND attachment.removed_at IS NULL
      AND draft.mailbox_id = ${params.mailboxId}::uuid
      AND draft.origin = 'user'
  `;
  if (!attachment) return fail(err.notFound("Draft attachment"));
  const total = Number(attachment.byte_length);
  if (!Number.isSafeInteger(total) || total < 0 || attachment.chunk_size <= 0 || attachment.chunk_count < 0) {
    return fail(err.internal("Draft attachment metadata is invalid"));
  }
  return ok({
    blobId: attachment.blob_id,
    total,
    chunkSize: attachment.chunk_size,
    chunkCount: attachment.chunk_count,
    contentHash: attachment.content_hash,
    contentType: attachment.content_type,
    filename: attachment.filename,
  });
};

export const discardDraft = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  draftId: string;
  expectedRevision: number;
}): Promise<Result<MailDraft>> => {
  if (!Number.isInteger(params.expectedRevision) || params.expectedRevision < 1) return fail(err.badInput("Invalid draft revision"));
  const actor = mutableActor(params.context);
  if (!actor) return fail(err.forbidden("Draft author is invalid"));
  try {
    let retirementSnapshotId: string | null = null;
    const result = await sql.begin(async (tx) => {
      const allowed = await requireMailboxPermission(params.context, params.mailboxId, "write", tx);
      if (!allowed.ok) return allowed;
      const draftId = params.draftId;
      const [updated] = await tx<DbDraft[]>`
        UPDATE mail.drafts d
        SET
          state = 'discarded',
          revision = revision + 1,
          last_editor_kind = ${actor.kind},
          last_editor_id = ${actorId(actor)}::uuid
        WHERE d.id = ${draftId}::uuid
          AND d.mailbox_id = ${params.mailboxId}::uuid
          AND d.origin = 'user'
          AND d.state = 'draft'
          AND d.revision = ${params.expectedRevision}
        RETURNING ${draftColumns}
      `;
      if (!updated) {
        const [current] = await tx<{ revision: string | number; state: string }[]>`
          SELECT revision, state FROM mail.drafts
          WHERE id = ${draftId}::uuid AND mailbox_id = ${params.mailboxId}::uuid AND origin = 'user'
        `;
        if (!current) return fail(err.notFound("Draft"));
        if (current.state !== "draft") return fail(err.badInput("Draft can no longer be discarded"));
        return conflict("Draft changed before it could be discarded");
      }
      await insertActivity({
        db: tx,
        mailboxId: params.mailboxId,
        conversationId: updated.conversation_id,
        actor,
        action: "draft.discarded",
        targetType: "draft",
        targetId: draftId,
        metadata: { revision: Number(updated.revision) },
      });
      retirementSnapshotId = await queueDraftProjectionInTransaction({ db: tx, draftId: updated.id });
      return ok(mapDraft(updated));
    });
    if (result.ok) await notifyMailInvalidations();
    if (result.ok && retirementSnapshotId) await enqueueDraftProjectionSnapshot(retirementSnapshotId);
    return result;
  } catch {
    return fail(err.internal("Failed to discard draft"));
  }
};
