import type { ConversationTriageInput } from "../../contracts";

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
 */
export const mailMoveSourceFolderIds = (params: {
  viewFolderId: string | null;
  activeFolderIds: readonly string[];
  folders: readonly MailActionFolder[];
}): string[] => {
  const active = [...new Set(params.activeFolderIds)];
  if (params.viewFolderId && active.includes(params.viewFolderId)) return [params.viewFolderId];
  const folders = new Map(params.folders.map((folder) => [folder.id, folder]));
  for (const inTier of SOURCE_TIERS) {
    const tier = active.filter((folderId) => inTier(folders.get(folderId)));
    if (tier.length > 0) return tier;
  }
  return [];
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
  const sources = mailMoveSourceFolderIds(params);
  const junk = new Set(params.folders.flatMap((folder) => (folder.role === "junk" ? [folder.id] : [])));
  return sources.length > 0 && sources.every((folderId) => junk.has(folderId)) ? "not_spam" : "junk";
};

export const buildMailActionInput = (params: {
  actionId: MailActionId;
  sourceFolderId: string;
  destinationFolderId?: string;
  idempotencyKey: string;
  correlationId: string;
}): ConversationTriageInput => {
  if (params.actionId === "move") {
    if (!params.destinationFolderId) throw new Error(MAIL_ACTION_MISSING_DESTINATION);
    return {
      kind: "move_to_folder",
      sourceFolderId: params.sourceFolderId,
      destinationFolderId: params.destinationFolderId,
      idempotencyKey: params.idempotencyKey,
      correlationId: params.correlationId,
    };
  }
  if (params.actionId === "archive" || params.actionId === "junk" || params.actionId === "not_spam" || params.actionId === "trash") {
    return {
      kind: "move_to_role",
      sourceFolderId: params.sourceFolderId,
      role: params.actionId === "not_spam" ? "inbox" : params.actionId,
      idempotencyKey: params.idempotencyKey,
      correlationId: params.correlationId,
    };
  }
  return {
    kind: "change_state",
    sourceFolderId: params.sourceFolderId,
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
