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
 * folder the row does not know. When the detail holds every message, a flag or unread state the row shows but no
 * message has anymore counts too. Only messages in folders the list covers count (`listed`), because the row leaves
 * the others out. A missing row (not loaded) is never older.
 */
export const mailRowOlderThanDetail = (
  item: Pick<MailListItem, "revision" | "messageCount" | "flagged" | "unread" | "unreadFolderIds"> | undefined,
  detail: {
    detailMessages: ReadonlyArray<{ flags: readonly string[]; folderId: string | null }>;
    collaborationState: { revision: number } | null;
    conversationLocalTags: { conversationRevision: number } | null;
  },
  listed: (folderId: string | null) => boolean,
): boolean => {
  if (!item) return false;
  const revision = Math.max(detail.collaborationState?.revision ?? 0, detail.conversationLocalTags?.conversationRevision ?? 0);
  if (revision > item.revision || detail.detailMessages.length > item.messageCount) return true;
  const messages = detail.detailMessages.filter((message) => listed(message.folderId));
  const flagged = messages.some((message) => message.flags.includes("\\Flagged"));
  const unread = messages.some((message) => !message.flags.includes("\\Seen"));
  if (!item.flagged && flagged) return true;
  if (
    messages.some(
      (message) => !message.flags.includes("\\Seen") && message.folderId !== null && !item.unreadFolderIds.includes(message.folderId),
    )
  )
    return true;
  const complete = detail.detailMessages.length >= item.messageCount;
  return complete && ((item.flagged && !flagged) || (item.unread && !unread));
};
