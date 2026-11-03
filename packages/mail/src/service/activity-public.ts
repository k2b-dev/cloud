import * as publicResources from "./public-resources";

type Table = publicResources.MailPublicResourceTable;
type LoadPublicIds = typeof publicResources.publicIds;

export type PublicActivityItem = {
  conversationId: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const targetTables: Readonly<Record<string, Table>> = {
  mailbox: "mailboxes",
  folder: "folders",
  conversation: "conversations",
  message: "messages",
  attachment: "attachments",
  draft: "drafts",
  draft_attachment: "draftAttachments",
  sender_identity: "senderIdentities",
  local_tag: "tags",
  tag: "tags",
  comment: "comments",
  reminder: "reminders",
  delivery: "deliveries",
  outbox_submission: "deliveries",
  saved_conversation_view: "savedViews",
  compose_template: "composeTemplates",
  incoming_automation: "incomingAutomations",
  automatic_reply_configuration: "automaticReplyConfigurations",
};

const domainTargetTypes = new Set(["conversation_reference", "reference_configuration"]);
const technicalTargetTypes = new Set([
  "command",
  "workflow",
  "workflow_version",
  "automatic_reply",
  "attachment_link",
  "list_subscription",
]);

const metadataTables: Readonly<Record<string, Table>> = {
  mailboxId: "mailboxes",
  folderId: "folders",
  sourceFolderId: "folders",
  destinationFolderId: "folders",
  parentFolderId: "folders",
  activeFolderIds: "folders",
  unreadFolderIds: "folders",
  conversationId: "conversations",
  sourceConversationId: "conversations",
  targetConversationId: "conversations",
  conversationIds: "conversations",
  removedConversationId: "conversations",
  updatedConversationIds: "conversations",
  messageId: "messages",
  sourceMessageId: "messages",
  derivedFromMessageId: "messages",
  referencedMessageId: "messages",
  messageIds: "messages",
  outboundMessageId: "messages",
  attachmentId: "attachments",
  attachmentIds: "attachments",
  draftId: "drafts",
  draftAttachmentId: "draftAttachments",
  draftAttachmentIds: "draftAttachments",
  senderIdentityId: "senderIdentities",
  tagId: "tags",
  tagIds: "tags",
  addedTagIds: "tags",
  afterTagIds: "tags",
  beforeTagIds: "tags",
  removedTagIds: "tags",
  requestedTagIds: "tags",
  commentId: "comments",
  reminderId: "reminders",
  deliveryId: "deliveries",
  outboxSubmissionId: "deliveries",
  scheduledSendId: "deliveries",
  viewId: "savedViews",
  templateId: "composeTemplates",
  automationId: "incomingAutomations",
  configurationId: "automaticReplyConfigurations",
};

const technicalMetadataKeys = new Set([
  "commandId",
  "correlationId",
  "bindingId",
  "selectedBindingId",
  "connectionId",
  "accessId",
  "workflowId",
  "versionId",
  "workflowVersionId",
  "workflowRunId",
  "operationId",
  "uploadId",
  "recoveryCopyId",
  "attachmentLinkId",
  "listSubscriptionId",
  "effectId",
]);

/** Principal references stay as they are: Cloud names people by their principal ID, as list items do for assignees. */
const principalMetadataKeys = new Set(["assigneeUserIds", "assigneeUserId"]);

const collectMetadataIds = (value: unknown, ids: Map<Table, string[]>): void => {
  if (Array.isArray(value)) {
    value.forEach((item) => collectMetadataIds(item, ids));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const table = metadataTables[key];
    if (table) {
      const values = Array.isArray(child) ? child : [child];
      for (const id of values) {
        if (typeof id === "string" && UUID.test(id)) ids.set(table, [...(ids.get(table) ?? []), id]);
      }
    }
    collectMetadataIds(child, ids);
  }
};

const publicResourceValue = (table: Table, value: unknown, maps: Map<Table, Map<string, string>>): unknown => {
  if (Array.isArray(value)) return value.map((item) => publicResourceValue(table, item, maps));
  if (typeof value !== "string" || !UUID.test(value)) return value;
  return maps.get(table)?.get(value) ?? null;
};

const projectMetadata = (value: unknown, maps: Map<Table, Map<string, string>>, key?: string): unknown => {
  if (key && principalMetadataKeys.has(key)) return value;
  if (key && metadataTables[key]) return publicResourceValue(metadataTables[key], value, maps);
  if (Array.isArray(value)) return value.map((item) => projectMetadata(item, maps));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, projectMetadata(child, maps, childKey)]));
  if (typeof value === "string" && UUID.test(value) && (!key || !technicalMetadataKeys.has(key))) return null;
  return value;
};

export const projectActivityItems = async <T extends PublicActivityItem>(
  items: T[],
  loadPublicIds: LoadPublicIds = publicResources.publicIds,
): Promise<T[]> => {
  const ids = new Map<Table, string[]>();
  for (const item of items) {
    if (item.conversationId && UUID.test(item.conversationId))
      ids.set("conversations", [...(ids.get("conversations") ?? []), item.conversationId]);
    const targetTable = item.targetType ? targetTables[item.targetType] : undefined;
    if (targetTable && item.targetId && UUID.test(item.targetId)) ids.set(targetTable, [...(ids.get(targetTable) ?? []), item.targetId]);
    collectMetadataIds(item.metadata, ids);
  }
  const maps = new Map(
    await Promise.all([...ids].map(async ([table, values]) => [table, await loadPublicIds(table, [...new Set(values)])] as const)),
  );
  return items.map((item) => {
    const targetTable = item.targetType ? targetTables[item.targetType] : undefined;
    const targetId = targetTable
      ? (publicResourceValue(targetTable, item.targetId, maps) as string | null)
      : item.targetType && (domainTargetTypes.has(item.targetType) || technicalTargetTypes.has(item.targetType))
        ? item.targetId
        : item.targetId && UUID.test(item.targetId)
          ? null
          : null;
    return {
      ...item,
      conversationId: publicResourceValue("conversations", item.conversationId, maps) as string | null,
      targetId,
      metadata: projectMetadata(item.metadata, maps) as Record<string, unknown>,
    };
  });
};

export const activityPublicContract = {
  targetTables,
  domainTargetTypes,
  technicalTargetTypes,
  metadataTables,
  technicalMetadataKeys,
  principalMetadataKeys,
};
