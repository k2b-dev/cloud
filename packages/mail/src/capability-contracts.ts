import { CapabilitySemanticLinkSchema } from "@valentinkolb/cloud/contracts";
import { z } from "zod";
import {
  composeSafetyApprovalSchema,
  composeSafetyReviewSchema,
  draftEditableContentInputSchema,
  type MailSearchExpression,
  mailAddressSchema,
  mailComposeFormatSchema,
  mailFocusViewSchema,
  mailPrioritySchema,
  mailSearchAllSchema,
  mailSearchAssignedToMeSchema,
  mailSearchAssigneeSchema,
  mailSearchDateSchema,
  mailSearchFolderIdSchema,
  mailSearchSizeSchema,
  mailSearchSnoozedSchema,
  mailSearchTermSchema,
  mailSearchWorkStatusSchema,
  ResourceShortIdSchema,
} from "./contracts";

const TimestampSchema = z.string().datetime({ offset: true });
const NullableTimestampSchema = TimestampSchema.nullable();
const NullableTextSchema = z.string().nullable();
const UuidSchema = z.uuid();
const MailboxIdInputSchema = ResourceShortIdSchema.describe(
  "Exact mail.mailbox ID returned by List mailboxes or a typed mailbox ref.",
);
const ConversationIdInputSchema = ResourceShortIdSchema.describe(
  "Exact mail.conversation ID returned by a conversation list, search, focus result, or typed conversation ref.",
);
const DraftIdInputSchema = ResourceShortIdSchema.describe("Exact mail.draft ID returned by List drafts or a typed draft ref.");
const ExpectedRevisionInputSchema = z.number().int().positive().describe("Current resource revision used for optimistic concurrency.");
const CursorSchema = z.string().min(1).max(2048).optional().describe("Opaque cursor returned by the previous page.");
const LimitSchema = z.number().int().min(1).max(100).default(25).describe("Maximum number of results to return.");
const PageInputShape = { cursor: CursorSchema, limit: LimitSchema };
const VocabularyLimitSchema = z.number().int().min(1).max(50).default(25).describe("Maximum number of results to return.");
const VocabularyPageInputShape = { cursor: CursorSchema, limit: VocabularyLimitSchema };
const OptionalResourceLinksShape = { links: z.array(CapabilitySemanticLinkSchema).min(1).max(10).optional() };
const resourceRefSchema = <Type extends string>(type: Type) =>
  z.object({ type: z.literal(type), id: ResourceShortIdSchema }).strict();
const MailboxRefSchema = resourceRefSchema("mail.mailbox");
const ConversationRefSchema = resourceRefSchema("mail.conversation");
const MessageRefSchema = resourceRefSchema("mail.message");
const DraftRefSchema = resourceRefSchema("mail.draft");
const DeliveryRefSchema = resourceRefSchema("mail.delivery");
const CommentRefSchema = resourceRefSchema("mail.comment");
const CapabilityMailSearchLeafSchema = z.discriminatedUnion("type", [
  mailSearchTermSchema,
  mailSearchDateSchema,
  mailSearchSizeSchema,
  mailSearchWorkStatusSchema,
  mailSearchAssigneeSchema,
  mailSearchSnoozedSchema,
  mailSearchAllSchema,
  mailSearchFolderIdSchema,
  mailSearchAssignedToMeSchema,
]);
const CapabilityMailSearchExpressionSchema: z.ZodType<MailSearchExpression> = z.union([
  mailSearchTermSchema,
  mailSearchDateSchema,
  mailSearchSizeSchema,
  mailSearchWorkStatusSchema,
  mailSearchAssigneeSchema,
  mailSearchSnoozedSchema,
  mailSearchAllSchema,
  mailSearchFolderIdSchema,
  mailSearchAssignedToMeSchema,
  z
    .object({
      type: z.literal("and").describe("Require every nested expression."),
      expressions: z.array(CapabilityMailSearchLeafSchema).min(1).max(20).describe("Leaf expressions that must all match."),
    })
    .strict(),
  z
    .object({
      type: z.literal("or").describe("Require at least one nested expression."),
      expressions: z.array(CapabilityMailSearchLeafSchema).min(1).max(20).describe("Alternative leaf expressions."),
    })
    .strict(),
  z
    .object({
      type: z.literal("not").describe("Negate one nested expression."),
      expression: CapabilityMailSearchLeafSchema.describe("Leaf expression that must not match."),
    })
    .strict(),
]);

export const MailboxDataSchema = z
  .object({
    id: ResourceShortIdSchema,
    name: z.string().min(1).max(160),
    description: z.string().max(2000).nullable(),
    descriptionTruncated: z.boolean(),
    permission: z.enum(["read", "write", "admin"]),
    health: z.enum([
      "disconnected",
      "verifying",
      "bootstrapping",
      "active",
      "auth_required",
      "degraded",
      "reconnecting",
      "connection_required",
      "paused",
    ]),
    healthReason: z.string().max(1000).nullable(),
    healthReasonTruncated: z.boolean(),
    syncEnabled: z.boolean(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export const MailboxListDataSchema = z
  .array(MailboxDataSchema.extend({ ref: MailboxRefSchema, ...OptionalResourceLinksShape }).strict())
  .max(100);
export const MailboxListInputSchema = z
  .object({
    query: z.string().trim().max(500).optional().describe("Optional mailbox name or description search."),
    minimumPermission: z.enum(["read", "write", "admin"]).default("read").describe("Minimum mailbox permission to include."),
    cursor: CursorSchema,
    limit: LimitSchema,
  })
  .strict();
const resourceReadInputSchema = (type: string, source: string) =>
  z.object({ id: ResourceShortIdSchema.describe(`Exact ${type} ID returned by ${source} or a typed resource ref.`) }).strict();
export const MailboxReadInputSchema = resourceReadInputSchema("mail.mailbox", "List mailboxes");
export const ConversationReadInputSchema = resourceReadInputSchema(
  "mail.conversation",
  "a conversation list, search, or focus result",
);
export const MessageReadInputSchema = resourceReadInputSchema("mail.message", "List conversation messages or Search mail");
export const AttachmentReadInputSchema = resourceReadInputSchema("mail.attachment", "message attachment metadata");
export const DraftReadInputSchema = resourceReadInputSchema("mail.draft", "List drafts");
export const CommentReadInputSchema = resourceReadInputSchema("mail.comment", "List conversation comments");
export const ReminderReadInputSchema = resourceReadInputSchema("mail.reminder", "Get personal reminder");
export const DeliveryReadInputSchema = resourceReadInputSchema("mail.delivery", "List scheduled deliveries");

export const SenderIdentityDataSchema = z
  .object({
    id: ResourceShortIdSchema,
    mailboxId: ResourceShortIdSchema,
    label: z.string().min(1).max(200),
    displayName: z.string().max(200),
    fromAddress: z.email(),
    replyTo: z.email().nullable(),
    defaultCc: z.array(mailAddressSchema).max(10),
    defaultBcc: z.array(mailAddressSchema).max(10),
    recipientsTruncated: z.boolean(),
    defaultFormat: mailComposeFormatSchema,
    defaultPriority: mailPrioritySchema,
    defaultDeliveryReceipt: z.boolean(),
    defaultReadReceipt: z.boolean(),
    isDefault: z.boolean(),
    status: z.enum(["unverified", "verified", "rejected"]),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export const SenderIdentityListDataSchema = z.array(SenderIdentityDataSchema).max(100);
export const SenderIdentityListInputSchema = z.object({ mailboxId: MailboxIdInputSchema, ...VocabularyPageInputShape }).strict();

export const MailboxMemberDataSchema = z
  .object({
    id: UuidSchema,
    uid: z.string().min(1),
    displayName: z.string().min(1),
    avatarHash: NullableTextSchema,
    permission: z.enum(["read", "write", "admin"]),
    description: z.string().min(1),
  })
  .strict();
export const MailboxMemberListDataSchema = z.array(MailboxMemberDataSchema).max(100);
export const MailboxMemberListInputSchema = z
  .object({
    mailboxId: MailboxIdInputSchema,
    query: z.string().trim().max(500).optional().describe("Optional member name or user identifier search."),
    cursor: CursorSchema,
    limit: LimitSchema,
  })
  .strict();

export const FolderDataSchema = z
  .object({
    id: ResourceShortIdSchema,
    parentId: ResourceShortIdSchema.nullable(),
    name: z.string().min(1).max(500),
    nameTruncated: z.boolean(),
    role: z.string().min(1),
    selectable: z.boolean(),
    showInSidebar: z.boolean(),
    total: z.number().int().nonnegative(),
    unread: z.number().int().nonnegative(),
    ...OptionalResourceLinksShape,
  })
  .strict();
export const FolderListDataSchema = z.array(FolderDataSchema).max(100);
export const FolderListInputSchema = z.object({ mailboxId: MailboxIdInputSchema, ...VocabularyPageInputShape }).strict();

export const ConversationDataSchema = z
  .object({
    ref: ConversationRefSchema,
    id: ResourceShortIdSchema,
    mailboxId: ResourceShortIdSchema,
    primaryReference: z.string().max(500).nullable(),
    subject: z.string().max(500),
    subjectTruncated: z.boolean(),
    participantSummary: z.string().max(500),
    participantSummaryTruncated: z.boolean(),
    participantLabels: z.array(z.string().max(128)).max(10),
    participantLabelsTruncated: z.boolean(),
    latestMessageAt: TimestampSchema,
    workStatus: z.enum(["needs_action", "waiting", "done"]),
    assigneeUserId: UuidSchema.nullable(),
    snoozedUntil: NullableTimestampSchema,
    revision: z.number().int().positive(),
    updatedAt: TimestampSchema,
    unread: z.boolean(),
    activeFolderIds: z.array(ResourceShortIdSchema).max(20),
    activeFolderIdsTruncated: z.boolean(),
    flagged: z.boolean(),
    hasAttachments: z.boolean(),
    messageCount: z.number().int().nonnegative(),
    preview: z.string().max(1000).nullable(),
    previewTruncated: z.boolean(),
    ...OptionalResourceLinksShape,
  })
  .strict();
export const ConversationListDataSchema = z.array(ConversationDataSchema).max(100);
export const ConversationListInputSchema = z
  .object({
    mailboxId: MailboxIdInputSchema,
    folderId: ResourceShortIdSchema.nullable().optional().describe("Optional provider folder ID filter."),
    workStatus: z.enum(["needs_action", "waiting", "done"]).nullable().optional().describe("Optional collaboration work-status filter."),
    unread: z.boolean().nullable().optional().describe("Optional unread-state filter; true returns only conversations with unread mail."),
    view: z
      .enum(["needs_action", "mine", "unassigned", "waiting", "done", "snoozed", "recently_active"])
      .nullable()
      .optional()
      .describe("Optional saved work queue view."),
    cursor: CursorSchema,
    limit: VocabularyLimitSchema,
  })
  .strict();

export const ConversationFocusDataSchema = z
  .object({
    ref: ConversationRefSchema,
    id: ResourceShortIdSchema,
    mailboxId: ResourceShortIdSchema,
    mailboxName: z.string().min(1).max(160),
    subject: z.string().max(500),
    subjectTruncated: z.boolean(),
    participantSummary: z.string().max(500),
    participantSummaryTruncated: z.boolean(),
    latestMessageAt: TimestampSchema,
    workStatus: z.enum(["needs_action", "waiting", "done"]),
    assigneeUserId: UuidSchema.nullable(),
    unread: z.boolean(),
    flagged: z.boolean(),
    hasAttachments: z.boolean(),
    preview: z.string().max(320).nullable(),
    ...OptionalResourceLinksShape,
  })
  .strict();
export const ConversationFocusListDataSchema = z.array(ConversationFocusDataSchema).max(100);
export const ConversationFocusInputSchema = z
  .object({
    view: mailFocusViewSchema.default("mine").describe("Cross-mailbox work queue to list."),
    cursor: CursorSchema,
    limit: VocabularyLimitSchema,
  })
  .strict();

export const ConversationSearchInputSchema = z
  .object({
    mailboxId: MailboxIdInputSchema,
    expression: CapabilityMailSearchExpressionSchema.describe("Structured, bounded mail search expression."),
    sort: z.enum(["relevance", "newest"]).default("relevance").describe("Result ordering."),
    cursor: CursorSchema,
    limit: VocabularyLimitSchema,
  })
  .strict();
export const AttachmentSearchMatchDataSchema = z
  .object({
    attachmentId: ResourceShortIdSchema,
    messageId: ResourceShortIdSchema,
    filename: z.string().max(255).nullable(),
    snippet: z.string().max(500),
    reason: z.literal("attachment_content"),
    openHref: z.string().startsWith("/app/mail/"),
    downloadHref: z.string().startsWith("/api/mail/"),
  })
  .strict();
export const ConversationSearchItemDataSchema = ConversationDataSchema.extend({
  attachmentMatch: AttachmentSearchMatchDataSchema.nullable(),
}).strict();
export const ConversationSearchDataSchema = z.array(ConversationSearchItemDataSchema).max(100);

export const ConversationRelatedInputSchema = z
  .object({
    mailboxId: MailboxIdInputSchema,
    conversationId: ConversationIdInputSchema.describe("Conversation whose related Mail should be found."),
    limit: z.number().int().min(1).max(10).default(5).describe("Maximum number of related conversations to return."),
  })
  .strict();
export const ConversationRelatedReasonSchema = z
  .object({
    kind: z.enum(["participant", "subject"]),
    value: z.string().min(1).max(500),
  })
  .strict();
export const ConversationRelatedDataSchema = z
  .array(
    z
      .object({
        ref: ConversationRefSchema,
        id: ResourceShortIdSchema,
        subject: z.string().max(2_000),
        participantSummary: z.string().max(2_000),
        latestMessageAt: TimestampSchema,
        preview: z.string().max(240).nullable(),
        reasons: z.array(ConversationRelatedReasonSchema).min(1).max(6),
        ...OptionalResourceLinksShape,
      })
      .strict(),
  )
  .max(10);

const AddressDataSchema = z.object({ name: z.string().max(200).nullable(), address: z.email() }).strict();
export const AttachmentDataSchema = z
  .object({
    id: ResourceShortIdSchema,
    filename: z.string().max(255).nullable(),
    contentType: z.string().min(1).max(255),
    sizeBytes: z.number().int().nonnegative(),
    downloadHref: z.string().startsWith("/api/mail/"),
  })
  .strict();
export const AttachmentExtractionStatusSchema = z.enum([
  "pending",
  "complete",
  "unsupported",
  "encrypted",
  "ocr_required",
  "resource_limit",
  "malformed",
  "failed",
]);
export const AttachmentExtractionMetadataSchema = z
  .object({
    status: AttachmentExtractionStatusSchema,
    extractorVersion: z.string().min(1).max(100),
    available: z.boolean(),
    format: z.string().max(100).nullable(),
    inputBytes: z.number().int().nonnegative().nullable(),
    outputBytes: z.number().int().nonnegative().nullable(),
    truncated: z.boolean(),
    errorCode: z.string().max(100).nullable(),
    updatedAt: TimestampSchema.nullable(),
  })
  .strict();
export const AttachmentReadDataSchema = AttachmentDataSchema.extend({ extraction: AttachmentExtractionMetadataSchema }).strict();
export const AttachmentContentReadInputSchema = z
  .object({
    id: ResourceShortIdSchema.describe("Stable attachment ID."),
    offset: z.number().int().nonnegative().default(0).describe("UTF-8 byte offset. Continue with nextOffset from the previous page."),
    length: z
      .number()
      .int()
      .min(256)
      .max(64 * 1024)
      .default(16 * 1024)
      .describe("Maximum UTF-8 bytes to return."),
  })
  .strict();
export const AttachmentContentReadDataSchema = AttachmentReadDataSchema.extend({
  messageId: ResourceShortIdSchema,
  markdown: z
    .string()
    .max(64 * 1024)
    .nullable(),
  offset: z.number().int().nonnegative(),
  length: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative().nullable(),
  nextOffset: z.number().int().positive().nullable(),
  trust: z.literal("untrusted"),
}).strict();
const HeaderDataSchema = z
  .object({
    name: z.string().min(1).max(128),
    value: z.string().max(2048),
  })
  .strict();
export const MessageSummaryDataSchema = z
  .object({
    id: ResourceShortIdSchema,
    mailboxId: ResourceShortIdSchema,
    conversationId: ResourceShortIdSchema.nullable(),
    subject: z.string().max(998),
    subjectTruncated: z.boolean(),
    messageId: z.string().max(998).nullable(),
    internalDate: TimestampSchema,
    sentAt: NullableTimestampSchema,
    from: z.array(AddressDataSchema).max(5),
    to: z.array(AddressDataSchema).max(5),
    addressesTruncated: z.boolean(),
    flags: z.array(z.string().max(128)).max(10),
    flagsTruncated: z.boolean(),
    keywords: z.array(z.string().max(128)).max(10),
    keywordsTruncated: z.boolean(),
    hydrationStatus: z.string().min(1).max(100),
    remoteAvailable: z.boolean(),
  })
  .strict();
export const NavigableMessageSummaryDataSchema = MessageSummaryDataSchema.extend({
  ref: MessageRefSchema,
  ...OptionalResourceLinksShape,
}).strict();
export const MessageListDataSchema = z.array(NavigableMessageSummaryDataSchema).max(100);
export const MessageListInputSchema = z
  .object({
    mailboxId: MailboxIdInputSchema,
    conversationId: ConversationIdInputSchema,
    cursor: CursorSchema,
    limit: VocabularyLimitSchema,
  })
  .strict();
export const MessageDataSchema = MessageSummaryDataSchema.extend({
  from: z.array(AddressDataSchema).max(20),
  to: z.array(AddressDataSchema).max(20),
  contentType: z.string().max(255).nullable(),
  sizeBytes: z.number().int().nonnegative(),
  replyTo: z.array(AddressDataSchema).max(20),
  cc: z.array(AddressDataSchema).max(20),
  detailAddressesTruncated: z.boolean(),
  headers: z.array(HeaderDataSchema).max(25),
  headersTruncated: z.boolean(),
  text: z
    .string()
    .max(96 * 1024)
    .nullable(),
  bodyTruncated: z.boolean(),
  attachments: z.array(AttachmentDataSchema).max(50),
  attachmentsTruncated: z.boolean(),
  delivery: z
    .object({
      id: ResourceShortIdSchema,
      state: z.string().min(1),
      scheduledAt: TimestampSchema,
      undoUntil: NullableTimestampSchema,
      acceptedAt: NullableTimestampSchema,
      errorCode: z.string().max(200).nullable(),
      errorMessage: z.string().max(1000).nullable(),
    })
    .strict()
    .nullable(),
}).strict();

export const ConversationGetDataSchema = z
  .object({
    conversationId: ResourceShortIdSchema,
    summary: z
      .string()
      .max(50_000)
      .nullable()
      .describe("Shared editable conversation context. It can be absent or lag behind the latest messages."),
    summaryRevision: z.number().int().positive().describe("Revision to use when updating the shared summary."),
    collaboration: z
      .object({
        assignee: z
          .object({ id: UuidSchema, uid: z.string(), displayName: z.string(), avatarHash: NullableTextSchema })
          .strict()
          .nullable(),
        workStatus: z.enum(["needs_action", "waiting", "done"]),
        snoozedUntil: NullableTimestampSchema,
        revision: z.number().int().positive(),
      })
      .strict(),
    tags: z
      .array(z.object({ id: ResourceShortIdSchema, name: z.string(), color: z.string(), revision: z.number().int().positive() }).strict())
      .max(100),
    messages: z.array(NavigableMessageSummaryDataSchema).max(100),
    messagesTruncated: z.boolean().describe("True when earlier messages exist outside this latest-message window."),
  })
  .strict();

const DraftAttachmentDataSchema = z
  .object({
    id: ResourceShortIdSchema,
    filename: z.string().max(255),
    contentType: z.string().max(255),
    byteLength: z.number().int().nonnegative(),
    contentHash: z.string().length(64),
    position: z.number().int().nonnegative(),
    createdAt: TimestampSchema,
  })
  .strict();
export const DraftDataSchema = z
  .object({
    id: ResourceShortIdSchema,
    mailboxId: ResourceShortIdSchema,
    conversationId: ResourceShortIdSchema.nullable(),
    intent: z.enum(["new", "reply", "reply_all", "forward"]),
    sourceMessageId: ResourceShortIdSchema.nullable(),
    senderIdentityId: ResourceShortIdSchema,
    to: z.array(mailAddressSchema).max(50),
    cc: z.array(mailAddressSchema).max(50),
    bcc: z.array(mailAddressSchema).max(50),
    subject: z.string().max(998),
    body: z.string().max(64 * 1024),
    bodyTruncated: z.boolean(),
    format: mailComposeFormatSchema,
    priority: mailPrioritySchema,
    requestDeliveryReceipt: z.boolean(),
    requestReadReceipt: z.boolean(),
    toTruncated: z.boolean(),
    ccTruncated: z.boolean(),
    bccTruncated: z.boolean(),
    attachments: z.array(DraftAttachmentDataSchema).max(50),
    attachmentsTruncated: z.boolean(),
    revision: z.number().int().positive(),
    state: z.enum(["draft", "scheduled", "sending", "sent", "discarded"]),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export const DraftSummaryDataSchema = z
  .object({
    ref: DraftRefSchema,
    id: ResourceShortIdSchema,
    mailboxId: ResourceShortIdSchema,
    conversationId: ResourceShortIdSchema.nullable(),
    intent: z.enum(["new", "reply", "reply_all", "forward"]),
    senderIdentityId: ResourceShortIdSchema,
    subject: z.string().max(500),
    subjectTruncated: z.boolean(),
    bodyPreview: z.string().max(1000),
    bodyTruncated: z.boolean(),
    format: mailComposeFormatSchema,
    priority: mailPrioritySchema,
    attachmentCount: z.number().int().nonnegative(),
    revision: z.number().int().positive(),
    state: z.enum(["draft", "scheduled", "sending", "sent", "discarded"]),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    ...OptionalResourceLinksShape,
  })
  .strict();
export const DraftListDataSchema = z.array(DraftSummaryDataSchema).max(100);
export const DraftListInputSchema = z.object({ mailboxId: MailboxIdInputSchema, ...PageInputShape }).strict();
export const DraftSendReviewInputSchema = z
  .object({ mailboxId: MailboxIdInputSchema, draftId: DraftIdInputSchema, expectedRevision: ExpectedRevisionInputSchema })
  .strict();
export const DraftSendReviewDataSchema = composeSafetyReviewSchema;

const InlineAttachmentInputSchema = z
  .object({
    filename: z.string().trim().min(1).max(255).describe("Attachment filename shown to recipients."),
    contentType: z.string().trim().min(1).max(255).default("application/octet-stream").describe("Attachment MIME type."),
    base64: z
      .string()
      .min(1)
      .max(140 * 1024)
      .describe("Base64-encoded content; decoded content is limited to 105 KiB."),
  })
  .strict();
export const DraftCreateInputSchema = z
  .object({
    mailboxId: MailboxIdInputSchema,
    senderIdentityId: ResourceShortIdSchema.describe("Verified sender-identity ID."),
    to: z.array(mailAddressSchema).max(200).default([]).describe("Primary recipients."),
    cc: z.array(mailAddressSchema).max(200).default([]).describe("Carbon-copy recipients."),
    bcc: z.array(mailAddressSchema).max(200).default([]).describe("Blind-carbon-copy recipients."),
    subject: z.string().max(998).default("").describe("Message subject."),
    body: z
      .string()
      .max(64 * 1024)
      .default("")
      .describe("Editable message body, limited to 64 KiB, in the selected format."),
    format: mailComposeFormatSchema.default("markdown").describe("Editable message body format."),
    priority: mailPrioritySchema.default("normal").describe("Message priority hint."),
    requestDeliveryReceipt: z.boolean().default(false).describe("Whether to request a delivery receipt."),
    requestReadReceipt: z.boolean().default(false).describe("Whether to request a read receipt."),
    intent: z.enum(["new", "reply", "reply_all", "forward"]).default("new").describe("Compose intent."),
    conversationId: ResourceShortIdSchema.nullable().optional().describe("Conversation ID for a reply or forward."),
    sourceMessageId: ResourceShortIdSchema.nullable().optional().describe("Source message ID for a reply or forward."),
    includeSourceAttachments: z.boolean().default(false).describe("Whether to copy eligible source attachments."),
    attachments: z.array(InlineAttachmentInputSchema).max(1).default([]).describe("Optional small inline attachment to add to the draft."),
  })
  .strict();
export const DraftUpdateInputSchema = z
  .object({
    mailboxId: MailboxIdInputSchema,
    draftId: DraftIdInputSchema,
    expectedRevision: ExpectedRevisionInputSchema,
    draft: draftEditableContentInputSchema.describe("Complete editable draft content replacing the current content."),
  })
  .strict();
export const DraftDiscardInputSchema = z
  .object({ mailboxId: MailboxIdInputSchema, draftId: DraftIdInputSchema, expectedRevision: ExpectedRevisionInputSchema })
  .strict();
export const DraftAttachmentAddInputSchema = z
  .object({
    mailboxId: MailboxIdInputSchema,
    draftId: DraftIdInputSchema,
    expectedRevision: ExpectedRevisionInputSchema,
    attachment: InlineAttachmentInputSchema.describe("Attachment to add."),
  })
  .strict();
export const DraftAttachmentRemoveInputSchema = z
  .object({
    mailboxId: MailboxIdInputSchema,
    draftId: DraftIdInputSchema,
    attachmentId: ResourceShortIdSchema.describe("Draft attachment ID."),
    expectedRevision: ExpectedRevisionInputSchema,
  })
  .strict();
export const DraftSendInputSchema = z
  .object({
    mailboxId: MailboxIdInputSchema,
    draftId: DraftIdInputSchema,
    expectedRevision: ExpectedRevisionInputSchema,
    senderIdentityId: ResourceShortIdSchema.describe("Verified sender-identity ID."),
    scheduledAt: TimestampSchema.optional().describe("Optional future delivery time."),
    undoSeconds: z.number().int().min(0).max(60).default(10).describe("Undo-send window in seconds."),
    safetyApproval: composeSafetyApprovalSchema.optional().describe("Exact approval returned by draft.send.review when warnings exist."),
  })
  .strict();
export const DraftSendDataSchema = z
  .object({
    commandId: UuidSchema,
    state: z.string().min(1),
    draftId: ResourceShortIdSchema,
    conversationId: ResourceShortIdSchema.nullable(),
  })
  .strict();

export const DeliveryDataSchema = z
  .object({
    id: ResourceShortIdSchema,
    commandId: UuidSchema,
    draftId: ResourceShortIdSchema,
    conversationId: ResourceShortIdSchema.nullable(),
    subject: z.string().max(998),
    scheduledAt: TimestampSchema,
    nextAttemptAt: NullableTimestampSchema,
    state: z.enum(["scheduled", "undo_window"]),
    attempt: z.number().int().nonnegative(),
    lastError: z.string().max(1000).nullable(),
    createdAt: TimestampSchema,
  })
  .strict();
export const DeliveryListDataSchema = z.array(DeliveryDataSchema.extend({ ref: DeliveryRefSchema }).strict()).max(100);
export const DeliveryListInputSchema = z.object({ mailboxId: MailboxIdInputSchema, ...PageInputShape }).strict();
export const DeliveryCancelInputSchema = z
  .object({
    mailboxId: MailboxIdInputSchema,
    deliveryId: ResourceShortIdSchema.describe("Scheduled-delivery ID."),
    disposition: z.enum(["draft", "discard"]).default("draft").describe("Whether cancellation restores or discards the draft."),
  })
  .strict();
export const DeliveryCancelDataSchema = z.object({ disposition: z.enum(["draft", "discard"]), draftId: ResourceShortIdSchema }).strict();

const ConversationTargetSchema = z
  .object({
    conversationId: ConversationIdInputSchema,
    sourceFolderId: ResourceShortIdSchema.describe("Provider folder ID from which the conversation is being changed."),
  })
  .strict();
export const ConversationMarkInputSchema = z
  .object({
    mailboxId: MailboxIdInputSchema,
    target: ConversationTargetSchema.describe("Conversation and its current provider folder."),
    read: z.boolean().optional().describe("Set true to mark read or false to mark unread."),
    flagged: z.boolean().optional().describe("Set true to flag or false to unflag."),
  })
  .strict()
  .refine((value) => value.read !== undefined || value.flagged !== undefined, "At least one state change is required");
export const ConversationMoveInputSchema = z
  .object({
    mailboxId: MailboxIdInputSchema,
    target: ConversationTargetSchema.describe("Conversation and its current provider folder."),
    destination: z
      .discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("role").describe("Move to a standard folder role."),
            role: z.enum(["inbox", "archive", "trash", "junk"]).describe("Standard destination role."),
          })
          .strict(),
        z
          .object({
            kind: z.literal("folder").describe("Move to a provider folder."),
            folderId: ResourceShortIdSchema.describe("Destination provider folder ID."),
          })
          .strict(),
      ])
      .describe("Provider destination role or folder."),
  })
  .strict();
export const ConversationMutationItemDataSchema = z
  .object({
    conversationId: ResourceShortIdSchema,
    correlationId: z.string().min(1),
    commands: z.array(z.object({ id: UuidSchema, state: z.string().min(1) }).strict()).max(500),
  })
  .strict();
export const ConversationMutationDataSchema = ConversationMutationItemDataSchema;

export const TagDataSchema = z
  .object({
    id: ResourceShortIdSchema,
    mailboxId: ResourceShortIdSchema,
    name: z.string().min(1),
    color: z.string().regex(/^#[0-9a-f]{6}$/),
    revision: z.number().int().positive(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export const TagListDataSchema = z.array(TagDataSchema).max(100);
export const TagListInputSchema = z.object({ mailboxId: MailboxIdInputSchema, ...VocabularyPageInputShape }).strict();
export const ConversationTagUpdateInputSchema = z
  .object({
    mailboxId: MailboxIdInputSchema,
    conversationId: ConversationIdInputSchema,
    expectedRevision: ExpectedRevisionInputSchema,
    addTagIds: z.array(ResourceShortIdSchema).max(100).default([]).describe("Tag IDs to add."),
    removeTagIds: z.array(ResourceShortIdSchema).max(100).default([]).describe("Tag IDs to remove."),
  })
  .strict()
  .refine((value) => value.addTagIds.length > 0 || value.removeTagIds.length > 0, "At least one tag change is required");
export const ConversationTagDataSchema = z
  .object({
    conversationId: ResourceShortIdSchema,
    conversationRevision: z.number().int().positive(),
    tags: z.array(TagDataSchema).max(100),
  })
  .strict();
export const TagCreateInputSchema = z
  .object({
    mailboxId: MailboxIdInputSchema,
    name: z.string().trim().min(1).max(80).describe("Tag name."),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .describe("Tag color as a six-digit hexadecimal value."),
  })
  .strict();
export const TagUpdateInputSchema = z
  .object({
    mailboxId: MailboxIdInputSchema,
    tagId: ResourceShortIdSchema.describe("Tag ID."),
    expectedRevision: ExpectedRevisionInputSchema,
    name: z.string().trim().min(1).max(80).optional().describe("Replacement tag name."),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional()
      .describe("Replacement tag color as a six-digit hexadecimal value."),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.color !== undefined, "At least one tag field is required");
export const TagDeleteInputSchema = z
  .object({
    mailboxId: MailboxIdInputSchema,
    tagId: ResourceShortIdSchema.describe("Tag ID."),
    expectedRevision: ExpectedRevisionInputSchema,
  })
  .strict();
export const DeletedDataSchema = z.object({ deleted: z.literal(true) }).strict();

const CollaboratorDataSchema = z
  .object({ id: UuidSchema, uid: z.string(), displayName: z.string(), avatarHash: NullableTextSchema })
  .strict();
export const CollaborationDataSchema = z
  .object({
    conversationId: ResourceShortIdSchema,
    assignee: CollaboratorDataSchema.nullable(),
    workStatus: z.enum(["needs_action", "waiting", "done"]),
    snoozedUntil: NullableTimestampSchema,
    revision: z.number().int().positive(),
  })
  .strict();
const CollaborationMutationBaseShape = {
  mailboxId: MailboxIdInputSchema,
  conversationId: ConversationIdInputSchema,
  expectedRevision: ExpectedRevisionInputSchema,
};
export const ConversationAssignInputSchema = z
  .object({
    ...CollaborationMutationBaseShape,
    assigneeUserId: UuidSchema.nullable().describe("User UUID to assign, or null to unassign."),
  })
  .strict();
export const ConversationStatusUpdateInputSchema = z
  .object({
    ...CollaborationMutationBaseShape,
    status: z.enum(["done", "open"]).describe("Mark the conversation done or reopen it."),
  })
  .strict();
export const ConversationSnoozeInputSchema = z
  .object({
    ...CollaborationMutationBaseShape,
    snoozedUntil: NullableTimestampSchema.describe("Snooze deadline, or null to clear it."),
  })
  .strict();

export const ReminderDataSchema = z
  .object({
    id: ResourceShortIdSchema,
    conversationId: ResourceShortIdSchema,
    userId: UuidSchema,
    dueAt: TimestampSchema,
    state: z.enum(["pending", "sent", "canceled"]),
    revision: z.number().int().positive(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export const ReminderGetInputSchema = z.object({ mailboxId: MailboxIdInputSchema, conversationId: ConversationIdInputSchema }).strict();
export const ReminderGetDataSchema = ReminderDataSchema.nullable();
export const ReminderSetInputSchema = z
  .object({
    mailboxId: MailboxIdInputSchema,
    conversationId: ConversationIdInputSchema,
    dueAt: TimestampSchema.describe("Future time at which to notify the current user."),
    expectedRevision: z.number().int().positive().nullable().describe("Current reminder revision, or null when creating it."),
  })
  .strict();
export const ReminderCancelInputSchema = z
  .object({
    mailboxId: MailboxIdInputSchema,
    conversationId: ConversationIdInputSchema,
    expectedRevision: ExpectedRevisionInputSchema,
  })
  .strict();

export const CommentDataSchema = z
  .object({
    id: ResourceShortIdSchema,
    conversationId: ResourceShortIdSchema,
    body: NullableTextSchema,
    author: z
      .object({
        kind: z.enum(["user", "service_account", "workflow"]),
        id: UuidSchema,
        displayName: z.string(),
        avatarHash: NullableTextSchema,
      })
      .strict(),
    referencedMessageId: ResourceShortIdSchema.nullable(),
    revision: z.number().int().positive(),
    canEdit: z.boolean(),
    canDelete: z.boolean(),
    editedAt: NullableTimestampSchema,
    deletedAt: NullableTimestampSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export const CommentSummaryDataSchema = CommentDataSchema.omit({ body: true }).extend({
  ref: CommentRefSchema,
  body: z.string().max(1000).nullable(),
  bodyTruncated: z.boolean(),
});
export const CommentListDataSchema = z.array(CommentSummaryDataSchema).max(100);
export const CommentListInputSchema = z
  .object({
    mailboxId: MailboxIdInputSchema,
    conversationId: ConversationIdInputSchema,
    order: z.enum(["oldest", "newest"]).default("oldest").describe("Comment ordering."),
    ...PageInputShape,
  })
  .strict();
export const CommentCreateInputSchema = z
  .object({
    mailboxId: MailboxIdInputSchema,
    conversationId: ConversationIdInputSchema,
    body: z.string().trim().min(1).max(50_000).describe("Internal comment body."),
    referencedMessageId: ResourceShortIdSchema.nullable().optional().describe("Optional referenced message ID."),
  })
  .strict();
export const CommentUpdateInputSchema = z
  .object({
    mailboxId: MailboxIdInputSchema,
    conversationId: ConversationIdInputSchema,
    commentId: ResourceShortIdSchema.describe("Comment ID."),
    expectedRevision: ExpectedRevisionInputSchema,
    body: z.string().trim().min(1).max(50_000).describe("Replacement internal comment body."),
  })
  .strict();
export const CommentDeleteInputSchema = z
  .object({
    mailboxId: MailboxIdInputSchema,
    conversationId: ConversationIdInputSchema,
    commentId: ResourceShortIdSchema.describe("Comment ID."),
    expectedRevision: ExpectedRevisionInputSchema,
  })
  .strict();

export const ActivityDataSchema = z
  .object({
    id: z.string().min(1),
    conversationId: ResourceShortIdSchema.nullable(),
    actor: z
      .object({
        kind: z.enum(["user", "service_account", "workflow", "system"]),
        id: UuidSchema.nullable(),
        displayName: z.string(),
        avatarHash: NullableTextSchema,
      })
      .strict(),
    action: z.string().min(1),
    outcome: z.enum(["requested", "confirmed", "failed", "reconciled"]),
    targetType: NullableTextSchema.describe("Activity target kind."),
    targetId: NullableTextSchema.describe(
      "Public target ID. Conversation references use their domain value; reference configuration uses the mailbox ID.",
    ),
    metadata: z.record(z.string(), z.unknown()),
    createdAt: TimestampSchema,
  })
  .strict();
export const ActivityListDataSchema = z.array(ActivityDataSchema).max(100);
export const ActivityListInputSchema = z
  .object({
    mailboxId: MailboxIdInputSchema,
    conversationId: ConversationIdInputSchema.optional().describe("Optional conversation ID filter."),
    ...PageInputShape,
  })
  .strict();

const UnsubscribeDataSchema = z.object({ kind: z.enum(["one_click", "web", "email"]), href: z.string().min(1).max(2048) }).strict();
export const SubscriptionDataSchema = z
  .object({
    listKey: z.string().min(1),
    name: z.string().min(1),
    address: z.string().min(1),
    status: z.enum(["active", "requesting", "unsubscribe_requested", "failed"]),
    unsubscribe: UnsubscribeDataSchema.nullable(),
    messageCount: z.number().int().nonnegative(),
    conversationCount: z.number().int().nonnegative(),
    lastMessageAt: TimestampSchema,
    lastSubject: z.string(),
    lastSender: NullableTextSchema,
    unsubscribeRequestedAt: NullableTimestampSchema,
    unsubscribeErrorCode: NullableTextSchema,
  })
  .strict();
export const SubscriptionListDataSchema = z.array(SubscriptionDataSchema.extend(OptionalResourceLinksShape).strict()).max(100);
export const SubscriptionListInputSchema = z.object({ mailboxId: MailboxIdInputSchema, ...PageInputShape }).strict();
export const SubscriptionGetInputSchema = z
  .object({ mailboxId: MailboxIdInputSchema, listKey: z.string().trim().min(1).max(4096).describe("Stable detected mailing-list key.") })
  .strict();
export const SubscriptionGetDataSchema = SubscriptionDataSchema.nullable();
export const SubscriptionUnsubscribeInputSchema = z
  .object({
    mailboxId: MailboxIdInputSchema,
    listKey: z.string().trim().min(1).max(4096).describe("Stable detected mailing-list key."),
    href: z.url().describe("Exact advertised one-click HTTPS unsubscribe URL."),
  })
  .strict();
export const SubscriptionUnsubscribeDataSchema = z
  .object({ listKey: z.string().min(1), status: z.literal("unsubscribe_requested"), requestedAt: TimestampSchema })
  .strict();
