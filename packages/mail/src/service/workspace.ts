import { logger } from "@valentinkolb/cloud/services";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { z } from "zod";
import {
  type ConversationDraftSummary,
  type ConversationView,
  conversationViewSchema,
  type Mailbox,
  type MailSearchExpression,
  type ScheduledSendPage,
  type SenderIdentity,
} from "../contracts";
import { resolveMailSearchRoute } from "../search-state";
import type { MailRequestContext } from "./auth";
import type { ConversationCollaboration, ConversationComment, MailActivityEvent, MailAssignableUser } from "./collaboration";
import * as collaboration from "./collaboration";
import * as conversationReferences from "./conversation-reference";
import type { ConversationContentSummary } from "./conversation-summary";
import * as conversationSummaries from "./conversation-summary";
import * as drafts from "./drafts";
import { latestMailInvalidationCursor } from "./events";
import type { ConversationLocalTags, LocalTag } from "./local-tags";
import * as localTags from "./local-tags";
import * as mailboxes from "./mailboxes";
import type { ConversationSummary, ConversationViewCounts, MailFolderView, MessageDetail } from "./messages";
import * as messages from "./messages";
import type { ConversationReminder } from "./reminders";
import * as reminders from "./reminders";
import type { SavedConversationView } from "./saved-views";
import * as savedViews from "./saved-views";
import * as scheduledSends from "./scheduled-sends";
import * as search from "./search";
import * as senderIdentities from "./sender-identities";

const log = logger("mail:workspace");

export type MailListItem = {
  id: string;
  conversationId: string | null;
  selectionKind: "conversation" | "message";
  primaryReference: string | null;
  subject: string;
  participantSummary: string;
  participantLabels: string[];
  latestMessageAt: string;
  preview: string | null;
  attachmentMatch: search.MessageSearchHit["attachmentMatch"];
  unread: boolean;
  activeFolderIds: string[];
  flagged: boolean;
  hasAttachments: boolean;
  messageCount: number;
  workStatus: "needs_action" | "waiting" | "done" | null;
  assigneeUserId: string | null;
  snoozedUntil: string | null;
  sourceFolderId: string | null;
  unreadFolderIds: string[];
  localTags: LocalTag[];
  revision: number;
};

export type MailListMode = "conversations" | "messages";

const EMPTY_VIEW_COUNTS: ConversationViewCounts = {
  needs_action: 0,
  mine: 0,
  unassigned: 0,
  waiting: 0,
  done: 0,
  snoozed: 0,
  send_problems: 0,
  recently_active: 0,
};

const VIEW_LABELS: Record<ConversationView, string> = {
  needs_action: "Needs action",
  mine: "Assigned to me",
  unassigned: "Unassigned",
  waiting: "Waiting for reply",
  done: "Done",
  snoozed: "Snoozed",
  send_problems: "Send problems",
  recently_active: "Recent activity",
};

const optionalUuidSearchParam = (url: URL, name: string): string | null => {
  const parsed = z.string().uuid().safeParse(url.searchParams.get(name));
  return parsed.success ? parsed.data : null;
};

export type MailboxPageData = {
  mailbox: Mailbox;
  permission: "read" | "write" | "admin";
  initialLiveCursor: string | null;
  folders: MailFolderView[];
  identities: SenderIdentity[];
  scheduledMode: boolean;
  scheduledCount: number;
  scheduledPage: ScheduledSendPage | null;
  scheduledError: string | null;
  activeView: ConversationView | null;
  savedViewId: string | null;
  savedViews: SavedConversationView[];
  listMode: MailListMode;
  folderId: string | null;
  viewCounts: ConversationViewCounts;
  query: string;
  selectedConversationId: string | null;
  selectedMessageId: string | null;
  listItems: MailListItem[];
  listCursor: string | null;
  nextListCursor: string | null;
  listError: string | null;
  listTitle: string;
  detailMessages: MessageDetail[];
  conversationSummary: ConversationContentSummary | null;
  conversationDrafts: ConversationDraftSummary[];
  detailError: string | null;
  collaborationState: ConversationCollaboration | null;
  localTags: LocalTag[];
  conversationLocalTags: ConversationLocalTags | null;
  comments: ConversationComment[];
  commentsCursor: string | null;
  assignableUsers: MailAssignableUser[];
  activity: MailActivityEvent[];
  reminder: ConversationReminder | null;
  collaborationError: string | null;
  detailErrors: MailDetailErrors;
  selectedSubject: string;
  selectedReference: string | null;
};

export type MailDetailErrors = {
  collaboration: string | null;
  tags: string | null;
  comments: string | null;
  assignableUsers: string | null;
  activity: string | null;
  reminder: string | null;
  reference: string | null;
  summary: string | null;
  drafts: string | null;
};

export type MailSelectionDetail = Pick<
  MailboxPageData,
  | "detailMessages"
  | "conversationSummary"
  | "conversationDrafts"
  | "detailError"
  | "collaborationState"
  | "conversationLocalTags"
  | "comments"
  | "commentsCursor"
  | "assignableUsers"
  | "activity"
  | "reminder"
  | "collaborationError"
  | "detailErrors"
  | "selectedReference"
>;

const EMPTY_DETAIL_ERRORS: MailDetailErrors = {
  collaboration: null,
  tags: null,
  comments: null,
  assignableUsers: null,
  activity: null,
  reminder: null,
  reference: null,
  summary: null,
  drafts: null,
};

const EMPTY_SELECTION_DETAIL: MailSelectionDetail = {
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
  collaborationError: null,
  detailErrors: EMPTY_DETAIL_ERRORS,
  selectedReference: null,
};

const conversationToListItem = (conversation: ConversationSummary): MailListItem => ({
  id: conversation.id,
  conversationId: conversation.id,
  selectionKind: "conversation",
  primaryReference: conversation.primaryReference,
  subject: conversation.subject,
  participantSummary: conversation.participantSummary,
  participantLabels: conversation.participantLabels,
  latestMessageAt: conversation.latestMessageAt,
  preview: conversation.preview,
  attachmentMatch: null,
  unread: conversation.unread,
  activeFolderIds: conversation.activeFolderIds,
  flagged: conversation.flagged,
  hasAttachments: conversation.hasAttachments,
  messageCount: conversation.messageCount,
  workStatus: conversation.workStatus,
  assigneeUserId: conversation.assigneeUserId,
  snoozedUntil: conversation.snoozedUntil,
  sourceFolderId: conversation.folderId,
  unreadFolderIds: conversation.unreadFolderIds,
  localTags: [],
  revision: conversation.revision,
});

type MailListPage = {
  items: MailListItem[];
  nextCursor: string | null;
  error: string | null;
};

export const searchHitToListItem = (item: search.MessageSearchHit, listMode: MailListMode): MailListItem => {
  const selectionKind = listMode === "messages" || !item.conversationId ? "message" : "conversation";
  return {
    id: listMode === "conversations" && item.conversationId ? item.conversationId : item.id,
    conversationId: item.conversationId,
    selectionKind,
    primaryReference: item.primaryReference,
    subject: item.subject,
    participantSummary: item.participantSummary,
    participantLabels: item.participantLabels,
    latestMessageAt: item.latestMessageAt,
    preview: item.snippet,
    attachmentMatch: item.attachmentMatch,
    unread: item.unread,
    activeFolderIds: item.activeFolderIds,
    flagged: item.flagged,
    hasAttachments: item.hasAttachments,
    messageCount: item.messageCount,
    workStatus: item.workStatus,
    assigneeUserId: item.assigneeUserId,
    snoozedUntil: item.snoozedUntil,
    sourceFolderId: item.sourceFolderId,
    unreadFolderIds: item.unreadFolderIds,
    localTags: [],
    revision: item.revision,
  };
};

const attachLocalTags = async (
  context: MailRequestContext,
  mailboxId: string,
  items: MailListItem[],
  nextCursor: string | null,
): Promise<MailListPage> => {
  const result = await localTags.listConversationLocalTags({
    context,
    mailboxId,
    conversationIds: items.flatMap((item) => (item.conversationId ? [item.conversationId] : [])),
  });
  if (!result.ok) return { items: [], nextCursor: null, error: result.error.message };
  return {
    error: null,
    nextCursor,
    items: items.map((item) => ({
      ...item,
      localTags: item.conversationId ? (result.data.get(item.conversationId) ?? []) : [],
    })),
  };
};

const loadConversationDetails = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
  preferredFolderId?: string | null;
}) => {
  const [
    detailResult,
    stateResult,
    tagResult,
    commentsResult,
    usersResult,
    activityResult,
    reminderResult,
    referenceResult,
    summaryResult,
    draftsResult,
  ] = await Promise.all([
    messages.listConversationMessageDetails({ ...params, limit: 100 }),
    collaboration.getConversationCollaboration(params),
    localTags.getConversationLocalTags(params),
    collaboration.listConversationComments({ ...params, limit: 100, order: "newest" }),
    collaboration.listAssignableUsers({
      context: params.context,
      mailboxId: params.mailboxId,
      limit: 200,
    }),
    collaboration.listActivity({ ...params, limit: 30 }),
    reminders.getConversationReminder(params),
    conversationReferences.listConversationReferences(params),
    conversationSummaries.getConversationSummary(params),
    drafts.listConversationDrafts({ ...params, limit: 20 }),
  ]);

  return {
    detailMessages: detailResult.ok ? detailResult.data : [],
    conversationSummary: summaryResult.ok ? summaryResult.data : null,
    conversationDrafts: draftsResult.ok ? draftsResult.data : [],
    detailError: detailResult.ok ? null : detailResult.error.message,
    collaborationState: stateResult.ok ? stateResult.data : null,
    conversationLocalTags: tagResult.ok ? tagResult.data : null,
    comments: commentsResult.ok ? commentsResult.data.items : [],
    commentsCursor: commentsResult.ok ? commentsResult.data.nextCursor : null,
    assignableUsers: usersResult.ok ? usersResult.data : [],
    activity: activityResult.ok ? activityResult.data.items : [],
    reminder: reminderResult.ok ? reminderResult.data : null,
    collaborationError: !stateResult.ok ? stateResult.error.message : !tagResult.ok ? tagResult.error.message : null,
    detailErrors: {
      collaboration: stateResult.ok ? null : stateResult.error.message,
      tags: tagResult.ok ? null : tagResult.error.message,
      comments: commentsResult.ok ? null : commentsResult.error.message,
      assignableUsers: usersResult.ok ? null : usersResult.error.message,
      activity: activityResult.ok ? null : activityResult.error.message,
      reminder: reminderResult.ok ? null : reminderResult.error.message,
      reference: referenceResult.ok ? null : referenceResult.error.message,
      summary: summaryResult.ok ? null : summaryResult.error.message,
      drafts: draftsResult.ok ? null : draftsResult.error.message,
    },
    selectedReference: referenceResult.ok
      ? ((referenceResult.data.find((reference) => reference.role === "primary") ?? referenceResult.data[0])?.value ?? null)
      : null,
  };
};

export type MailConversationDetailData = MailSelectionDetail & {
  conversationId: string;
  localTags: LocalTag[];
  selectedSubject: string;
};

export const loadMailboxConversationDetail = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
}): Promise<MailConversationDetailData | null> => {
  const permission = await collaboration.requireMailboxCollaborationPermission(params.context, params.mailboxId, "read");
  if (!permission.ok || permission.data === "none") return null;
  const conversation = await messages.listConversationMessages({ ...params, limit: 1 });
  if (!conversation.ok) return null;
  const [detail, availableTags] = await Promise.all([
    loadConversationDetails(params),
    localTags.listLocalTags(params.context, params.mailboxId),
  ]);
  const availableTagsError = availableTags.ok ? null : availableTags.error.message;
  return {
    ...detail,
    conversationId: params.conversationId,
    collaborationError: detail.collaborationError ?? availableTagsError,
    detailErrors: { ...detail.detailErrors, tags: detail.detailErrors.tags ?? availableTagsError },
    localTags: availableTags.ok ? availableTags.data : [],
    selectedSubject: detail.detailMessages.at(-1)?.subject || "Message",
  };
};

const loadSelectionDetail = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string | null;
  messageId: string | null;
  preferredFolderId?: string | null;
}): Promise<MailSelectionDetail> => {
  if (params.conversationId) {
    return await loadConversationDetails({
      context: params.context,
      mailboxId: params.mailboxId,
      conversationId: params.conversationId,
      preferredFolderId: params.preferredFolderId,
    });
  }
  if (!params.messageId) return EMPTY_SELECTION_DETAIL;

  const detail = await messages.getMessage({
    context: params.context,
    mailboxId: params.mailboxId,
    messageId: params.messageId,
  });
  return detail.ok
    ? { ...EMPTY_SELECTION_DETAIL, detailMessages: [detail.data] }
    : { ...EMPTY_SELECTION_DETAIL, detailError: detail.error.message };
};

const loadListItems = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  folderId: string | null;
  activeView: ConversationView | null;
  savedView: SavedConversationView | null;
  listMode: MailListMode;
  searchExpression: MailSearchExpression | null;
  searchSort: "relevance" | "newest";
  excludedFolderIds: readonly string[];
  cursor?: string;
}): Promise<MailListPage> => {
  const activeViewExpression = (): MailSearchExpression => {
    const notSnoozed: MailSearchExpression = { type: "snoozed", value: false };
    if (params.activeView === "needs_action")
      return { type: "and", expressions: [{ type: "work_status", value: "needs_action" }, notSnoozed] };
    if (params.activeView === "mine")
      return {
        type: "and",
        expressions: [{ type: "assigned_to_me" }, { type: "not", expression: { type: "work_status", value: "done" } }, notSnoozed],
      };
    if (params.activeView === "unassigned")
      return {
        type: "and",
        expressions: [{ type: "assignee", userId: null }, { type: "not", expression: { type: "work_status", value: "done" } }, notSnoozed],
      };
    if (params.activeView === "waiting") return { type: "and", expressions: [{ type: "work_status", value: "waiting" }, notSnoozed] };
    if (params.activeView === "done") return { type: "work_status", value: "done" };
    if (params.activeView === "snoozed") return { type: "snoozed", value: true };
    return { type: "all" };
  };
  const messageModeExpression =
    params.searchExpression ??
    params.savedView?.filter.expression ??
    (params.folderId ? { type: "folder_id" as const, folderId: params.folderId } : activeViewExpression());

  if (params.searchExpression || params.listMode === "messages") {
    const result = await search.searchMessages({
      context: params.context,
      mailboxId: params.mailboxId,
      request: {
        expression: messageModeExpression,
        sort: params.searchExpression ? params.searchSort : (params.savedView?.filter.sort ?? "newest"),
        cursor: params.cursor,
        limit: 50,
      },
      groupByConversation: params.listMode === "conversations",
      excludedFolderIds: params.excludedFolderIds,
    });
    if (!result.ok) return { items: [], nextCursor: null, error: result.error.message };
    const items = result.data.items.map((item) => searchHitToListItem(item, params.listMode));
    return attachLocalTags(params.context, params.mailboxId, items, result.data.nextCursor);
  }

  if (params.savedView) {
    const result = await savedViews.listSavedViewConversations({
      context: params.context,
      mailboxId: params.mailboxId,
      viewId: params.savedView.id,
      cursor: params.cursor,
      limit: 50,
    });
    if (!result.ok) return { items: [], nextCursor: null, error: result.error.message };
    const items = result.data.items.map(conversationToListItem);
    return attachLocalTags(params.context, params.mailboxId, items, result.data.nextCursor);
  }

  const result = await messages.listConversations({
    context: params.context,
    mailboxId: params.mailboxId,
    folderId: params.folderId,
    excludedFolderIds: params.excludedFolderIds,
    view: params.activeView,
    cursor: params.cursor,
    limit: 50,
  });
  if (!result.ok) return { items: [], nextCursor: null, error: result.error.message };
  const items = result.data.items.map(conversationToListItem);
  return attachLocalTags(params.context, params.mailboxId, items, result.data.nextCursor);
};

export const loadMailboxPageData = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  requestUrl: URL;
  listMode?: MailListMode;
}): Promise<Result<MailboxPageData>> => {
  const permission = await collaboration.requireMailboxCollaborationPermission(params.context, params.mailboxId, "read");
  if (!permission.ok) return fail(permission.error);
  if (permission.data === "none") return fail(err.forbidden());
  const scheduledMode = params.requestUrl.searchParams.get("scheduled") === "1";

  let initialLiveCursor: string | null = null;
  try {
    initialLiveCursor = await latestMailInvalidationCursor();
  } catch (error) {
    log.warn("Failed to capture the initial Mail live cursor", {
      mailboxId: params.mailboxId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const [mailboxResult, folderResult, identityResult, viewCountsResult, savedViewResult, localTagResult, scheduledCountResult] =
    await Promise.all([
      mailboxes.getMailbox(params.context, params.mailboxId),
      messages.listFolders(params.context, params.mailboxId),
      senderIdentities.listSenderIdentities(params.context, params.mailboxId),
      messages.getConversationViewCounts({
        context: params.context,
        mailboxId: params.mailboxId,
      }),
      savedViews.listSavedConversationViews({
        context: params.context,
        mailboxId: params.mailboxId,
      }),
      localTags.listLocalTags(params.context, params.mailboxId),
      scheduledSends.countScheduledSends({
        context: params.context,
        mailboxId: params.mailboxId,
      }),
    ]);
  if (!mailboxResult.ok) return fail(mailboxResult.error);

  const parsedView = conversationViewSchema.safeParse(params.requestUrl.searchParams.get("view") ?? undefined);
  const activeView = parsedView.success ? parsedView.data : null;
  const savedViewId = activeView ? null : optionalUuidSearchParam(params.requestUrl, "savedView");
  const folderId = activeView || savedViewId ? null : optionalUuidSearchParam(params.requestUrl, "folder");
  const resolvedSearch = resolveMailSearchRoute(params.requestUrl);
  const { query, expression: searchExpression, sort: searchSort } = resolvedSearch;
  const listCursor = params.requestUrl.searchParams.get("cursor");
  const selectedConversationId = optionalUuidSearchParam(params.requestUrl, "conversation");
  const selectedMessageId = optionalUuidSearchParam(params.requestUrl, "message");
  const folders = folderResult.ok ? folderResult.data : [];
  const activeSavedView = savedViewResult.ok ? (savedViewResult.data.find((view) => view.id === savedViewId) ?? null) : null;
  const listMode = params.listMode ?? "conversations";
  const defaultAllMail = !scheduledMode && !searchExpression && !folderId && !activeView && !activeSavedView;
  const excludedFolderIds = defaultAllMail
    ? folders.filter((folder) => folder.role === "trash" || folder.role === "junk").map((folder) => folder.id)
    : [];
  const [list, scheduledPageResult] = await Promise.all([
    scheduledMode
      ? Promise.resolve({ items: [], nextCursor: null, error: null })
      : resolvedSearch.error
        ? Promise.resolve({
            items: [],
            nextCursor: null,
            error: resolvedSearch.error,
          })
        : loadListItems({
            context: params.context,
            mailboxId: params.mailboxId,
            folderId,
            activeView,
            savedView: activeSavedView,
            listMode,
            searchExpression,
            searchSort,
            excludedFolderIds,
            cursor: listCursor ?? undefined,
          }),
    scheduledMode
      ? scheduledSends.listScheduledSends({
          context: params.context,
          mailboxId: params.mailboxId,
          cursor: listCursor ?? undefined,
          limit: 50,
        })
      : Promise.resolve(null),
  ]);
  const selectedListItem = list.items.find((item) =>
    item.selectionKind === "message" ? item.id === selectedMessageId : item.conversationId === selectedConversationId,
  );
  const preferredFolderId = selectedListItem?.sourceFolderId ?? folderId;
  const selection = scheduledMode
    ? EMPTY_SELECTION_DETAIL
    : await loadSelectionDetail({
        context: params.context,
        mailboxId: params.mailboxId,
        conversationId: selectedConversationId,
        messageId: selectedMessageId,
        preferredFolderId,
      });

  const activeFolder = folders.find((folder) => folder.id === folderId);
  const selectedSubject = selection.detailMessages.at(-1)?.subject || selectedListItem?.subject || "Message";

  return ok({
    mailbox: mailboxResult.data,
    permission: permission.data,
    initialLiveCursor,
    folders,
    identities: identityResult.ok ? identityResult.data : [],
    scheduledMode,
    scheduledCount: scheduledPageResult?.ok ? scheduledPageResult.data.total : scheduledCountResult.ok ? scheduledCountResult.data : 0,
    scheduledPage: scheduledPageResult?.ok ? scheduledPageResult.data : null,
    scheduledError: scheduledPageResult && !scheduledPageResult.ok ? scheduledPageResult.error.message : null,
    localTags: localTagResult.ok ? localTagResult.data : [],
    activeView,
    savedViewId,
    savedViews: savedViewResult.ok ? savedViewResult.data : [],
    listMode,
    folderId,
    viewCounts: viewCountsResult.ok ? viewCountsResult.data : EMPTY_VIEW_COUNTS,
    query,
    selectedConversationId,
    selectedMessageId,
    listItems: list.items,
    listCursor,
    nextListCursor: list.nextCursor,
    listError: list.error,
    listTitle: scheduledMode
      ? "Scheduled"
      : resolvedSearch.error
        ? "Search"
        : searchExpression
          ? query
            ? `Results for “${query}”`
            : "Filtered search"
          : activeView
            ? VIEW_LABELS[activeView]
            : (activeSavedView?.name ?? activeFolder?.name ?? "All mail"),
    ...selection,
    selectedSubject,
  });
};
