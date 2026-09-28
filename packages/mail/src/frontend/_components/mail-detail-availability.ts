import type { MailSelectionDetail } from "../../service/workspace";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";

const DETAIL_SECTIONS: Array<keyof MailSelectionDetail["detailErrors"]> = [
  "collaboration",
  "tags",
  "comments",
  "assignableUsers",
  "activity",
  "reminder",
  "reference",
  "summary",
  "drafts",
];

export const listUnavailableMailDetailSections = (errors: MailSelectionDetail["detailErrors"], locale: string): string[] => {
  const t = mailConversationUiMessages.resolve([locale]).t;
  return DETAIL_SECTIONS.flatMap((section) => (errors[section] ? [t.detailSection({ section })] : []));
};

export const preserveUnavailableMailDetail = <T extends MailSelectionDetail>(current: T, incoming: T): T => ({
  ...incoming,
  detailMessages: incoming.detailError ? current.detailMessages : incoming.detailMessages,
  collaborationState: incoming.detailErrors.collaboration ? current.collaborationState : incoming.collaborationState,
  conversationLocalTags: incoming.detailErrors.tags ? current.conversationLocalTags : incoming.conversationLocalTags,
  comments: incoming.detailErrors.comments ? current.comments : incoming.comments,
  commentsCursor: incoming.detailErrors.comments ? current.commentsCursor : incoming.commentsCursor,
  assignableUsers: incoming.detailErrors.assignableUsers ? current.assignableUsers : incoming.assignableUsers,
  activity: incoming.detailErrors.activity ? current.activity : incoming.activity,
  reminder: incoming.detailErrors.reminder ? current.reminder : incoming.reminder,
  selectedReference: incoming.detailErrors.reference ? current.selectedReference : incoming.selectedReference,
  conversationSummary: incoming.detailErrors.summary ? current.conversationSummary : incoming.conversationSummary,
  conversationDrafts: incoming.detailErrors.drafts ? current.conversationDrafts : incoming.conversationDrafts,
});
