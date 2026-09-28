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

export const spamActionForFolder = (folderId: string | null, junkFolderIds: readonly string[]): "junk" | "not_spam" =>
  folderId && junkFolderIds.includes(folderId) ? "not_spam" : "junk";

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
