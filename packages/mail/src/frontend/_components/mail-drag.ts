import type { MailListItem } from "../../service/workspace";

/** The drag type of a conversation row; the list, the sidebar and the drop surface agree on it (S7). */
export const MAIL_CONVERSATION_DRAG = "mail.conversation";

/**
 * The rows a drag carries: the dragged row, and when it belongs to the selection every selected row. In a message list
 * rows of one conversation can sit in different folders, so the dragged row stays itself, not its conversation's first.
 */
export const mailDraggedRows = <Row extends Pick<MailListItem, "id" | "conversationId">>(
  rows: readonly Row[],
  selectedConversationIds: ReadonlySet<string>,
  rowId: string,
): Row[] => {
  const row = rows.find((candidate) => candidate.id === rowId);
  if (!row) return [];
  if (!row.conversationId || !selectedConversationIds.has(row.conversationId)) return [row];
  return rows.filter((candidate) => candidate.conversationId && selectedConversationIds.has(candidate.conversationId));
};
