import { serializeMailSearchState } from "../../search-state";
import type { MailListItem } from "../../service/workspace";

export type { MailListItem } from "../../service/workspace";

export const isMailWorkspaceUrl = (url: URL, mailboxId: string, origin: string): boolean =>
  url.origin === origin && url.pathname === `/app/mail/${mailboxId}`;

/** Resolves a route (`pathname + search` or absolute) against the browser origin; null when it leaves this mailbox. */
export const resolveMailWorkspaceUrl = (href: string, mailboxId: string, origin: string): URL | null => {
  const url = new URL(href, origin);
  return isMailWorkspaceUrl(url, mailboxId, origin) ? url : null;
};

/** Parses a route given as `pathname + search`. The placeholder origin never reaches a href. */
export const mailRouteUrl = (route: string): URL => new URL(route, "http://mail.local");

export const buildMailListHref = (requestUrl: URL, clearSearch = false): string => {
  const next = new URL(requestUrl);
  next.searchParams.delete("conversation");
  next.searchParams.delete("message");
  if (clearSearch) {
    for (const parameter of [
      "q",
      "qFields",
      "from",
      "to",
      "subject",
      "body",
      "attachment",
      "comment",
      "reference",
      "folderName",
      "tag",
      "keyword",
      "combine",
      "search",
      "cursor",
      "savedView",
    ]) {
      next.searchParams.delete(parameter);
    }
  }
  return `${next.pathname}${next.search}`;
};

export const buildMailSelectionHref = (requestUrl: URL, item: MailListItem): string => {
  const next = new URL(buildMailListHref(requestUrl), requestUrl.origin);
  if (item.conversationId) next.searchParams.set("conversation", item.conversationId);
  if (item.selectionKind === "message" || !item.conversationId) next.searchParams.set("message", item.id);
  if (item.attachmentMatch) next.searchParams.set("message", item.attachmentMatch.messageId);
  return `${next.pathname}${next.search}`;
};

export const buildMailAttachmentDownloadHref = (requestUrl: URL, item: MailListItem): string | null => {
  if (!item.attachmentMatch) return null;
  const match = /^\/app\/mail\/([^/]+)$/.exec(requestUrl.pathname);
  if (!match?.[1]) return null;
  return `/api/mail/mailboxes/${match[1]}/messages/${encodeURIComponent(item.attachmentMatch.messageId)}/attachments/${encodeURIComponent(item.attachmentMatch.attachmentId)}`;
};

export const buildMailingListHref = (requestUrl: URL, listKey: string): string => {
  const next = new URL(requestUrl);
  next.searchParams.set("mailingList", listKey);
  return `${next.pathname}${next.search}`;
};

export const senderDomainFromAddress = (address: string): string | null => {
  const separator = address.lastIndexOf("@");
  const domain =
    separator >= 0
      ? address
          .slice(separator + 1)
          .trim()
          .toLowerCase()
      : "";
  return domain.includes(".") ? domain : null;
};

export const buildExactSenderSearchHref = (requestUrl: URL, address: string): string | null => {
  const serialized = serializeMailSearchState({
    expression: { type: "text", field: "from", query: address, match: "exact" },
    sort: "newest",
  });
  if (!serialized.ok) return null;
  const next = new URL(buildMailListHref(requestUrl, true), requestUrl.origin);
  next.searchParams.set("search", serialized.value);
  return `${next.pathname}${next.search}`;
};

export const buildExactParticipantSearchHref = (requestUrl: URL, address: string): string | null => {
  const serialized = serializeMailSearchState({
    expression: { type: "text", field: "participants", query: address, match: "exact" },
    sort: "newest",
  });
  if (!serialized.ok) return null;
  const next = new URL(buildMailListHref(requestUrl, true), requestUrl.origin);
  next.searchParams.set("search", serialized.value);
  return `${next.pathname}${next.search}`;
};

export const isMailListItemActive = (
  item: Pick<MailListItem, "id" | "conversationId" | "selectionKind">,
  selectedConversationId: string | null,
  selectedMessageId: string | null,
): boolean =>
  item.selectionKind === "message"
    ? item.id === selectedMessageId
    : item.conversationId
      ? item.conversationId === selectedConversationId
      : item.id === selectedMessageId;
