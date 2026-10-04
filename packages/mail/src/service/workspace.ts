import { logger } from "@k2b/cloud/services";
import { err, fail, i18n, ok, type Result, type ServiceError } from "@k2b/stdlib";
import { z } from "zod";
import {
  type ConversationDraftSummary,
  type ConversationView,
  conversationViewSchema,
  type DraftFolderPage,
  type Mailbox,
  type MailSearchExpression,
  type ScheduledSendPage,
  type SenderIdentity,
} from "../contracts";
import {
  MAIL_SEARCH_MATCHES_NOTHING,
  MAIL_SEARCH_PARAMETER,
  mailSearchReferences,
  type ResolvedMailSearchRoute,
  replaceMailSearchReferences,
  resolveMailSearchRoute,
} from "../search-state";
import type { MailRequestContext } from "./auth";
import type { ConversationCollaboration, ConversationComment, MailActivityEvent, MailAssignableUser } from "./collaboration";
import * as collaboration from "./collaboration";
import * as conversationReferences from "./conversation-reference";
import type { ConversationContentSummary } from "./conversation-summary";
import * as conversationSummaries from "./conversation-summary";
import * as drafts from "./drafts";
import { localizeMailError } from "./error-messages";
import { latestMailInvalidationCursor } from "./events";
import { isAggregatedListing } from "./folder-display";
import { FOLLOW_UP_VIEWS } from "./follow-up-scope";
import type { ConversationLocalTags, LocalTag } from "./local-tags";
import * as localTags from "./local-tags";
import * as mailboxes from "./mailboxes";
import type { ConversationSummary, ConversationViewCounts, MailFolderView, MessageDetail } from "./messages";
import * as messages from "./messages";
import * as publicResources from "./public-resources";
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

const workspaceMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      view: ({ view }: { view: ConversationView }) =>
        ({
          needs_action: "Needs action",
          mine: "Assigned to me",
          unassigned: "Unassigned",
          waiting: "Waiting for reply",
          done: "Done",
          snoozed: "Later",
          send_problems: "Send problems",
          recently_active: "Recent activity",
        })[view],
      scheduled: "Scheduled",
      search: "Search",
      resultsFor: ({ query }: { query: string }) => `Results for “${query}”`,
      filteredSearch: "Filtered search",
      allMail: "All mail",
    },
    de: {
      view: ({ view }) =>
        ({
          needs_action: "Handlungsbedarf",
          mine: "Mir zugewiesen",
          unassigned: "Nicht zugewiesen",
          waiting: "Wartet auf Antwort",
          done: "Erledigt",
          snoozed: "Später",
          send_problems: "Versandprobleme",
          recently_active: "Letzte Aktivität",
        })[view],
      scheduled: "Geplant",
      search: "Suche",
      resultsFor: ({ query }) => `Ergebnisse für „${query}“`,
      filteredSearch: "Gefilterte Suche",
      allMail: "Alle E-Mails",
    },
  },
});

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
  /** The Drafts folder is open: it lists the mailbox's drafts instead of conversations. */
  draftsMode: boolean;
  draftsPage: DraftFolderPage | null;
  draftsError: string | null;
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
  listError: MailListError | null;
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

/** Why the list could not load. Codes stay untranslated; the list shows a localized, actionable message. */
export type MailListError = "invalid_search" | "search_failed" | "load_failed";

type MailListPage = {
  items: MailListItem[];
  nextCursor: string | null;
  error: MailListError | null;
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
  if (!result.ok) return { items: [], nextCursor: null, error: "load_failed" };
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
  locale?: string | null;
}) => {
  const errorMessage = (error: ServiceError) => localizeMailError(error, params.locale).message;
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
    detailError: detailResult.ok ? null : errorMessage(detailResult.error),
    collaborationState: stateResult.ok ? stateResult.data : null,
    conversationLocalTags: tagResult.ok ? tagResult.data : null,
    comments: commentsResult.ok ? commentsResult.data.items : [],
    commentsCursor: commentsResult.ok ? commentsResult.data.nextCursor : null,
    assignableUsers: usersResult.ok ? usersResult.data : [],
    activity: activityResult.ok ? activityResult.data.items : [],
    reminder: reminderResult.ok ? reminderResult.data : null,
    collaborationError: !stateResult.ok ? errorMessage(stateResult.error) : !tagResult.ok ? errorMessage(tagResult.error) : null,
    detailErrors: {
      collaboration: stateResult.ok ? null : errorMessage(stateResult.error),
      tags: tagResult.ok ? null : errorMessage(tagResult.error),
      comments: commentsResult.ok ? null : errorMessage(commentsResult.error),
      assignableUsers: usersResult.ok ? null : errorMessage(usersResult.error),
      activity: activityResult.ok ? null : errorMessage(activityResult.error),
      reminder: reminderResult.ok ? null : errorMessage(reminderResult.error),
      reference: referenceResult.ok ? null : errorMessage(referenceResult.error),
      summary: summaryResult.ok ? null : errorMessage(summaryResult.error),
      drafts: draftsResult.ok ? null : errorMessage(draftsResult.error),
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
  locale?: string | null;
}): Promise<MailConversationDetailData | null> => {
  const permission = await collaboration.requireMailboxCollaborationPermission(params.context, params.mailboxId, "read");
  if (!permission.ok || permission.data === "none") return null;
  const conversation = await messages.listConversationMessages({
    context: params.context,
    mailboxId: params.mailboxId,
    conversationId: params.conversationId,
    limit: 1,
  });
  if (!conversation.ok) return null;
  const [detail, availableTags] = await Promise.all([
    loadConversationDetails(params),
    localTags.listLocalTags(params.context, params.mailboxId),
  ]);
  const availableTagsError = availableTags.ok ? null : localizeMailError(availableTags.error, params.locale).message;
  return {
    ...detail,
    conversationId: params.conversationId,
    collaborationError: detail.collaborationError ?? availableTagsError,
    detailErrors: { ...detail.detailErrors, tags: detail.detailErrors.tags ?? availableTagsError },
    localTags: availableTags.ok ? availableTags.data : [],
    selectedSubject: detail.detailMessages.at(-1)?.subject ?? "",
  };
};

const loadSelectionDetail = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string | null;
  messageId: string | null;
  preferredFolderId?: string | null;
  locale?: string | null;
}): Promise<MailSelectionDetail> => {
  if (params.conversationId) {
    return await loadConversationDetails({
      context: params.context,
      mailboxId: params.mailboxId,
      conversationId: params.conversationId,
      preferredFolderId: params.preferredFolderId,
      locale: params.locale,
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
    : { ...EMPTY_SELECTION_DETAIL, detailError: localizeMailError(detail.error, params.locale).message };
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
  // Send problems has no search condition: it lists the messages whose send needs attention.
  const sendProblems = !params.searchExpression && !params.savedView && !params.folderId && params.activeView === "send_problems";

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
      sendProblems,
      aggregatedView: !params.searchExpression && !params.savedView && isAggregatedListing(params.folderId, params.activeView),
    });
    if (!result.ok) {
      return { items: [], nextCursor: null, error: params.searchExpression || params.savedView ? "search_failed" : "load_failed" };
    }
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
    if (!result.ok) return { items: [], nextCursor: null, error: "search_failed" };
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
  if (!result.ok) return { items: [], nextCursor: null, error: "load_failed" };
  const items = result.data.items.map(conversationToListItem);
  return attachLocalTags(params.context, params.mailboxId, items, result.data.nextCursor);
};

/** A workspace URL after its public IDs were resolved: resource parameters and search conditions carry internal IDs. */
export type MailWorkspaceRequest = { requestUrl: URL; search: ResolvedMailSearchRoute };

/**
 * Resolves the public IDs of a browser workspace URL once, for the SSR page and the workspace-route API alike.
 * Returns null when a resource parameter is not part of this mailbox. A folder or tag condition whose folder or
 * tag no longer exists matches nothing, so a stale search link still opens and shows no results.
 */
export const resolveWorkspaceRequest = async (publicUrl: URL, mailboxId: string): Promise<MailWorkspaceRequest | null> => {
  const requestUrl = new URL(publicUrl);
  const resources = [
    ["savedView", "savedViews"],
    ["folder", "folders"],
    ["conversation", "conversations"],
    ["message", "messages"],
  ] as const;
  for (const [name, table] of resources) {
    const shortId = requestUrl.searchParams.get(name);
    if (shortId === null) continue;
    const id = await publicResources.resolveMailboxPublicId(table, mailboxId, shortId);
    if (!id) return null;
    requestUrl.searchParams.set(name, id);
  }
  requestUrl.searchParams.delete(MAIL_SEARCH_PARAMETER);
  const search = resolveMailSearchRoute(publicUrl);
  if (!search.expression) return { requestUrl, search };
  const references = mailSearchReferences(search.expression);
  const [folders, tags] = await Promise.all([
    publicResources.resolveExistingMailboxPublicIds(
      "folders",
      mailboxId,
      references.flatMap((reference) => (reference.type === "folder_id" ? [reference.folderId] : [])),
    ),
    publicResources.resolveExistingMailboxPublicIds(
      "tags",
      mailboxId,
      references.flatMap((reference) => (reference.type === "local_tag_id" ? [reference.tagId] : [])),
    ),
  ]);
  const expression = replaceMailSearchReferences(search.expression, (reference) => {
    const id = reference.type === "folder_id" ? folders.get(reference.folderId) : tags.get(reference.tagId);
    if (!id) return MAIL_SEARCH_MATCHES_NOTHING;
    return reference.type === "folder_id" ? { ...reference, folderId: id } : { ...reference, tagId: id };
  });
  return { requestUrl, search: { ...search, expression } };
};

export const loadMailboxPageData = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  requestUrl: URL;
  search: ResolvedMailSearchRoute;
  listMode?: MailListMode;
  locale?: string | null;
}): Promise<Result<MailboxPageData>> => {
  const t = workspaceMessages.resolve([params.locale ?? "en"]).t;
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
  const resolvedSearch = params.search;
  const { query, expression: searchExpression, sort: searchSort } = resolvedSearch;
  const listCursor = params.requestUrl.searchParams.get("cursor");
  const selectedConversationId = optionalUuidSearchParam(params.requestUrl, "conversation");
  const selectedMessageId = optionalUuidSearchParam(params.requestUrl, "message");
  const folders = folderResult.ok ? folderResult.data : [];
  const activeSavedView = savedViewResult.ok ? (savedViewResult.data.find((view) => view.id === savedViewId) ?? null) : null;
  const listMode = params.listMode ?? "conversations";
  const defaultAllMail = !scheduledMode && !searchExpression && !folderId && !activeView && !activeSavedView;
  const activeFolder = folders.find((folder) => folder.id === folderId);
  const draftsMode =
    !scheduledMode &&
    !searchExpression &&
    !resolvedSearch.error &&
    !!activeFolder &&
    messages.isEffectiveDraftsFolder(activeFolder, folders);
  const excludedFolderIds =
    defaultAllMail || (!searchExpression && activeView && FOLLOW_UP_VIEWS.includes(activeView))
      ? folders.filter((folder) => folder.role === "trash" || folder.role === "junk").map((folder) => folder.id)
      : [];
  const [list, scheduledPageResult, draftsPageResult] = await Promise.all([
    scheduledMode || draftsMode
      ? Promise.resolve({ items: [], nextCursor: null, error: null })
      : resolvedSearch.error
        ? Promise.resolve({
            items: [],
            nextCursor: null,
            error: "invalid_search" as const,
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
    draftsMode
      ? drafts.listDraftFolder({ context: params.context, mailboxId: params.mailboxId, cursor: listCursor ?? undefined, limit: 50 })
      : Promise.resolve(null),
  ]);
  const selectedListItem = list.items.find((item) =>
    item.selectionKind === "message" ? item.id === selectedMessageId : item.conversationId === selectedConversationId,
  );
  const preferredFolderId = selectedListItem?.sourceFolderId ?? folderId;
  const selection =
    scheduledMode || draftsMode
      ? EMPTY_SELECTION_DETAIL
      : await loadSelectionDetail({
          context: params.context,
          mailboxId: params.mailboxId,
          conversationId: selectedConversationId,
          messageId: selectedMessageId,
          preferredFolderId,
          locale: params.locale,
        });

  const selectedSubject = selection.detailMessages.at(-1)?.subject || selectedListItem?.subject || "";

  return ok({
    mailbox: mailboxResult.data,
    permission: permission.data,
    initialLiveCursor,
    folders,
    identities: identityResult.ok ? identityResult.data : [],
    scheduledMode,
    scheduledCount: scheduledPageResult?.ok ? scheduledPageResult.data.total : scheduledCountResult.ok ? scheduledCountResult.data : 0,
    scheduledPage: scheduledPageResult?.ok ? scheduledPageResult.data : null,
    scheduledError:
      scheduledPageResult && !scheduledPageResult.ok ? localizeMailError(scheduledPageResult.error, params.locale).message : null,
    draftsMode,
    draftsPage: draftsPageResult?.ok ? draftsPageResult.data : null,
    draftsError: draftsPageResult && !draftsPageResult.ok ? localizeMailError(draftsPageResult.error, params.locale).message : null,
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
      ? t.scheduled
      : resolvedSearch.error
        ? t.search
        : searchExpression
          ? query
            ? t.resultsFor({ query })
            : t.filteredSearch
          : activeView
            ? t.view({ view: activeView })
            : (activeSavedView?.name ?? activeFolder?.name ?? t.allMail),
    ...selection,
    selectedSubject,
  });
};
