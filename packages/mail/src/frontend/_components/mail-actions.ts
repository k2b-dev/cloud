import type { ConversationTriageInput } from "../../contracts";
import type { MailListItem } from "../../service/workspace";
import type { MailBulkTarget } from "./mail-bulk-actions";

export const MAIL_ACTION_IDS = ["mark_read", "mark_unread", "flag", "unflag", "archive", "junk", "not_spam", "trash", "move"] as const;
export type MailActionId = (typeof MAIL_ACTION_IDS)[number];
export const MAIL_ACTION_MISSING_DESTINATION = "mail_action_missing_destination";

type MailActionDescriptor = {
  id: MailActionId;
  icon: string;
  destructive?: boolean;
};

const ACTIONS = [
  {
    id: "archive",
    icon: "ti ti-archive",
  },
  {
    id: "junk",
    icon: "ti ti-alert-octagon",
  },
  {
    id: "not_spam",
    icon: "ti ti-shield-check",
  },
  {
    id: "trash",
    icon: "ti ti-trash",
    destructive: true,
  },
  {
    id: "mark_read",
    icon: "ti ti-mail-opened",
  },
  {
    id: "mark_unread",
    icon: "ti ti-mail",
  },
  {
    id: "flag",
    icon: "ti ti-flag",
  },
  {
    id: "unflag",
    icon: "ti ti-flag-off",
  },
  {
    id: "move",
    icon: "ti ti-folder-symlink",
  },
] as const satisfies readonly MailActionDescriptor[];

const actionById = new Map<MailActionId, MailActionDescriptor>(ACTIONS.map((action) => [action.id, action]));

export const getMailAction = (id: MailActionId): MailActionDescriptor => {
  const action = actionById.get(id);
  if (!action) throw new Error(`Unknown Mail action: ${id}`);
  return action;
};

type MailActionFolder = {
  id: string;
  role: string;
  providerRole: string;
  configuredRole: string | null;
  selectable: boolean;
  discoveryState: string;
};

// Where a conversation is filed, in the order an action takes it out of: ordinary folders, then
// Junk and Trash, then Gmail's All Mail, then the mailbox's own copies in Sent and Drafts.
const SOURCE_TIERS: ReadonlyArray<(folder: MailActionFolder | undefined) => boolean> = [
  (folder) => !folder || (!["sent", "drafts", "junk", "trash", "all"].includes(folder.role) && folder.providerRole !== "all"),
  (folder) => folder?.role === "junk" || folder?.role === "trash",
  (folder) => folder?.role === "all" || folder?.providerRole === "all",
  () => true,
];

/**
 * The folders that Archive, Spam, Delete, Move, and drag take a conversation out of. In a folder view
 * that is the folder in view. A view that spans folders takes it out of every ordinary folder it is
 * filed in and leaves Junk, Trash, Gmail's All Mail, Sent, and Drafts alone, unless the conversation
 * is only there. The newest message's folder never decides: it is often Sent or All Mail.
 *
 * Gmail, recognized by its All Mail folder, files one message under many labels, and one move changes
 * the message everywhere: a move out of a label removes that label, and a move to Trash or Spam takes
 * the message out of every label. A view that spans folders therefore acts on one folder there, the
 * Inbox when the conversation is in it, and Archive only ever leaves the Inbox.
 */
export const mailMoveSourceFolderIds = (params: {
  actionId: MailActionId;
  viewFolderId: string | null;
  activeFolderIds: readonly string[];
  folders: readonly MailActionFolder[];
}): string[] => {
  const active = [...new Set(params.activeFolderIds)];
  if (params.viewFolderId && active.includes(params.viewFolderId)) return [params.viewFolderId];
  const folders = new Map(params.folders.map((folder) => [folder.id, folder]));
  const tierIndex = SOURCE_TIERS.findIndex((inTier) => active.some((folderId) => inTier(folders.get(folderId))));
  if (tierIndex < 0) return [];
  const tier = active.filter((folderId) => SOURCE_TIERS[tierIndex]!(folders.get(folderId)));
  const labels = params.folders.some((folder) => folder.providerRole === "all" && folder.discoveryState === "active");
  if (!labels) return tier;
  const inbox = tier.find((folderId) => folders.get(folderId)?.role === "inbox");
  if (params.actionId === "archive" && tierIndex === 0) return inbox ? [inbox] : [];
  return [inbox ?? tier[0]!];
};

/**
 * What an action on one list row acts on, and in which folders. A conversation row stands for its conversation; a
 * row of a message list stands for its message only, never for the other messages of its conversation.
 */
export const mailActionTargetForItem = (params: {
  item: Pick<MailListItem, "id" | "conversationId" | "selectionKind" | "subject" | "unreadFolderIds" | "activeFolderIds">;
  actionId: MailActionId;
  viewFolderId: string | null;
  folders: readonly MailActionFolder[];
  noSubject: string;
}): MailBulkTarget | null => {
  const { item, actionId } = params;
  if (!item.conversationId) return null;
  const sourceFolderIds =
    actionId === "mark_read" && item.unreadFolderIds.length > 0
      ? item.unreadFolderIds
      : ["mark_unread", "flag", "unflag"].includes(actionId)
        ? item.activeFolderIds
        : mailMoveSourceFolderIds({
            actionId,
            viewFolderId: params.viewFolderId,
            activeFolderIds: item.activeFolderIds,
            folders: params.folders,
          });
  return {
    conversationId: item.conversationId,
    label: item.subject || params.noSubject,
    sourceFolderIds,
    ...(item.selectionKind === "message" ? { messageIds: [item.id] } : {}),
  };
};

const ROLE_DESTINATIONS: Partial<Record<MailActionId, string>> = { archive: "archive", junk: "junk", trash: "trash", not_spam: "inbox" };

/**
 * The folder an Archive, Spam, Not spam, or Delete action moves to, chosen as the server's
 * `resolveRoleFolder` chooses it among active, selectable folders: the folder configured for the
 * role, else the one folder whose provider role it is, else Gmail's All Mail for Archive. `null`
 * when that is unclear; the server then decides and reports.
 */
export const mailRoleDestinationFolderId = (actionId: MailActionId, folders: readonly MailActionFolder[]): string | null => {
  const role = ROLE_DESTINATIONS[actionId];
  if (!role) return null;
  const usable = folders.filter((folder) => folder.selectable && folder.discoveryState === "active");
  const configured = usable.find((folder) => folder.configuredRole === role);
  if (configured) return configured.id;
  const claimed = usable.filter((folder) => folder.providerRole === role);
  if (claimed.length === 0 && role === "archive") {
    const allMail = usable.filter((folder) => folder.providerRole === "all");
    return allMail.length === 1 ? allMail[0]!.id : null;
  }
  return claimed.length === 1 ? claimed[0]!.id : null;
};

/** The spam action a conversation offers: Not spam when every folder the action takes it out of is Junk. */
export const spamActionForConversation = (params: {
  viewFolderId: string | null;
  activeFolderIds: readonly string[];
  folders: readonly MailActionFolder[];
}): "junk" | "not_spam" => {
  const sources = mailMoveSourceFolderIds({ ...params, actionId: "junk" });
  const junk = new Set(params.folders.flatMap((folder) => (folder.role === "junk" ? [folder.id] : [])));
  return sources.length > 0 && sources.every((folderId) => junk.has(folderId)) ? "not_spam" : "junk";
};

export const buildMailActionInput = (params: {
  actionId: MailActionId;
  sourceFolderId: string;
  messageIds?: readonly string[];
  destinationFolderId?: string;
  idempotencyKey: string;
  correlationId: string;
}): ConversationTriageInput => {
  const messageIds = params.messageIds ? { messageIds: [...params.messageIds] } : {};
  if (params.actionId === "move") {
    if (!params.destinationFolderId) throw new Error(MAIL_ACTION_MISSING_DESTINATION);
    return {
      kind: "move_to_folder",
      sourceFolderId: params.sourceFolderId,
      ...messageIds,
      destinationFolderId: params.destinationFolderId,
      idempotencyKey: params.idempotencyKey,
      correlationId: params.correlationId,
    };
  }
  if (params.actionId === "archive" || params.actionId === "junk" || params.actionId === "not_spam" || params.actionId === "trash") {
    return {
      kind: "move_to_role",
      sourceFolderId: params.sourceFolderId,
      ...messageIds,
      role: params.actionId === "not_spam" ? "inbox" : params.actionId,
      idempotencyKey: params.idempotencyKey,
      correlationId: params.correlationId,
    };
  }
  return {
    kind: "change_state",
    sourceFolderId: params.sourceFolderId,
    ...messageIds,
    change: {
      addFlags: params.actionId === "mark_read" ? ["seen"] : params.actionId === "flag" ? ["flagged"] : [],
      removeFlags: params.actionId === "mark_unread" ? ["seen"] : params.actionId === "unflag" ? ["flagged"] : [],
      addKeywords: [],
      removeKeywords: [],
    },
    idempotencyKey: params.idempotencyKey,
    correlationId: params.correlationId,
  };
};
