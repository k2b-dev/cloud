import type { MailboxPageData, MailListItem, MailSelectionDetail } from "../../service/workspace";

/** The part of a workspace snapshot that belongs to its selection; the list, folders and counts do not depend on it. */
export type MailSelection = MailSelectionDetail & Pick<MailboxPageData, "selectedConversationId" | "selectedMessageId" | "selectedSubject">;

/** Typed field by field, so the selection cannot miss a detail field the snapshot gains. */
export const pickMailSelection = (data: MailboxPageData): MailSelection => ({
  detailMessages: data.detailMessages,
  conversationRowState: data.conversationRowState,
  conversationSummary: data.conversationSummary,
  conversationDrafts: data.conversationDrafts,
  automationTrace: data.automationTrace,
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
  conversationRowState: null,
  conversationSummary: null,
  conversationDrafts: [],
  automationTrace: [],
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

/** Compare the full conversation state in the detail response using the list's folder and search scopes. */
export const mailRowOlderThanDetail = (
  item: Pick<MailListItem, "revision" | "messageCount" | "flagged" | "unread" | "unreadFolderIds" | "activeFolderIds"> | undefined,
  detail: Pick<MailSelectionDetail, "conversationRowState"> & {
    collaborationState: { revision: number } | null;
    conversationLocalTags: { conversationRevision: number } | null;
  },
  listed: (folderId: string | null) => boolean,
  unreadFolders: ReadonlySet<string> | null = null,
): boolean => {
  if (!item) return false;
  const state = detail.conversationRowState;
  // A failed state read cannot certify the row; use the existing list refresh/recovery path.
  if (!state) return true;
  const active = state.activeFolderIds.filter(listed);
  const unread = state.unreadFolderIds.filter((folderId) => listed(folderId) && (unreadFolders === null || unreadFolders.has(folderId)));
  const sameFolders = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length && left.every((folderId) => right.includes(folderId));
  return (
    // Independent detail reads may observe a later revision than the aggregate did.
    Math.max(state.revision, detail.collaborationState?.revision ?? 0, detail.conversationLocalTags?.conversationRevision ?? 0) >
      item.revision ||
    state.messageCount !== item.messageCount ||
    !sameFolders(active, item.activeFolderIds) ||
    !sameFolders(unread, item.unreadFolderIds) ||
    unread.length > 0 !== item.unread ||
    state.flaggedFolderIds.some(listed) !== item.flagged
  );
};
