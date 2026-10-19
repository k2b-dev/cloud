import type { MailboxPageData, MailListItem, MailSelectionDetail } from "../../service/workspace";

/** The part of a workspace snapshot that belongs to its selection; the list, folders and counts do not depend on it. */
export type MailSelection = MailSelectionDetail & Pick<MailboxPageData, "selectedConversationId" | "selectedMessageId" | "selectedSubject">;

/** Typed field by field, so the selection cannot miss a detail field the snapshot gains. */
export const pickMailSelection = (data: MailboxPageData): MailSelection => ({
  detailMessages: data.detailMessages,
  conversationSummary: data.conversationSummary,
  conversationDrafts: data.conversationDrafts,
  detailError: data.detailError,
  collaborationState: data.collaborationState,
  conversationLocalTags: data.conversationLocalTags,
  comments: data.comments,
  commentsCursor: data.commentsCursor,
  assignableUsers: data.assignableUsers,
  activity: data.activity,
  reminder: data.reminder,
  keep: data.keep,
  collaborationError: data.collaborationError,
  detailErrors: data.detailErrors,
  selectedReference: data.selectedReference,
  selectedConversationId: data.selectedConversationId,
  selectedMessageId: data.selectedMessageId,
  selectedSubject: data.selectedSubject,
});

/** What a snapshot without a selection carries. */
export const emptyMailSelection = (): MailSelection => ({
  detailMessages: [],
  conversationSummary: null,
  conversationDrafts: [],
  detailError: null,
  collaborationState: null,
  conversationLocalTags: null,
  comments: [],
  commentsCursor: null,
  assignableUsers: [],
  activity: [],
  reminder: null,
  keep: null,
  collaborationError: null,
  detailErrors: {
    collaboration: null,
    tags: null,
    comments: null,
    assignableUsers: null,
    activity: null,
    reminder: null,
    keep: null,
    reference: null,
    summary: null,
    drafts: null,
  },
  selectedReference: null,
  selectedConversationId: null,
  selectedMessageId: null,
  selectedSubject: "",
});

/**
 * Whether the detail shows that the row is older: a newer revision, more messages, or a flag or an unread message in a
 * folder the row does not know. Only messages in folders the list covers count (`listed`), because the row leaves the
 * others out; a search also leaves unread messages outside its folders out of the row's unread state (`unreadFolders`,
 * null for any folder). The detail shows one placement per message, preferring the row's folder, so when it holds every
 * message and none lies in the row's folder anymore, the row is older. A flag or unread state the row shows but no
 * message has anymore counts only when that placement is the row's (`onePlacement`: a list of one folder, or a row in
 * one folder only), and only when the detail holds every message. A missing row (not loaded) is never older.
 */
export const mailRowOlderThanDetail = (
  item: Pick<MailListItem, "revision" | "messageCount" | "flagged" | "unread" | "unreadFolderIds" | "sourceFolderId"> | undefined,
  detail: {
    detailMessages: ReadonlyArray<{ flags: readonly string[]; folderId: string | null }>;
    collaborationState: { revision: number } | null;
    conversationLocalTags: { conversationRevision: number } | null;
  },
  listed: (folderId: string | null) => boolean,
  onePlacement: boolean,
  unreadFolders: ReadonlySet<string> | null = null,
): boolean => {
  if (!item) return false;
  const revision = Math.max(detail.collaborationState?.revision ?? 0, detail.conversationLocalTags?.conversationRevision ?? 0);
  if (revision > item.revision || detail.detailMessages.length > item.messageCount) return true;
  const holdsEveryMessage = detail.detailMessages.length >= item.messageCount;
  const source = item.sourceFolderId;
  if (holdsEveryMessage && source !== null && !detail.detailMessages.some((message) => message.folderId === source)) return true;
  const messages = detail.detailMessages.filter((message) => listed(message.folderId));
  const flagged = messages.some((message) => message.flags.includes("\\Flagged"));
  const unreadMessages = messages.filter(
    (message) =>
      !message.flags.includes("\\Seen") && (unreadFolders === null || (message.folderId !== null && unreadFolders.has(message.folderId))),
  );
  if (!item.flagged && flagged) return true;
  if (unreadMessages.some((message) => message.folderId !== null && !item.unreadFolderIds.includes(message.folderId))) return true;
  const complete = onePlacement && holdsEveryMessage;
  return complete && ((item.flagged && !flagged) || (item.unread && unreadMessages.length === 0));
};
