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
 * A row loaded earlier than its conversation's detail, brought up to what opening it reads: the message count and every
 * folder with an unread message in the detail, so auto mark-read sees what a snapshot would. The revision stays: it
 * guards the row's tags, assignees and status, which only a snapshot refreshes together. Returns the same row when
 * nothing is newer.
 */
export const syncMailRowWithDetail = (
  item: MailListItem,
  detail: { detailMessages: ReadonlyArray<{ flags: readonly string[]; folderId: string | null }> },
): MailListItem => {
  const unseenFolderIds = detail.detailMessages.flatMap((message) =>
    !message.flags.includes("\\Seen") && message.folderId ? [message.folderId] : [],
  );
  const unreadFolderIds = [...new Set([...item.unreadFolderIds, ...unseenFolderIds])];
  // The detail holds at most the newest 100 messages, so it can only raise the count.
  const messageCount = Math.max(item.messageCount, detail.detailMessages.length);
  return messageCount === item.messageCount && unreadFolderIds.length === item.unreadFolderIds.length
    ? item
    : { ...item, messageCount, unread: item.unread || unseenFolderIds.length > 0, unreadFolderIds };
};

/** Whether the detail saw a newer revision than the row, so the row's collaboration state is older than the reader's. */
export const mailRowOlderThanDetail = (
  item: Pick<MailListItem, "revision"> | undefined,
  detail: { collaborationState: { revision: number } | null; conversationLocalTags: { conversationRevision: number } | null },
): boolean =>
  item !== undefined &&
  Math.max(detail.collaborationState?.revision ?? 0, detail.conversationLocalTags?.conversationRevision ?? 0) > item.revision;
