import { liveConnection } from "@k2b/cloud/browser/live";
import { publishPageContext } from "@k2b/cloud/browser/panel";
import { importOnDemand, reloadOnce } from "@k2b/cloud/browser/reload";
import type { CloudTheme } from "@k2b/cloud/shared";
import { layout } from "@k2b/cloud/ssr/layout-runtime";
import {
  captureScroll,
  documentNavigate,
  type LinkNavigateEvent,
  listenPopState,
  navigate,
  restoreScroll,
  type ScrollSnapshot,
} from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { mutation, query } from "@k2b/stdlib/solid";
import {
  AppWorkspace,
  type AppWorkspaceWidthShare,
  announce,
  openSpotlightSearch,
  Placeholder,
  prompts,
  type ToastHandle,
  toast,
  useLocale,
} from "@k2b/ui";
import { type Accessor, batch, createEffect, createMemo, createSignal, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import { apiClient } from "../api/client";
import type { MailContactDirectory } from "../contact-directory";
import type { MailDraftSeed } from "../contracts";
import { isAggregatedListing, mailListingExcludesTrashAndJunk, mailRowLeavesListing } from "../folder-display-rules";
import { mailFolderPaths } from "../folder-tree";
import { parseMailLiveEvent } from "../live-event";
import { guaranteedMailSearchFolderIds } from "../search-folder-scope";
import type { ConversationCollaboration, MailActivityEvent } from "../service/collaboration";
import type { ConversationLocalTags } from "../service/local-tags";
import type { ConversationPresenceSnapshot } from "../service/presence";
import type { MailboxListView, MailboxPageData, MailConversationDetailData, MailListItem } from "../service/workspace";
import { readApiError } from "./_components/api-response";
import { chooseBulkTags, chooseConversationTags } from "./_components/MailBulkTagDialog";
import { createMailboxMenu, MailboxMenuButton } from "./_components/MailboxMenu";
import MailConversationList from "./_components/MailConversationList";
import MailConversationReader, { MAIL_CONTEXT_DETAIL_ID } from "./_components/MailConversationReader";
import MailDetailsPanel from "./_components/MailDetailsPanel";
import MailDraftsView from "./_components/MailDraftsView";
import MailScheduledView from "./_components/MailScheduledView";
import { observeMailUserPreferences, readMailUserPreferences, writeMailUserPreferences } from "./_components/MailSettingsStore";
import MailSidebar, { type MailSidebarMailbox, type MailSidebarOpenMailbox } from "./_components/MailSidebar";
import { MailboxHeadFilters, MailboxViewTabs, MailListModeMenu } from "./_components/MailWorkspaceHead";
import { createMailActionOutcomes, type MailActionCommand, type MailActionFailureReport } from "./_components/mail-action-outcomes";
import { createMailActionQueue } from "./_components/mail-action-queue";
import {
  buildMailActionInput,
  MAIL_ACTION_MISSING_DESTINATION,
  type MailActionId,
  mailActionTargetForItem,
  mailMoveSourceFolderIds,
  mailRoleDestinationFolderId,
  spamActionForConversation,
} from "./_components/mail-actions";
import { chooseMailAssignee } from "./_components/mail-assign-picker";
import { MAIL_BULK_NO_PROVIDER_PLACEMENT, MAIL_BULK_QUEUE_FAILED, type MailBulkTarget } from "./_components/mail-bulk-actions";
import { runMailBulkAssignment } from "./_components/mail-bulk-assignment";
import { mailDraftSeedHref } from "./_components/mail-compose-route";
import { mailComposeDraftSeedInput } from "./_components/mail-compose-seed";
import { MailContactDirectoryProvider } from "./_components/mail-contact-directory-context";
import {
  emptyMailConversationSelection,
  findMailFocusAfterRemoval,
  pruneMailConversationSelection,
  toggleMailConversationSelection,
} from "./_components/mail-conversation-selection";
import type { MailConversationToolbarActionId } from "./_components/mail-conversation-toolbar";
import { mailConversationUiMessages } from "./_components/mail-conversation-ui-messages";
import { mergeMailCursorPage } from "./_components/mail-cursor-page";
import { preserveUnavailableMailDetail } from "./_components/mail-detail-availability";
import { reconcileConversationSummary } from "./_components/mail-details-reconciliation";
import { createRetryToasts } from "./_components/mail-feedback";
import { buildVisibleMailFolderTree, flattenMailFolderTree, onlyInFolderFolders } from "./_components/mail-folder-tree";
import { mailboxNeedsConnection } from "./_components/mail-health-presentation";
import {
  type MailListOptimisticField,
  type MailListOptimisticPatch,
  mailListMessagePendingKey,
  type PendingMailListState,
  reconcileMailListOptimisticState,
} from "./_components/mail-list-optimistic";
import {
  MAIL_ROW_LEAVE_MS,
  type MailListRemoval,
  mailListRowKey,
  projectMailCounts,
  projectMailList,
} from "./_components/mail-list-projection";
import { createMailboxPreferences } from "./_components/mail-mailbox-preferences";
import {
  buildMailListHref,
  buildMailSearchClearHref,
  isMailWorkspaceUrl,
  MAIL_SEARCH_FROM_PARAMETER,
  mailRouteUrl,
  resolveMailWorkspaceUrl,
} from "./_components/mail-navigation";
import { createMailPresenceSession } from "./_components/mail-presence-session";
import { emptyMailSelection, mailRowOlderThanDetail, pickMailSelection } from "./_components/mail-selection-detail";
import { readMailSenderPreference, selectComposeSenderIdentity, writeMailSenderPreference } from "./_components/mail-sender-preference";
import { mailSidebarMessages } from "./_components/mail-sidebar-messages";
import type { MailUserPreferences } from "./_components/mail-user-preferences";
import { mailboxCurrentTab, mailboxViewTabs } from "./_components/mail-view-tabs";
import {
  decideMailAutoReadIntent,
  type MailWorkspaceActionOptions,
  type MailWorkspaceActionRunnerHost,
  mailOptimisticFields,
  runMailWorkspaceAction,
} from "./_components/mail-workspace-action-runner";
import { composeMailListSnapshot, pickMailWorkspaceFrame } from "./_components/mail-workspace-frame";
import { type MailWorkspacePreferences, updateMailWorkspacePreferences } from "./_components/mail-workspace-preferences";
import {
  captureMailWorkspaceRefreshError,
  type MailWorkspaceRefreshResult,
  requireMailWorkspaceRefresh,
} from "./_components/mail-workspace-refresh";
import { mailWorkspaceMessages } from "./mail-workspace-messages";
import { mailPageMessages } from "./pages-messages";
import { assertCursorProgress } from "./pagination";

/**
 * F2, wide windows: the list grows with the app card from 320 to 440 px (25 % of the card minus 24 px); its pane
 * also holds the 12 px gap to the reader. A Detail is a column only while the reader beside the list keeps 440 px,
 * so Main's minimum is the list pane plus that reader width.
 */
const MAIL_READER_BESIDE_DETAIL = 440;
const MAIL_LIST_WIDTH = { share: 0.25, offset: -12, min: 332, max: 452 } satisfies AppWorkspaceWidthShare;
const MAIL_MAIN_WITH_LIST = {
  share: MAIL_LIST_WIDTH.share,
  offset: MAIL_LIST_WIDTH.offset + MAIL_READER_BESIDE_DETAIL,
  min: MAIL_LIST_WIDTH.min + MAIL_READER_BESIDE_DETAIL,
  max: MAIL_LIST_WIDTH.max + MAIL_READER_BESIDE_DETAIL,
} satisfies AppWorkspaceWidthShare;

const rank = (permission: string): number => (permission === "admin" ? 3 : permission === "write" ? 2 : permission === "read" ? 1 : 0);
const mailListScope = (href: string): string => {
  const url = mailRouteUrl(href);
  url.searchParams.delete("conversation");
  url.searchParams.delete("message");
  url.searchParams.delete("cursor");
  return `${url.pathname}${url.search}`;
};

/** Scheduled and Drafts page through their own lists; every other view pages through conversations. */
const pageNextCursor = (snapshot: MailboxListView): string | null | undefined =>
  snapshot.scheduledMode
    ? snapshot.scheduledPage?.nextCursor
    : snapshot.draftsMode
      ? snapshot.draftsPage?.nextCursor
      : snapshot.nextListCursor;

type MailWorkspaceProps = {
  data: MailboxPageData;
  /** Route as `pathname + search`; resolved against the browser origin, never an upstream URL. */
  requestPath: string;
  currentUserId: string;
  currentUserEmail: string | null;
  contactDirectory: MailContactDirectory;
  dateConfig: DateContext;
  initialPreferences: MailWorkspacePreferences;
  initialUserPreferences: MailUserPreferences;
  /** `null` under Automatic: only the browser knows the device scheme, and it is read on mount. */
  initialTheme: CloudTheme | null;
  calendarIntegrationAvailable: boolean;
  /** The mailboxes the sidebar lists, with this person's pins and hidden mailboxes. */
  sidebar: {
    mailboxes: MailSidebarMailbox[];
    pinnedMailboxIds: string[];
    hiddenMailboxIds: string[];
  };
};

type MailboxSession = Pick<MailWorkspaceProps, "data" | "requestPath" | "initialPreferences" | "initialUserPreferences">;
type MailboxSessionControls = {
  open: Accessor<MailSidebarOpenMailbox>;
  onOpenPlaceRowHiddenChange: (hidden: boolean) => void;
  preferences: Accessor<MailWorkspacePreferences>;
  handle: {
    listMode(): MailboxPageData["listMode"];
    supersede(): void;
    navigateHere(nav: LinkNavigateEvent): Promise<void>;
  };
};

function MailboxWorkspace(
  props: MailWorkspaceProps & {
    switching: Accessor<boolean>;
    onReady: (controls: MailboxSessionControls) => void;
    onNavigationStart: () => void;
    onOpenMailboxHistory: (url: URL, completeScrollRestore: () => void) => void;
  },
) {
  const locale = useLocale();
  const t = createMemo(() => mailWorkspaceMessages.resolve([locale()]).t);
  const conversationText = createMemo(() => mailConversationUiMessages.resolve([locale()]).t);
  // A store keeps shell, list, and detail consumers granular even though the
  // server snapshot remains one canonical contract.
  const [data, setData] = createStore(props.data);
  const [requestPath, setRequestPath] = createSignal(props.requestPath);
  const [listCollapsed, setListCollapsed] = createSignal(props.initialPreferences.listCollapsed);
  const [detailsOpen, setDetailsOpen] = createSignal(props.initialPreferences.detailsOpen);
  const [toolbarActions, setToolbarActions] = createSignal(props.initialPreferences.toolbarActions);
  const [theme, setTheme] = createSignal<CloudTheme | null>(props.initialTheme);
  const [presence, setPresence] = createSignal<ConversationPresenceSnapshot>({
    participants: [],
  });
  const [settingsOpening, setSettingsOpening] = createSignal(false);
  const [detailsOpening, setDetailsOpening] = createSignal(false);
  const [managementOpening, setManagementOpening] = createSignal<"health" | "links" | "remote-content" | "subscriptions" | null>(null);
  const [liveUnavailable, setLiveUnavailable] = createSignal(false);
  /** The live subscription has applied every update the server sent, so the counts and folders shown are current. */
  let liveCaughtUp = false;
  const activeSearch = () => data.search;
  const [conversationSelection, setConversationSelection] = createSignal(emptyMailConversationSelection());
  const [selectionMode, setSelectionMode] = createSignal(false);
  const [conversationOpenIntent, setConversationOpenIntent] = createSignal(0);
  const mailboxId = props.data.mailbox.id;
  const userPreferences = createMemo(() => observeMailUserPreferences(mailboxId, props.initialUserPreferences));
  // The views that mix folders name the first folder set to "Only in the folder" until this person dismisses it.
  // The dismissals live in the preferences cookie, so the server renders the same hint and nothing moves on load.
  const folderOnlyHint = createMemo(() => {
    const aggregated =
      !data.scheduledMode &&
      !data.draftsMode &&
      !data.query &&
      activeSearch().expression === null &&
      !data.savedViewId &&
      isAggregatedListing(data.folderId, data.activeView);
    if (!aggregated) return null;
    const dismissed = new Set(userPreferences().dismissedFolderHints);
    const folder = onlyInFolderFolders(data.folders).find((candidate) => !dismissed.has(candidate.id));
    return folder ? { folder, dismiss: () => dismissFolderOnlyHint(folder.id) } : null;
  });
  const dismissFolderOnlyHint = (folderId: string) => {
    // Only folders that still keep their mail inside stay listed, so the cookie stays as short as the folder list.
    const current = new Set(onlyInFolderFolders(data.folders).map((folder) => folder.id));
    writeMailUserPreferences(mailboxId, {
      dismissedFolderHints: [...userPreferences().dismissedFolderHints.filter((id) => current.has(id) && id !== folderId), folderId],
    });
  };
  let preferenceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingPreferences: Partial<MailWorkspacePreferences> = {};
  const actionQueue = createMailActionQueue();
  onMount(() => {
    const flushActions = () => actionQueue.flush();
    window.addEventListener("pagehide", flushActions);
    onCleanup(() => window.removeEventListener("pagehide", flushActions));
  });
  const [actionsUnsent, setActionsUnsent] = createSignal(false);
  onCleanup(actionQueue.onChange(() => setActionsUnsent(actionQueue.size() > 0)));
  let structureMutationLoading = () => false;
  const structurePending = () => structureMutationLoading() || actionsUnsent();
  const [removals, setRemovals] = createSignal<readonly MailListRemoval[]>([]);
  const removalOwners = new WeakMap<MailListRemoval, symbol>();
  const releasesOnNextSnapshot = new Set<() => void>();
  const leaveTimers = new Set<ReturnType<typeof setTimeout>>();
  const undoNotices = new Set<ToastHandle>();
  const [snapshotItems, setSnapshotItems] = createSignal<readonly MailListItem[]>(structuredClone(props.data.listItems));
  // Keep the starting list position only until the search returns or another view is chosen.
  let searchStart: { scope: string; scroll: ScrollSnapshot; pages: number } | null = null;
  const captureSearchStart = (href: string) => {
    const target = mailRouteUrl(href);
    const startingScope = mailListScope(buildMailSearchClearHref(target));
    if (
      target.searchParams.has(MAIL_SEARCH_FROM_PARAMETER) &&
      !mailRouteUrl(requestPath()).searchParams.has(MAIL_SEARCH_FROM_PARAMETER) &&
      mailListScope(requestPath()) === startingScope
    ) {
      searchStart = {
        scope: startingScope,
        scroll: captureScroll(`[data-scroll-preserve="mail-list-${mailboxId}"]`),
        pages: workspaceQuery.pages().length,
      };
    }
  };
  const searchScrollSnapshot = (href: string) => {
    if (mailRouteUrl(href).searchParams.has(MAIL_SEARCH_FROM_PARAMETER)) return;
    const snapshot = mailListScope(href) === searchStart?.scope ? searchStart : undefined;
    searchStart = null;
    return snapshot;
  };
  const restoreSearchScroll = async (snapshot: ReturnType<typeof searchScrollSnapshot>, source: string) => {
    if (!snapshot || workspaceQuery.pages().length >= snapshot.pages) return;
    // Reload the list's former height after navigation restores the first page's scroll.
    while (
      !disposed &&
      routeSource() === source &&
      workspaceQuery.pages().length < snapshot.pages &&
      workspaceQuery.hasMore() &&
      !workspaceQuery.error()
    ) {
      const loaded = workspaceQuery.pages().length;
      // Join a page load the list started itself; it reports its own failure.
      if (workspaceQuery.loadingMore()) await workspaceQuery.loadMore();
      else if (!(await loadMoreConversations(decodeRouteSource(source).href))) break;
      if (workspaceQuery.pages().length <= loaded) break;
    }
    if (!disposed && routeSource() === source) restoreScroll(snapshot.scroll);
  };
  const listView = createMemo(() => projectMailList({ items: data.listItems, removals: removals(), scope: mailListScope(requestPath()) }));
  const selectableRows = () => listView().items.filter((item) => !listView().leavingKeys.has(mailListRowKey(item)));
  const listCounts = createMemo(() =>
    projectMailCounts({
      folders: data.folders,
      viewCounts: data.viewCounts,
      activeView: data.activeView,
      listMode: data.listMode,
      now: Date.now(),
      currentUserId: props.currentUserId,
      items: snapshotItems(),
      shown: data.listItems,
      removals: removals(),
      scope: mailListScope(requestPath()),
    }),
  );
  /** The folders whose messages the shown list leaves out, by the listing rule the server applies. */
  const excludedListingFolderIds = createMemo(
    () =>
      new Set(
        mailListingExcludesTrashAndJunk({
          viewFolderId: data.folderId,
          activeView: data.activeView,
          hasSearch: data.search.expression !== null,
          hasSavedView: !!data.savedViewId,
          scheduledMode: data.scheduledMode,
        })
          ? data.folders.filter((folder) => folder.role === "trash" || folder.role === "junk").map((folder) => folder.id)
          : [],
      ),
  );
  let disposed = false;
  const focusFrames = new Set<number>();
  let pendingListState = new Map<string, PendingMailListState>();
  const pendingActionOwners = new Map<string, Partial<Record<MailListOptimisticField, symbol>>>();
  const selectedConversationId = createMemo(() => data.selectedConversationId);
  const selectedConversationIds = createMemo(() => conversationSelection().ids);
  const canWrite = createMemo(() => rank(data.permission) >= 2);
  const canAdmin = createMemo(() => rank(data.permission) >= 3);
  /** The person sees only the conversations assigned to them; assigning, merging and mailbox tools need the whole mailbox. */
  const assignedOnly = createMemo(() => data.access.scope === "assigned");
  const canAssign = createMemo(() => canWrite() && !assignedOnly());
  let routeLoading = () => false;
  const workspaceRefreshBlocked = () => settingsOpening() || managementOpening() !== null;

  onMount(() => {
    // This document may come from history; record only the opened mailbox.
    updateMailWorkspacePreferences({ lastMailboxId: mailboxId });
    const root = document.documentElement;
    // Read the class directly: a runtime import from the shared barrel also bundles Markdown, KaTeX and Liquid.
    const syncTheme = () => setTheme(root.classList.contains("dark") ? "dark" : "light");
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    onCleanup(() => observer.disconnect());
  });

  const applyPendingListState = <T extends MailboxListView>(snapshot: T): T => {
    const reconciled = reconcileMailListOptimisticState(snapshot.listItems, pendingListState);
    pendingListState = reconciled.pending;
    return { ...snapshot, listItems: reconciled.items };
  };

  /** `key` is a conversation ID, or `mailListMessagePendingKey` for one message row of a message list. */
  const rememberPendingListState = (key: string, patch: MailListOptimisticPatch) => {
    pendingListState.set(key, {
      ...pendingListState.get(key),
      ...patch,
      expiresAt: Date.now() + 30_000,
    });
  };

  const clearPendingListState = (key: string, fields: MailListOptimisticField[]) => {
    const current = pendingListState.get(key);
    if (!current) return;
    const next = { ...current };
    for (const field of fields) delete next[field];
    if (Object.keys(next).length === 1) pendingListState.delete(key);
    else pendingListState.set(key, next);
  };

  const fetchWorkspaceRoute = async (
    href: string,
    signal: AbortSignal,
    listMode: MailboxPageData["listMode"] = data.listMode,
  ): Promise<MailboxPageData | null> => {
    const target = resolveMailWorkspaceUrl(href, mailboxId, window.location.origin);
    if (!target) return null;
    const response = await apiClient.mailboxes[":mailboxId"]["workspace-route"].$get(
      {
        param: { mailboxId },
        query: { href: `${target.pathname}${target.search}`, listMode },
      },
      { init: { signal } },
    );
    if (!response.ok) return null;
    return await response.json();
  };

  /** Every request path resolves against this mailbox and the browser origin; the list never carries a selection. */
  const fetchWorkspaceList = async (
    href: string,
    signal: AbortSignal,
    listMode: MailboxPageData["listMode"],
  ): Promise<MailboxListView | null> => {
    const target = resolveMailWorkspaceUrl(href, mailboxId, window.location.origin);
    if (!target) return null;
    target.searchParams.delete("conversation");
    target.searchParams.delete("message");
    const response = await apiClient.mailboxes[":mailboxId"]["workspace-list"].$get(
      {
        param: { mailboxId },
        query: { href: `${target.pathname}${target.search}`, listMode },
      },
      { init: { signal } },
    );
    if (!response.ok) return null;
    return await response.json();
  };

  /**
   * Page 1 is the whole workspace snapshot: folders, counts and the open conversation. Every later page is only its
   * list page, so scrolling on and a live refresh of many pages do not rebuild the mailbox once per page.
   */
  /** `generation` is the selection generation when page 1 was requested; a later selection commit makes its selection old. */
  type WorkspaceRouteResult = { source: string; snapshot: MailboxPageData; generation: number } | { source: string; list: MailboxListView };
  const pageList = (page: WorkspaceRouteResult): MailboxListView => ("snapshot" in page ? page.snapshot : page.list);
  type WorkspaceTransition = {
    source: string;
    resolve: (result: "applied" | "failed" | "stale") => void;
  };
  const encodeRouteSource = (href: string, listMode: MailboxPageData["listMode"]) => JSON.stringify({ href, listMode });
  const decodeRouteSource = (source: string): { href: string; listMode: MailboxPageData["listMode"] } => JSON.parse(source);
  /**
   * Sources with the same list scope and list mode show the same list and differ only in the open conversation, so
   * the list query keeps its loaded pages between them. A message selection keeps a source of its own: the snapshot
   * loads a message's detail.
   */
  const routeListKey = (source: string): string => {
    const { href, listMode } = decodeRouteSource(source);
    const url = mailRouteUrl(href);
    if (url.searchParams.has("message")) return source;
    // A starting cursor is part of the list; the mailing list parameter only opens the subscription dialog.
    url.searchParams.delete("conversation");
    url.searchParams.delete("mailingList");
    return JSON.stringify({ list: `${url.pathname}${url.search}`, listMode });
  };
  const sameRouteList = (left: string, right: string) => left === right || routeListKey(left) === routeListKey(right);
  const initialRouteSource = encodeRouteSource(props.requestPath, props.data.listMode);
  const [routeSource, setRouteSource] = createSignal(initialRouteSource);
  const routeKey = createMemo(() => routeListKey(routeSource()));
  let committedRouteSource = initialRouteSource;
  /**
   * Another list without a selection loads only its list view, which also brings the mailbox, access and saved views,
   * and keeps the folders, counts, identities and tags shown (`MailWorkspaceFrame`): live updates refresh them exactly as
   * while the person stays in one list. The whole snapshot loads while live
   * updates are not caught up, when the page started without a live cursor (changes before the subscription would not
   * reach it), for a change of the list mode, and for a target that opens a conversation or message.
   */
  const keepsMailboxFrame = (target: { href: string; listMode: MailboxPageData["listMode"] }): boolean => {
    if (!liveCaughtUp || liveUnavailable() || props.data.initialLiveCursor === null) return false;
    const committed = decodeRouteSource(committedRouteSource);
    const url = mailRouteUrl(target.href);
    return (
      target.listMode === committed.listMode &&
      !url.searchParams.has("conversation") &&
      !url.searchParams.has("message") &&
      mailListScope(target.href) !== mailListScope(committed.href)
    );
  };
  let workspaceTransition: WorkspaceTransition | null = null;
  /**
   * Counts selection changes and navigations: a reload or a page 1 requested for an earlier generation reports itself as
   * stale and keeps the selection shown now.
   */
  let routeGeneration = 0;
  let conversationDetailRequest: AbortController | null = null;
  /** The conversation whose detail is loading, and whether a live change touched it meanwhile. */
  let openingConversation: { id: string; changed: boolean } | null = null;
  /** A conversation opening in the shown list shows the same pending state as a view that loads. */
  const [conversationOpening, setConversationOpening] = createSignal(false);
  /** Page 1 reloads because an open row was older than its detail; auto mark-read waits until every such reload ends. */
  const [rowRefreshes, setRowRefreshes] = createSignal(0);
  const cancelConversationDetail = () => {
    conversationDetailRequest?.abort();
    finishConversationDetail();
  };
  const finishConversationDetail = () => {
    conversationDetailRequest = null;
    openingConversation = null;
    setConversationOpening(false);
  };
  const touches = (conversationIds: readonly (string | null)[] | null, conversationId: string) =>
    conversationIds === null || conversationIds.some((id) => id === null || id === conversationId);

  type ConversationActivityResult = { conversationId: string; items: MailActivityEvent[] };
  const activityQuery = query.create<string | null, ConversationActivityResult>({
    source: selectedConversationId,
    initial: props.data.selectedConversationId
      ? {
          source: props.data.selectedConversationId,
          data: { conversationId: props.data.selectedConversationId, items: props.data.activity },
        }
      : undefined,
    enabled: () => selectedConversationId() !== null,
    load: async (conversationId, { abortSignal }) => {
      if (!conversationId) throw new Error(t().selectConversationActivity);
      const response = await apiClient.mailboxes[":mailboxId"].activity.$get(
        {
          param: { mailboxId },
          query: { conversationId, limit: "30" },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, t().refreshActivityFailed));
      const page = await response.json();
      return { conversationId, items: page.items };
    },
  });
  const conversationActivity = () => {
    const current = activityQuery.data();
    return current?.conversationId === data.selectedConversationId && !activityQuery.error() ? current.items : data.activity;
  };

  const workspaceQuery = query.createInfinite<string, WorkspaceRouteResult, string>({
    source: routeSource,
    // Later reloads and page loads still use the newest source, so page 1 carries the open conversation.
    isSameSource: sameRouteList,
    initial: { source: initialRouteSource, pages: [{ source: initialRouteSource, snapshot: props.data, generation: 0 }] },
    loadPage: async (source, { cursor, abortSignal, cause }) => {
      const target = decodeRouteSource(source);
      const url = new URL(target.href, window.location.origin);
      if (cursor === undefined) {
        const generation = routeGeneration;
        // A reload that also covers an invalidation, such as a live event, loads the whole snapshot.
        if (cause.type === "source" && cause.invalidations.length === 0 && keepsMailboxFrame(target)) {
          const list = await fetchWorkspaceList(url.toString(), abortSignal, target.listMode);
          if (!list) throw new Error(t().loadViewFailed);
          const shown = unwrap(data);
          // The frame shown when the list arrives: a live refresh queued meanwhile reloads the snapshot after it. Folders
          // and counts depend on the access scope, so a scope that changed meanwhile loads the whole snapshot.
          if (list.access.scope === shown.access.scope)
            return { source, snapshot: composeMailListSnapshot(pickMailWorkspaceFrame(shown), list), generation };
        }
        const snapshot = await fetchWorkspaceRoute(url.toString(), abortSignal, target.listMode);
        if (!snapshot) throw new Error(t().loadViewFailed);
        return { source, snapshot, generation };
      }
      url.searchParams.set("cursor", cursor);
      const list = await fetchWorkspaceList(url.toString(), abortSignal, target.listMode);
      if (!list) throw new Error(t().loadViewFailed);
      assertCursorProgress(cursor, pageNextCursor(list), "mailbox");
      return { source, list };
    },
    getNextCursor: (page) => pageNextCursor(pageList(page)),
  });
  routeLoading = () =>
    props.switching() || workspaceQuery.loading() || workspaceQuery.refreshing() || workspaceQuery.loadingMore() || conversationOpening();

  const preserveCurrentDetail = (next: MailboxPageData): MailboxPageData =>
    next.selectedConversationId && next.selectedConversationId === data.selectedConversationId
      ? {
          ...next,
          ...preserveUnavailableMailDetail(data, next),
        }
      : next;

  const replaceWorkspaceRoute = (
    href: string,
    listMode: MailboxPageData["listMode"] = data.listMode,
  ): Promise<"applied" | "failed" | "stale"> => {
    const target = resolveMailWorkspaceUrl(href, mailboxId, window.location.origin);
    if (!target) return Promise.resolve("failed");
    const source = encodeRouteSource(`${target.pathname}${target.search}`, listMode);
    const pending = workspaceTransition;
    if (pending) pending.resolve("stale");
    workspaceTransition = null;
    if (source === routeSource()) {
      const generation = routeGeneration;
      return workspaceQuery.invalidate().then(
        () => (generation === routeGeneration ? "applied" : "stale"),
        () => (generation === routeGeneration ? "failed" : "stale"),
      );
    }
    cancelConversationDetail();
    const generation = ++routeGeneration;
    const previous = routeSource();
    if (!pending && sameRouteList(source, previous)) {
      // Another selection in the same list: the list keeps its pages, and reloading them asks for the new selection.
      setRouteSource(source);
      return workspaceQuery.invalidate().then(
        () => (generation === routeGeneration ? "applied" : "stale"),
        () => {
          if (generation !== routeGeneration) return "stale";
          setRouteSource(committedRouteSource);
          return "failed";
        },
      );
    }
    return new Promise((resolve) => {
      workspaceTransition = { source, resolve };
      setRouteSource(source);
      // The query keeps its pages for a source of the same list, so the transition asks for its own load.
      if (sameRouteList(source, previous)) void workspaceQuery.invalidate().catch(() => undefined);
    });
  };

  // Applies a loaded page set when the pages or the shown list change; another selection of the same list does not
  // reapply the pages, because page 1 may still carry the selection it was loaded with.
  createEffect(
    on([workspaceQuery.pages, routeKey], ([pages, key]) => {
      const first = pages[0];
      if (!first || !("snapshot" in first) || routeListKey(first.source) !== key) return;
      const source = routeSource();
      const target = decodeRouteSource(source);
      // Page 1 was loaded for another conversation of this list: its list, folders and counts are current, its
      // selection is not. Keep the open one, unless the shown list itself is still on its way.
      const otherSelection = first.source !== source || first.generation !== routeGeneration;
      if (otherSelection && routeListKey(committedRouteSource) !== key) return;
      const scopeChanged = mailListScope(requestPath()) !== mailListScope(target.href);
      let next = applyPendingListState(
        // The kept detail also brought the mailbox's tags, which are newer than this page 1's.
        otherSelection
          ? { ...first.snapshot, ...pickMailSelection(unwrap(data)), localTags: unwrap(data).localTags }
          : preserveCurrentDetail(first.snapshot),
      );
      for (const page of pages.slice(1)) {
        const reconciled = applyPendingListState(pageList(page));
        if (next.scheduledMode && next.scheduledPage && reconciled.scheduledPage) {
          const items = new Map(next.scheduledPage.items.map((item) => [item.id, item]));
          for (const item of reconciled.scheduledPage.items) items.set(item.id, item);
          next = {
            ...next,
            scheduledPage: { ...reconciled.scheduledPage, items: [...items.values()] },
            scheduledError: reconciled.scheduledError,
          };
          continue;
        }
        if (next.draftsMode && next.draftsPage && reconciled.draftsPage) {
          const items = new Map(next.draftsPage.items.map((item) => [item.id, item]));
          for (const item of reconciled.draftsPage.items) items.set(item.id, item);
          next = {
            ...next,
            draftsPage: { ...reconciled.draftsPage, items: [...items.values()] },
            draftsError: reconciled.draftsError,
          };
          continue;
        }
        const merged = mergeMailCursorPage({
          currentItems: next.listItems,
          currentNextCursor: next.nextListCursor,
          pageItems: reconciled.listItems,
          pageNextCursor: reconciled.nextListCursor,
        });
        if (!merged.ok) continue;
        next = { ...next, listItems: merged.items, nextListCursor: merged.nextCursor, listError: reconciled.listError };
      }
      batch(() => {
        // Only the page 1 of the requested selection commits its route; an older one keeps the route shown.
        if (!otherSelection) {
          committedRouteSource = source;
          setRequestPath(target.href);
        }
        const rawItems = new Map(pages.flatMap((page) => pageList(page).listItems.map((item) => [mailListRowKey(item), item] as const)));
        setSnapshotItems([...rawItems.values()]);
        setData(reconcile(next));
        const releases = [...releasesOnNextSnapshot];
        releasesOnNextSnapshot.clear();
        for (const release of releases) release();
        setConversationSelection((current) =>
          scopeChanged
            ? emptyMailConversationSelection()
            : pruneMailConversationSelection(
                current,
                new Set(untrack(selectableRows).flatMap((item) => (item.conversationId ? [item.conversationId] : []))),
              ),
        );
        if (scopeChanged) setSelectionMode(false);
      });
      // A transition ends only with the page 1 requested for it; an older one with the same href must not end it.
      if (!otherSelection && workspaceTransition?.source === first.source) {
        workspaceTransition.resolve("applied");
        workspaceTransition = null;
      }
    }),
  );

  createEffect(() => {
    const error = workspaceQuery.error();
    if (!error || routeLoading() || workspaceTransition?.source !== routeSource()) return;
    const transition = workspaceTransition;
    workspaceTransition = null;
    if (routeSource() !== committedRouteSource) setRouteSource(committedRouteSource);
    transition.resolve("failed");
  });

  // A later head or link navigation wins over pending search text.
  let searchControls: { cancelPending: () => void } | undefined;
  const navigationStart = (href: string) => {
    // An explicit link to the current view is still newer than a mailbox switch; background reads bypass this helper.
    if (resolveMailWorkspaceUrl(href, mailboxId, window.location.origin)) props.onNavigationStart();
  };
  const navigateWorkspace = async (nav: LinkNavigateEvent) => {
    navigationStart(nav.href);
    searchControls?.cancelPending();
    // A later navigation wins over a conversation still opening, also when it reloads the shown view.
    cancelConversationDetail();
    captureSearchStart(nav.href);
    const result = await replaceWorkspaceRoute(nav.href);
    if (result === "applied") {
      const snapshot = searchScrollSnapshot(nav.href);
      const source = routeSource();
      nav.push(undefined, { scroll: "preserve", scrollSnapshot: snapshot?.scroll });
      void restoreSearchScroll(snapshot, source);
    } else if (result === "failed") toast.error(t().openViewFailed);
  };

  const closeConversation = async (nav: LinkNavigateEvent) => {
    navigationStart(nav.href);
    const previousConversationId = data.selectedConversationId;
    const result = inCurrentList(nav.href) ? closeConversationInList(nav.href) : await replaceWorkspaceRoute(nav.href);
    if (result === "applied") {
      nav.push(undefined, { scroll: "preserve" });
      if (previousConversationId) focusConversation(previousConversationId, "row");
    } else if (result === "failed") toast.error(t().closeConversationFailed);
  };

  const transitionWorkspaceHref = async (href: string, replace = false): Promise<MailWorkspaceRefreshResult> => {
    navigationStart(href);
    cancelConversationDetail();
    captureSearchStart(href);
    const result = await replaceWorkspaceRoute(href);
    if (result === "applied") {
      if (data.selectedConversationId) setConversationOpenIntent((intent) => intent + 1);
      const snapshot = searchScrollSnapshot(href);
      const source = routeSource();
      navigate(href, { replace, scroll: "preserve", scrollSnapshot: snapshot?.scroll });
      void restoreSearchScroll(snapshot, source);
    }
    return result;
  };

  const openWorkspaceHref = async (href: string, replace = false) => {
    const result = await transitionWorkspaceHref(href, replace);
    if (result === "failed") toast.error(t().openViewFailed);
  };

  const loadMoreConversations = async (href: string): Promise<boolean> => {
    if (routeLoading()) return false;
    if (!resolveMailWorkspaceUrl(href, mailboxId, window.location.origin)) return false;
    await workspaceQuery.loadMore();
    const error = workspaceQuery.error();
    if (error) toast.error(error.message);
    return !error;
  };

  const persistPreferences = (patch: Partial<MailWorkspacePreferences>) => {
    pendingPreferences = { ...pendingPreferences, ...patch };
    if (preferenceTimer) clearTimeout(preferenceTimer);
    preferenceTimer = setTimeout(() => {
      updateMailWorkspacePreferences(pendingPreferences);
      pendingPreferences = {};
    }, 120);
  };

  const setCollapsed = (collapsed: boolean) => {
    setListCollapsed(collapsed);
    persistPreferences({ listCollapsed: collapsed });
  };

  const updateToolbarActions = (actions: MailConversationToolbarActionId[]) => {
    setToolbarActions(actions);
    persistPreferences({ toolbarActions: actions });
  };

  const updateListMode = (listMode: MailboxPageData["listMode"]) => {
    if (listMode === data.listMode) return;
    props.onNavigationStart();
    const previousListMode = data.listMode;
    updateMailWorkspacePreferences({ listMode });
    setConversationSelection(emptyMailConversationSelection());
    setSelectionMode(false);
    void (async () => {
      const href = buildMailListHref(mailRouteUrl(requestPath()));
      const result = await replaceWorkspaceRoute(href, listMode);
      if (result === "applied") {
        navigate(href, { replace: true, scroll: "preserve" });
        return;
      }
      updateMailWorkspacePreferences({ listMode: previousListMode });
      if (result === "failed") toast.error(t().changeListViewFailed);
    })();
  };

  createEffect(() => {
    const conversationId = selectedConversationId();
    if (!conversationId) {
      setPresence({ participants: [] });
      return;
    }
    const peerId = crypto.randomUUID();
    const session = createMailPresenceSession({
      heartbeat: async (signal) => {
        const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].presence.$put(
          {
            param: { mailboxId, conversationId },
            json: {
              peerId,
              mode: "viewing",
            },
          },
          { init: { signal } },
        );
        return response.ok ? response.json() : null;
      },
      leave: async () => {
        await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].presence.$delete(
          {
            param: { mailboxId, conversationId },
            json: { peerId },
          },
          { init: { keepalive: true } },
        );
      },
      onSnapshot: setPresence,
    });
    const heartbeat = () => {
      if (document.visibilityState === "visible") void session.heartbeat();
    };
    heartbeat();
    const timer = window.setInterval(heartbeat, 10_000);
    const onVisibility = heartbeat;
    document.addEventListener("visibilitychange", onVisibility);
    onCleanup(() => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      session.dispose();
      setPresence({ participants: [] });
    });
  });

  // A live refresh waits while a settings or management dialog is open; what the dialog changed refreshes the view
  // when it closes.
  const refreshWaiters: Array<() => void> = [];
  createEffect(() => {
    if (!workspaceRefreshBlocked()) for (const resume of refreshWaiters.splice(0)) resume();
  });
  const whenRefreshAllowed = (): Promise<void> =>
    workspaceRefreshBlocked() ? new Promise((resume) => refreshWaiters.push(resume)) : Promise.resolve();

  /**
   * Refreshes the view, and the open conversation's activity when a change may touch it; `null` stands for any
   * change. Only the view decides whether the refresh worked: the activity shows its own error, and the server's
   * activity stays in place.
   */
  const refreshLiveData = async (conversationIds: readonly (string | null)[] | null): Promise<void> => {
    // A detail that is loading may have been read before this change; it reloads once it is shown.
    if (openingConversation && touches(conversationIds, openingConversation.id)) openingConversation.changed = true;
    await whenRefreshAllowed();
    const selected = selectedConversationId();
    const activity = selected !== null && touches(conversationIds, selected);
    if (activity) void activityQuery.invalidate().catch(() => undefined);
    await workspaceQuery.invalidate();
  };

  const openSettings = async (initialTab?: string) => {
    if (disposed || settingsOpening()) return;
    setSettingsOpening(true);
    try {
      // Settings, management and details dialogs load their code on first open, behind the pending state.
      const settings = await importOnDemand(() => import("./_components/MailboxSettingsDialog"));
      if (!settings || disposed) return;
      const result = await settings.openMailboxSettingsDialog({
        mailboxId: data.mailbox.id,
        currentUserEmail: props.currentUserEmail,
        contactDirectory: props.contactDirectory,
        initialTab,
      });
      if (disposed) return;
      if (result.deleted) return documentNavigate("/app/mail");
      if (!result.workspaceChanged) return;
      const refreshResult = await replaceWorkspaceRoute(requestPath());
      if (refreshResult === "failed") toast.error(t().settingsRefreshFailed);
    } finally {
      if (!disposed) setSettingsOpening(false);
    }
  };

  /** Loads the details and the dialog code first, so the dialog opens complete instead of growing as they arrive. */
  const openDetails = async () => {
    if (disposed || detailsOpening()) return;
    setDetailsOpening(true);
    let details: Awaited<ReturnType<typeof loadDetails>>;
    let dialog: typeof import("./_components/MailboxDetailsDialog") | undefined;
    try {
      [details, dialog] = await Promise.all([loadDetails(), importOnDemand(() => import("./_components/MailboxDetailsDialog"))]);
    } catch (error) {
      retryToast(error instanceof Error ? error.message : String(error), {
        title: t().mailboxDetailsFailed,
        retryLabel: t().tryAgain,
        retry: openDetails,
      });
      return;
    } finally {
      if (!disposed) setDetailsOpening(false);
    }
    if (!dialog || disposed) return;
    const result = await dialog.openMailboxDetailsDialog({
      mailbox: data.mailbox,
      identities: data.identities,
      folderCount: data.folders.length,
      details,
      dateConfig: props.dateConfig,
    });
    if (result === "manage-access" && !disposed) await openSettings("access");
  };
  const loadDetails = async () => {
    const response = await apiClient.mailboxes[":mailboxId"].details.$get({ param: { mailboxId: data.mailbox.id } });
    if (!response.ok) throw new Error(await readApiError(response, t().mailboxDetailsFailed));
    return response.json();
  };

  const [composeStarting, setComposeStarting] = createSignal(false);
  let composeRequest: AbortController | null = null;
  let composeProgress: ToastHandle | null = null;
  const endComposeStart = () => {
    composeRequest = null;
    composeProgress?.dismiss();
    composeProgress = null;
    setComposeStarting(false);
  };
  /**
   * Compose from this mailbox: prepares the draft seed here and opens its composer as the one page load, as Reply and
   * Forward do, with the compose page's sender rule, request and return target. Without a selectable sender, `fallback`
   * opens the compose page, which explains why. A trigger without its own pending spot (the phone menu, the command)
   * asks for the progress toast.
   */
  const startCompose = async (options: { fallback: () => void; progressToast: boolean }) => {
    if (disposed || composeStarting()) return;
    const mailboxId = data.mailbox.id;
    const identity = selectComposeSenderIdentity(data.identities, readMailSenderPreference(localStorage, mailboxId), true);
    if (!identity) return options.fallback();
    setComposeStarting(true);
    const request = new AbortController();
    composeRequest = request;
    if (options.progressToast)
      composeProgress = toast(t().preparingMessage, { progress: "indeterminate", duration: 0, iconClass: "ti ti-pencil" });
    let seed: MailDraftSeed;
    let store: typeof import("./_components/mail-draft-seed-store") | undefined;
    try {
      // The seed store is loaded on demand, as in the reader, and in parallel with the request.
      const [response, loaded] = await Promise.all([
        apiClient.mailboxes[":mailboxId"]["draft-seeds"].$post(
          { param: { mailboxId }, json: mailComposeDraftSeedInput(identity.id) },
          { init: { signal: request.signal } },
        ),
        importOnDemand(() => import("./_components/mail-draft-seed-store")),
      ]);
      if (!response.ok) throw new Error(await readApiError(response, t().draftCreateFailed));
      seed = await response.json();
      store = loaded;
    } catch (error) {
      if (disposed || request.signal.aborted) return;
      endComposeStart();
      void prompts.error(error instanceof Error ? error.message : t().draftCreateFailed, { title: t().startMessageFailed });
      return;
    }
    if (disposed) return;
    // importOnDemand already offers a reload when the code cannot load.
    if (!store) return endComposeStart();
    writeMailSenderPreference(localStorage, seed.mailboxId, identity.id);
    try {
      store.storeMailDraftSeed(localStorage, seed);
    } catch {
      endComposeStart();
      void prompts.error(t().localMessageFailed, { title: t().startMessageFailed });
      return;
    }
    // Stays pending until the composer replaces this page, so another activation meanwhile starts no second seed.
    documentNavigate(mailDraftSeedHref(seed.mailboxId, seed.id, `/app/mail/${seed.mailboxId}`));
  };
  onMount(() => {
    // A page restored from the back-forward cache shows Compose ready again.
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) endComposeStart();
    };
    window.addEventListener("pageshow", restored);
    onCleanup(() => window.removeEventListener("pageshow", restored));
  });
  onCleanup(() => {
    composeRequest?.abort();
    composeProgress?.dismiss();
  });

  const openHealth = async () => {
    if (disposed || managementOpening()) return;
    setManagementOpening("health");
    try {
      const health = await importOnDemand(() => import("./_components/MailboxHealthDialog"));
      if (!health || disposed) return;
      const result = await health.openMailboxHealthDialog({ mailboxId: data.mailbox.id, dateConfig: props.dateConfig });
      if (disposed) return;
      if (!result.workspaceChanged) return;
      const refreshResult = await replaceWorkspaceRoute(requestPath());
      if (refreshResult === "failed") toast.error(t().healthRefreshFailed);
    } finally {
      if (!disposed) setManagementOpening(null);
    }
  };

  const openSharedLinks = async () => {
    if (disposed || managementOpening()) return;
    setManagementOpening("links");
    try {
      const links = await importOnDemand(() => import("./_components/MailAttachmentLinksDialog"));
      if (!links || disposed) return;
      await links.openMailAttachmentLinksDialog({ mailboxId: data.mailbox.id, dateConfig: props.dateConfig });
    } finally {
      if (!disposed) setManagementOpening(null);
    }
  };

  const openRemoteContent = async () => {
    if (disposed || managementOpening()) return;
    setManagementOpening("remote-content");
    try {
      const rules = await importOnDemand(() => import("./_components/MailRemoteContentRulesDialog"));
      if (!rules || disposed) return;
      await rules.openMailRemoteContentRulesDialog(data.mailbox.id);
    } finally {
      if (!disposed) setManagementOpening(null);
    }
  };

  const openSubscriptions = async (initialListKey: string | null = null) => {
    if (disposed || managementOpening()) return;
    setManagementOpening("subscriptions");
    try {
      const subscriptions = await importOnDemand(() => import("./_components/MailSubscriptionDialog"));
      if (!subscriptions || disposed) return;
      await subscriptions.openMailSubscriptionDialog({
        mailboxId: data.mailbox.id,
        canWrite: canWrite(),
        initialListKey,
        liveCursor: data.initialLiveCursor,
      });
    } finally {
      if (!disposed) setManagementOpening(null);
      if (!initialListKey || disposed) return;
      const current = new URL(window.location.href);
      const currentListKey = current.searchParams.get("mailingList")?.trim().toLowerCase().slice(0, 4096) || null;
      if (currentListKey !== initialListKey) return;
      current.searchParams.delete("mailingList");
      window.history.replaceState(window.history.state, "", `${current.pathname}${current.search}${current.hash}`);
      const path = `${current.pathname}${current.search}`;
      // Later reloads of this list must not bring the closed dialog's parameter back.
      const source = encodeRouteSource(path, data.listMode);
      if (!workspaceTransition && sameRouteList(source, committedRouteSource)) {
        committedRouteSource = source;
        setRouteSource(source);
      }
      setRequestPath(path);
    }
  };

  let openedMailingListKey: string | null = null;
  createEffect(() => {
    const key = mailRouteUrl(requestPath()).searchParams.get("mailingList")?.trim().toLowerCase().slice(0, 4096) || null;
    if (!key) {
      openedMailingListKey = null;
      return;
    }
    if (key === openedMailingListKey || managementOpening()) return;
    openedMailingListKey = key;
    void openSubscriptions(key);
  });

  onMount(() => {
    setRequestPath(`${window.location.pathname}${window.location.search}`);
    const subscription = liveConnection("/api/mail/live").subscribe(
      "mailbox",
      { mailbox: mailboxId },
      {
        cursor: props.data.initialLiveCursor,
        parse: (data) => parseMailLiveEvent(data),
        apply: (events) => refreshLiveData(events.map((event) => event.data.conversationId)),
        resync: () => refreshLiveData(null),
        caughtUp: (caughtUp) => {
          liveCaughtUp = caughtUp;
        },
        revoked: () => void documentNavigate("/app/mail", { replace: true }),
        // A reload lets the route policy send an ended session to sign-in. A failure that survives it must not
        // reload in a loop.
        unavailable: () => {
          if (!reloadOnce(`mail:live:${mailboxId}`)) setLiveUnavailable(true);
        },
      },
    );
    const stopPopState = listenPopState(({ url, deferScrollRestore }) => {
      // The shared history owner keeps the destination snapshot until this navigation commits its list DOM.
      const completeScrollRestore = deferScrollRestore();
      if (!isMailWorkspaceUrl(url, mailboxId, window.location.origin)) {
        props.onOpenMailboxHistory(url, completeScrollRestore);
        return;
      }
      const href = `${url.pathname}${url.search}`;
      // Every traversal is a newer intent, even when returning to the still-shown mailbox during a pending switch.
      // The phone navigation sheet completes its transient Back before invoking the selected link.
      props.onNavigationStart();
      void (async () => {
        if (inCurrentList(href)) {
          // Back and Forward between selections of the shown list open and close them like the list and the reader do.
          const conversationId = url.searchParams.get("conversation");
          const row = data.listItems.find((item) => item.selectionKind === "conversation" && item.conversationId === conversationId);
          const result = conversationId
            ? await openConversationInList(href, conversationId, row?.sourceFolderId ?? data.folderId, row?.subject ?? "")
            : closeConversationInList(href);
          if (!disposed && result === "applied") completeScrollRestore();
          if (!disposed && result === "failed") {
            navigate(requestPath(), { replace: true, scroll: "preserve", viewTransition: false });
            toast.error(t().restoreViewFailed);
          }
          return;
        }
        captureSearchStart(href);
        const result = await replaceWorkspaceRoute(href);
        if (!disposed && result === "applied") {
          const snapshot = searchScrollSnapshot(href);
          const source = routeSource();
          if (snapshot) restoreScroll(snapshot.scroll);
          await restoreSearchScroll(snapshot, source);
          completeScrollRestore();
        }
        if (!disposed && result === "failed") {
          navigate(requestPath(), { replace: true, scroll: "preserve", viewTransition: false });
          toast.error(t().restoreViewFailed);
        }
      })();
    });
    onCleanup(() => {
      subscription.close();
      stopPopState();
    });
  });

  onCleanup(() => {
    disposed = true;
    ++routeGeneration;
    if (preferenceTimer) clearTimeout(preferenceTimer);
    if (Object.keys(pendingPreferences).length > 0) updateMailWorkspacePreferences(pendingPreferences);
    actionQueue.flush();
    conversationDetailRequest?.abort();
    workspaceTransition?.resolve("stale");
    workspaceTransition = null;
    for (const frame of focusFrames) cancelAnimationFrame(frame);
    focusFrames.clear();
    for (const timer of leaveTimers) clearTimeout(timer);
    for (const notice of undoNotices) notice.dismiss();
    setRemovals([]);
    releasesOnNextSnapshot.clear();
    actionUiController.abort();
  });

  const hasSelection = createMemo(() => Boolean(data.selectedConversationId || data.selectedMessageId));
  const listOpen = () => !listCollapsed() || !hasSelection();
  const selectedListItem = createMemo(() =>
    selectableRows().find((item) =>
      item.selectionKind === "message" ? item.id === data.selectedMessageId : item.conversationId === data.selectedConversationId,
    ),
  );
  const selectedUnread = createMemo(
    () => selectedListItem()?.unread ?? data.detailMessages.some((message) => !message.flags.includes("\\Seen")),
  );
  const selectedFlagged = createMemo(
    () => selectedListItem()?.flagged ?? data.detailMessages.some((message) => message.flags.includes("\\Flagged")),
  );
  const selectedInJunk = createMemo(
    () =>
      spamActionForConversation({
        viewFolderId: data.folderId,
        activeFolderIds:
          selectedListItem()?.activeFolderIds ?? data.detailMessages.flatMap((message) => (message.folderId ? [message.folderId] : [])),
        folders: data.folders,
      }) === "not_spam",
  );
  const selectedConversationRevision = createMemo(() => selectedListItem()?.revision ?? data.collaborationState?.revision ?? null);
  const canShowDetails = createMemo(() => Boolean(data.selectedConversationId));

  createEffect(() => {
    if (canWrite() || (!selectionMode() && conversationSelection().ids.size === 0)) return;
    setConversationSelection(emptyMailConversationSelection());
    setSelectionMode(false);
  });

  /** Shows a read or flag change on the rows an action target stands for, until the list confirms it. */
  const setTargetListState = (target: MailBulkTarget, patch: Pick<MailListOptimisticPatch, "unread" | "flagged">) => {
    const messageIds = target.messageIds ? new Set(target.messageIds) : null;
    for (const key of target.messageIds?.map(mailListMessagePendingKey) ?? [target.conversationId]) rememberPendingListState(key, patch);
    setData("listItems", (items) =>
      items.map((item) =>
        item.conversationId === target.conversationId && (!messageIds || (item.selectionKind === "message" && messageIds.has(item.id)))
          ? { ...item, ...patch }
          : item,
      ),
    );
  };

  const setConversationListState = (conversationId: string, patch: MailListOptimisticPatch) => {
    setData("listItems", (items) => items.map((item) => (item.conversationId === conversationId ? { ...item, ...patch } : item)));
  };

  const applyCollaborationState = (next: ConversationCollaboration) => {
    const patch: MailListOptimisticPatch = {
      assigneeUserIds: next.assignees.map((assignee) => assignee.id),
      workStatus: next.workStatus,
      snoozedUntil: next.snoozedUntil,
      revision: next.revision,
    };
    rememberPendingListState(next.conversationId, patch);
    setConversationListState(next.conversationId, patch);
    if (data.selectedConversationId === next.conversationId) {
      setData("collaborationState", next);
      setData("conversationLocalTags", (current) =>
        current?.conversationId === next.conversationId ? { ...current, conversationRevision: next.revision } : current,
      );
    }
  };

  const applyConversationTags = (next: ConversationLocalTags) => {
    const patch: MailListOptimisticPatch = {
      localTags: next.tags,
      revision: next.conversationRevision,
    };
    rememberPendingListState(next.conversationId, patch);
    setConversationListState(next.conversationId, patch);
    if (data.selectedConversationId === next.conversationId) {
      setData("conversationLocalTags", next);
      setData("collaborationState", (current) =>
        current?.conversationId === next.conversationId ? { ...current, revision: next.conversationRevision } : current,
      );
    }
  };

  const focusConversation = (rowKey: string | null, target: "reader" | "row") => {
    if (disposed) return;
    const selector = rowKey?.startsWith("message:")
      ? `[data-message-id="${CSS.escape(rowKey.slice("message:".length))}"] .mail-list-row`
      : `[data-conversation-id="${CSS.escape(rowKey ?? "")}"] .mail-list-row`;
    const element =
      target === "reader"
        ? document.querySelector<HTMLElement>("[data-mail-reader-heading]")
        : document.querySelector<HTMLElement>(rowKey ? selector : "[data-mail-list-heading]");
    element?.focus({ preventScroll: true });
    if (target === "row") element?.scrollIntoView({ block: "nearest" });
  };

  /**
   * Whether `href` keeps the list that is shown and changes only the open conversation: conversation list mode, no
   * Scheduled or Drafts list, no message selection on either side, and no other view on its way.
   */
  const inCurrentList = (href: string): boolean => {
    if (workspaceTransition || data.listMode !== "conversations" || data.scheduledMode || data.draftsMode) return false;
    const target = resolveMailWorkspaceUrl(href, mailboxId, window.location.origin);
    if (!target || target.searchParams.has("message") || mailRouteUrl(requestPath()).searchParams.has("message")) return false;
    const source = encodeRouteSource(`${target.pathname}${target.search}`, data.listMode);
    return sameRouteList(source, committedRouteSource) && sameRouteList(source, routeSource());
  };

  /** Shows `href`'s selection without touching the list: its pages, rows, folders and counts stay as they are. */
  const commitSelectionInList = (href: string, selection: Partial<MailboxPageData>) => {
    const target = resolveMailWorkspaceUrl(href, mailboxId, window.location.origin);
    if (!target) return;
    const path = `${target.pathname}${target.search}`;
    const source = encodeRouteSource(path, data.listMode);
    routeGeneration++;
    batch(() => {
      setData(selection);
      committedRouteSource = source;
      setRouteSource(source);
      setRequestPath(path);
    });
  };

  /**
   * Opens a conversation of the shown list by loading only its detail. `folderId` attributes each message to a
   * folder the way the snapshot does: the row's own folder, else the list's. The latest request wins; a list change
   * cancels it. "missing" means the conversation is gone or no longer visible.
   */
  const loadConversationInList = async (
    href: string,
    conversationId: string,
    folderId: string | null,
    subject: string,
  ): Promise<"applied" | "failed" | "stale" | "missing"> => {
    cancelConversationDetail();
    const request = new AbortController();
    conversationDetailRequest = request;
    const opening = { id: conversationId, changed: false };
    openingConversation = opening;
    setConversationOpening(true);
    let detail: MailConversationDetailData;
    try {
      const response = await apiClient.mailboxes[":mailboxId"]["workspace-detail"][":conversationId"].$get(
        { param: { mailboxId, conversationId }, query: folderId ? { folder: folderId } : {} },
        { init: { signal: request.signal } },
      );
      if (conversationDetailRequest !== request || disposed) return "stale";
      if (!response.ok) {
        finishConversationDetail();
        return response.status === 404 ? "missing" : "failed";
      }
      detail = await response.json();
    } catch {
      if (conversationDetailRequest !== request || disposed) return "stale";
      finishConversationDetail();
      return "failed";
    }
    if (conversationDetailRequest !== request || disposed) return "stale";
    finishConversationDetail();
    if (!inCurrentList(href)) return "stale";
    const { conversationId: _, localTags, selectedSubject, ...incoming } = detail;
    const selection = data.selectedConversationId === conversationId ? preserveUnavailableMailDetail(data, incoming) : incoming;
    const row = data.listItems.find((item) => item.selectionKind === "conversation" && item.conversationId === conversationId);
    // The row is the view's own state of the conversation and decides read, flag and the actions' revision. When the
    // detail shows it is older, page 1 reloads it as a whole, and auto mark-read waits for that row.
    // A folder list states read and flag for its own folder only; other lists leave out their excluded folders.
    const folderList = data.search.expression === null && !data.savedViewId ? data.folderId : null;
    const listedFolderIds = (folderId: string | null) =>
      folderList ? folderId === folderList : folderId === null || !excludedListingFolderIds().has(folderId);
    // A search, also a saved view's, states unread for the folders it is limited to, as the server does.
    const searchExpression = data.search.expression ?? data.savedViews.find((view) => view.id === data.savedViewId)?.filter.expression;
    const searchFolderIds = searchExpression ? guaranteedMailSearchFolderIds(searchExpression) : null;
    // The detail's placement is the row's when the list has one folder, or the row lies in one folder only.
    const rowOlder = mailRowOlderThanDetail(
      row,
      selection,
      listedFolderIds,
      folderList !== null || row?.activeFolderIds.length === 1,
      searchFolderIds ? new Set(searchFolderIds) : null,
    );
    commitSelectionInList(href, {
      ...selection,
      selectedConversationId: conversationId,
      selectedMessageId: null,
      localTags,
      // The snapshot's rule: the latest message's subject, else the list row's.
      selectedSubject: selectedSubject || subject,
    });
    // Page 1 now asks for this conversation, so reloading it brings the change the detail may have missed.
    if (opening.changed || rowOlder) {
      setRowRefreshes((count) => count + 1);
      void workspaceQuery
        .invalidate()
        .catch((error: unknown) => {
          // A navigation that replaced the list cancels this reload; that is not a failure.
          if (error instanceof Error && error.name === "AbortError") return;
          reportRefreshFailure(error instanceof Error ? error : new Error(String(error)), t().refreshMailboxFailed);
        })
        .finally(() => setRowRefreshes((count) => count - 1));
    }
    return "applied";
  };

  const openConversationInList = async (
    href: string,
    conversationId: string,
    folderId: string | null,
    subject: string,
  ): Promise<"applied" | "failed" | "stale"> => {
    const result = await loadConversationInList(href, conversationId, folderId, subject);
    // A fresh load of this URL shows the list without the conversation; reloading the view does the same.
    return result === "missing" ? await replaceWorkspaceRoute(href) : result;
  };

  const closeConversationInList = (href: string): "applied" => {
    cancelConversationDetail();
    commitSelectionInList(href, emptyMailSelection());
    return "applied";
  };

  const applyConversationRoute = async (
    href: string,
    item: MailListItem,
    activation: "keyboard" | "pointer",
  ): Promise<"applied" | "failed" | "stale"> => {
    if (!item.conversationId) return "failed";
    const result = inCurrentList(href)
      ? await openConversationInList(href, item.conversationId, item.sourceFolderId ?? data.folderId, item.subject)
      : await replaceWorkspaceRoute(href);
    if (result === "applied" && activation === "keyboard") focusConversation(item.conversationId, "reader");
    return result;
  };

  const navigateConversation = async (href: string, item: MailListItem, activation: "keyboard" | "pointer") => {
    navigationStart(href);
    const result = item.conversationId ? await applyConversationRoute(href, item, activation) : await replaceWorkspaceRoute(href);
    if (result === "applied") {
      setConversationOpenIntent((intent) => intent + 1);
      navigate(href, { scroll: "preserve", viewTransition: false });
    } else if (result === "failed") toast.error(t().openConversationFailed);
  };

  const requireWorkspaceReconcile = () => requireMailWorkspaceRefresh(() => replaceWorkspaceRoute(requestPath()), t().refreshMailboxFailed);

  const reconcileWorkspaceForActions = async (): Promise<boolean> => {
    let fresh = false;
    const refreshError = await captureMailWorkspaceRefreshError(() =>
      requireMailWorkspaceRefresh(async () => {
        const result = await replaceWorkspaceRoute(requestPath());
        fresh = result === "applied";
        return result;
      }, t().refreshMailboxFailed),
    );
    if (refreshError) toast.error(refreshError.message);
    return fresh;
  };
  const reconcileWorkspace = async (): Promise<void> => {
    await reconcileWorkspaceForActions();
  };

  /**
   * The change was saved, only this view is stale: say so, and let Try again reload what the workspace shows now. It
   * repeats neither the change nor its navigation, so a late click cannot pull the user away from where they are.
   */
  const retryToast = createRetryToasts();
  const reportRefreshFailure = (error: Error, title: string): void => {
    if (disposed) return;
    retryToast(error.message, {
      title,
      retryLabel: t().tryAgain,
      retry: async () => {
        // A navigation in flight loads the workspace anew; reloading the route it leaves would cancel it.
        if (workspaceTransition) return;
        const next = await captureMailWorkspaceRefreshError(requireWorkspaceReconcile);
        if (next) reportRefreshFailure(next, title);
      },
    });
  };

  const applySavedConversationSummary = async (conversationId: string, summary: NonNullable<MailboxPageData["conversationSummary"]>) => {
    if (disposed) return;
    rememberPendingListState(conversationId, { revision: summary.conversationRevision });
    setData("listItems", (items) =>
      items.map((item) =>
        item.conversationId === conversationId ? { ...item, revision: Math.max(item.revision, summary.conversationRevision) } : item,
      ),
    );
    if (data.selectedConversationId === conversationId) {
      setData("conversationSummary", (current) => reconcileConversationSummary(current, summary));
      setData("collaborationState", (current) =>
        current?.conversationId === conversationId
          ? { ...current, revision: Math.max(current.revision, summary.conversationRevision) }
          : current,
      );
      setData("conversationLocalTags", (current) =>
        current?.conversationId === conversationId
          ? { ...current, conversationRevision: Math.max(current.conversationRevision, summary.conversationRevision) }
          : current,
      );
    }
    await requireWorkspaceReconcile();
  };

  const orderedConversationIds = () => selectableRows().flatMap((item) => (item.conversationId ? [item.conversationId] : []));

  const toggleConversationSelection = (item: MailListItem, range: boolean) => {
    if (!canWrite() || !item.conversationId) return;
    setSelectionMode(true);
    setConversationSelection((selection) =>
      toggleMailConversationSelection({
        selection,
        conversationId: item.conversationId!,
        orderedConversationIds: orderedConversationIds(),
        range,
      }),
    );
  };

  const clearConversationSelection = () => {
    const anchor = conversationSelection().anchorId;
    setConversationSelection(emptyMailConversationSelection());
    setSelectionMode(false);
    if (anchor) focusConversation(anchor, "row");
  };

  const toggleConversationSelectionMode = () => {
    if (!canWrite()) return;
    if (selectionMode()) clearConversationSelection();
    else setSelectionMode(true);
  };

  const actionTargetForItem = (item: MailListItem, actionId: MailActionId): MailBulkTarget | null =>
    mailActionTargetForItem({ item, actionId, viewFolderId: data.folderId, folders: data.folders, noSubject: t().noSubject });

  const actionTargets = (actionId: MailActionId): MailBulkTarget[] => {
    const selectedIds = selectedConversationIds();
    if (selectedIds.size > 0)
      return selectableRows().flatMap((item) => {
        if (!item.conversationId || !selectedIds.has(item.conversationId)) return [];
        const target = actionTargetForItem(item, actionId);
        return target ? [target] : [];
      });
    if (!data.selectedConversationId) return [];
    // The open row, which in a message list is one message of its conversation.
    const item = selectedListItem();
    const target = item ? actionTargetForItem(item, actionId) : null;
    if (target) return [target];
    // The open conversation or message is not in the loaded list: act on what the reader shows.
    const messageId = data.listMode === "messages" ? data.selectedMessageId : null;
    const detailMessages = messageId ? data.detailMessages.filter((message) => message.id === messageId) : data.detailMessages;
    const detailFolderIds = ["mark_read", "mark_unread", "flag", "unflag"].includes(actionId)
      ? [
          ...new Set(
            detailMessages
              .filter((message) => actionId !== "mark_read" || !message.flags.includes("\\Seen"))
              .map((message) => message.folderId),
          ),
        ]
      : mailMoveSourceFolderIds({
          actionId,
          viewFolderId: data.folderId,
          activeFolderIds: detailMessages.flatMap((message) => (message.folderId ? [message.folderId] : [])),
          folders: data.folders,
        });
    return [
      {
        conversationId: data.selectedConversationId,
        label: data.selectedSubject || t().noSubject,
        sourceFolderIds: detailFolderIds.filter((folderId): folderId is string => Boolean(folderId)),
        ...(messageId ? { messageIds: [messageId] } : {}),
      },
    ];
  };

  const chooseDestinationFolder = async () => {
    const paths = mailFolderPaths(data.folders);
    const folders = data.folders
      .filter((folder) => folder.selectable && folder.discoveryState === "active")
      .map((folder) => ({ ...folder, path: paths.get(folder.id) ?? folder.name }));
    const selected = await openSpotlightSearch<{ folderId: string }>({
      title: t().moveToFolder,
      icon: "ti ti-folder-symlink",
      placeholder: t().searchFolders,
      noResultsText: t().noFolder,
      resolve: ({ query }) => {
        const needle = query.trim().toLocaleLowerCase();
        return folders
          .filter((folder) => !needle || folder.path.toLocaleLowerCase().includes(needle))
          .map((folder) => ({
            label: folder.path,
            desc: folder.role === "folder" ? t().providerFolder : folder.role,
            icon: "ti ti-folder",
            value: { folderId: folder.id },
          }));
      },
    });
    return selected?.value?.folderId ?? null;
  };

  type ConversationTarget = { conversationId: string; revision: number; subject: string; participantSummary: string };
  const chooseConversationTarget = async (excludedConversationId: string): Promise<ConversationTarget | null> => {
    const loadedTargets = () =>
      selectableRows()
        .filter((item) => item.conversationId && item.conversationId !== excludedConversationId)
        .map((item) => ({
          conversationId: item.conversationId!,
          revision: item.revision,
          subject: item.subject,
          participantSummary: item.participantSummary,
        }));
    const selected = await openSpotlightSearch<ConversationTarget>({
      title: t().chooseConversation,
      icon: "ti ti-messages",
      placeholder: t().searchConversation,
      minQueryLength: 0,
      emptyText: t().chooseRecentConversation,
      noResultsText: t().noOtherConversation,
      resolve: async ({ query, abortSignal }) => {
        const trimmed = query.trim();
        const targets = trimmed
          ? await (async () => {
              const response = await apiClient.mailboxes[":mailboxId"].search.$post(
                {
                  param: { mailboxId },
                  json: {
                    expression: { type: "text", field: "any", query: trimmed, match: "words" },
                    sort: "newest",
                    limit: 40,
                  },
                },
                { init: { signal: abortSignal } },
              );
              if (!response.ok) throw new Error(await readApiError(response, t().searchConversationsFailed));
              const page = await response.json();
              const seen = new Set<string>();
              return page.items.flatMap((item) => {
                const conversationId = item.conversationId;
                if (!conversationId || conversationId === excludedConversationId || seen.has(conversationId)) return [];
                seen.add(conversationId);
                return [{ conversationId, revision: item.revision, subject: item.subject, participantSummary: item.participantSummary }];
              });
            })()
          : loadedTargets().slice(0, 40);
        return targets.map((target) => ({
          value: target,
          label: target.subject || t().noSubject,
          desc: target.participantSummary || t().unknownSender,
          icon: "ti ti-message",
        }));
      },
    });
    return selected?.value ?? null;
  };

  const conversationHref = (conversationId: string): string => {
    const current = new URL(buildMailListHref(mailRouteUrl(requestPath())), window.location.origin);
    current.searchParams.set("conversation", conversationId);
    return `${current.pathname}${current.search}`;
  };

  const mergeConversationMutation = mutation.create<
    { refreshError: Error | null } | undefined,
    { conversationId: string; revision: number; subject: string }
  >({
    mutation: async (source, { abortSignal }) => {
      const generation = routeGeneration;
      const { conversationId: sourceConversationId, revision: sourceRevision } = source;
      const target = await chooseConversationTarget(sourceConversationId);
      if (!target || abortSignal.aborted || disposed) return;
      const confirmed = await prompts.confirm(
        t().mergeQuestion({ source: source.subject || t().thisConversation, target: target.subject || t().selectedConversation }),
        {
          title: t().mergeTitle,
          icon: "ti ti-git-merge",
          confirmText: t().merge,
        },
      );
      if (!confirmed || abortSignal.aborted || disposed) return;
      const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].merge.$post(
        {
          param: { mailboxId, conversationId: target.conversationId },
          json: {
            sourceConversationId,
            expectedTargetRevision: target.revision,
            expectedSourceRevision: sourceRevision,
            reason: "Merged from the Mail workspace",
            confirm: true,
          },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, t().mergeFailed));
      if (abortSignal.aborted || disposed) return;
      // The write succeeded, but its follow-up selection must not override a newer navigation.
      if (generation !== routeGeneration) return { refreshError: null };
      const refreshError = await captureMailWorkspaceRefreshError(() =>
        requireMailWorkspaceRefresh(() => transitionWorkspaceHref(conversationHref(target.conversationId), true), t().mergedOpenFailed),
      );
      if (abortSignal.aborted || disposed) return;
      return { refreshError };
    },
    onSuccess: (result) => {
      if (!result) return;
      toast.success(t().merged);
      if (result.refreshError) reportRefreshFailure(result.refreshError, t().mergedRefreshFailed);
    },
    onError: (error) =>
      prompts.error(error.message, {
        title: t().conversationUnchanged,
      }),
  });
  const mergeConversation = (source: { conversationId: string; revision: number; subject: string }) => {
    if (!canWrite() || structurePending() || disposed) return Promise.resolve();
    return mergeConversationMutation.mutate(source);
  };

  const mergeSelectedConversation = () => {
    const conversationId = data.selectedConversationId;
    const revision = selectedConversationRevision();
    if (!conversationId || !revision) return;
    return mergeConversation({ conversationId, revision, subject: data.selectedSubject });
  };

  const reassignMessageMutation = mutation.create<
    { refreshError: Error | null } | undefined,
    { messageId: string; sourceConversationId: string; sourceRevision: number }
  >({
    mutation: async ({ messageId, sourceConversationId, sourceRevision }, { abortSignal }) => {
      if ((selectedListItem()?.messageCount ?? data.detailMessages.length) <= 1) {
        await prompts.error(t().onlyMessage, {
          title: t().messageCannotMove,
        });
        return;
      }
      const target = await chooseConversationTarget(sourceConversationId);
      if (!target || abortSignal.aborted || disposed) return;
      const confirmed = await prompts.confirm(t().moveMessageQuestion({ target: target.subject || t().selectedConversation }), {
        title: t().moveMessageTitle,
        icon: "ti ti-message-forward",
        confirmText: t().moveMessage,
      });
      if (!confirmed || abortSignal.aborted || disposed) return;
      const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].messages[":messageId"].reassign.$post(
        {
          param: { mailboxId, conversationId: sourceConversationId, messageId },
          json: {
            targetConversationId: target.conversationId,
            expectedSourceRevision: sourceRevision,
            expectedTargetRevision: target.revision,
            reason: "Moved from the Mail workspace",
            confirm: true,
          },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, t().moveMessageFailed));
      if (abortSignal.aborted || disposed) return;
      const refreshError = await captureMailWorkspaceRefreshError(requireWorkspaceReconcile);
      if (abortSignal.aborted || disposed) return;
      return { refreshError };
    },
    onSuccess: (result) => {
      if (!result) return;
      toast.success(t().messageMoved);
      if (result.refreshError) reportRefreshFailure(result.refreshError, t().messageMovedRefreshFailed);
    },
    onError: (error) => prompts.error(error.message, { title: t().messageNotMoved }),
  });
  const reassignMessage = (messageId: string) => {
    const sourceConversationId = data.selectedConversationId;
    const sourceRevision = selectedConversationRevision();
    if (!canWrite() || structurePending() || !sourceConversationId || !sourceRevision) return Promise.resolve();
    return reassignMessageMutation.mutate({ messageId, sourceConversationId, sourceRevision });
  };

  const splitMessageMutation = mutation.create<
    { refreshError: Error | null } | undefined,
    { messageId: string; conversationId: string; revision: number }
  >({
    mutation: async ({ messageId, conversationId, revision }, { abortSignal }) => {
      const generation = routeGeneration;
      const confirmed = await prompts.confirm(t().splitQuestion, {
        title: t().splitTitle,
        icon: "ti ti-arrows-split-2",
        confirmText: t().createConversation,
      });
      if (!confirmed || abortSignal.aborted || disposed) return;
      const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].split.$post(
        {
          param: { mailboxId, conversationId },
          json: {
            messageIds: [messageId],
            expectedRevision: revision,
            reason: "Split from the Mail workspace",
            confirm: true,
          },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, t().splitFailed));
      const result = await response.json();
      if (abortSignal.aborted || disposed) return;
      if (generation !== routeGeneration) return { refreshError: null };
      const refreshError = await captureMailWorkspaceRefreshError(() =>
        requireMailWorkspaceRefresh(() => transitionWorkspaceHref(conversationHref(result.created.id), true), t().splitOpenFailed),
      );
      if (abortSignal.aborted || disposed) return;
      return { refreshError };
    },
    onSuccess: (result) => {
      if (!result) return;
      toast.success(t().splitCreated);
      if (result.refreshError) reportRefreshFailure(result.refreshError, t().splitRefreshFailed);
    },
    onError: (error) => prompts.error(error.message, { title: t().conversationUnchanged }),
  });
  const splitMessage = (messageId: string) => {
    const conversationId = data.selectedConversationId;
    const revision = selectedConversationRevision();
    if (
      !canWrite() ||
      structurePending() ||
      !conversationId ||
      !revision ||
      (selectedListItem()?.messageCount ?? data.detailMessages.length) <= 1
    )
      return Promise.resolve();
    return splitMessageMutation.mutate({ messageId, conversationId, revision });
  };

  // Keeping is conversation state in Cloud, not a provider change: save it, then reload the canonical view.
  const keepMutation = mutation.create<
    { refreshError: Error | null } | undefined,
    { conversationId: string; keep: boolean },
    { keep: boolean }
  >({
    onBefore: ({ keep }) => ({ keep }),
    mutation: async ({ conversationId, keep }, { abortSignal }) => {
      if (!keep) {
        const confirmed = await prompts.confirm(conversationText().stopKeepingConsequence, {
          title: conversationText().stopKeepingTitle,
          icon: "ti ti-lock-open",
          confirmText: conversationText().stopKeeping,
          variant: "danger",
        });
        if (!confirmed || abortSignal.aborted || disposed) return;
      }
      const route = apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].keep;
      const request = { param: { mailboxId, conversationId } };
      const response = keep
        ? await route.$put(request, { init: { signal: abortSignal } })
        : await route.$delete(request, { init: { signal: abortSignal } });
      if (!response.ok) {
        throw new Error(await readApiError(response, keep ? conversationText().keepFailed : conversationText().stopKeepingFailed));
      }
      if (abortSignal.aborted || disposed) return;
      const refreshError = await captureMailWorkspaceRefreshError(requireWorkspaceReconcile);
      return { refreshError };
    },
    onSuccess: (result, context) => {
      if (!result) return;
      toast.success(context?.keep === false ? conversationText().stopKeepingDone : conversationText().keepSaved);
      if (result.refreshError) reportRefreshFailure(result.refreshError, t().refreshMailboxFailed);
    },
    onError: (error, context) =>
      prompts.error(error.message, {
        title: context?.keep === false ? conversationText().stopKeepingFailed : conversationText().keepFailed,
      }),
  });
  const setConversationKept = (keep: boolean) => {
    const conversationId = data.selectedConversationId;
    if (!conversationId || disposed || structurePending() || (keep ? !canWrite() : !canAdmin())) return Promise.resolve();
    return keepMutation.mutate({ conversationId, keep });
  };

  // A queued action runs later. Follow its commands so a change the mail server did not make still
  // reaches the user who was told it was queued.
  const actionOutcomes = createMailActionOutcomes();
  // The longest wait between two outcome requests, and the longest one request may take, so a stalled
  // response cannot keep following past its lifetime.
  const outcomePollMaxMs = 30_000;
  let outcomePollTimer: ReturnType<typeof setTimeout> | null = null;
  let outcomePollAttempt = 0;
  const failureReason = (code: string): string => {
    switch (code) {
      case "REMOTE_MESSAGE_MISSING":
      case "REMOTE_MESSAGE_STALE":
      case "UIDVALIDITY_CHANGED":
        return t().failureMessageGone;
      case "REMOTE_STATE_CHANGED":
        return t().failureMessageChanged;
      case "PROVIDER_RIGHTS_CHANGED":
      case "ACCESS_REVOKED":
        return t().failureNotAllowed;
      case "DESTINATION_UNAVAILABLE":
      case "FOLDER_UNAVAILABLE":
        return t().failureFolderUnavailable;
      case "CONVERSATION_KEPT":
      case "FOLDER_HAS_KEPT_CONVERSATIONS":
        return t().failureKept;
      case "KEPT_COPY_ONLY":
        return t().failureKeptCopyOnly;
      case "cancelled":
        return t().failureCancelled;
      case "needs_attention":
        return t().failureUnclear;
      default:
        return t().failureNotApplied;
    }
  };
  const showActionFailures = (report: MailActionFailureReport) => {
    const [first] = report.failures;
    if (!first || disposed) return;
    // An unclear outcome must be checked, not repeated. The others repeat only in the folders where
    // they failed, whatever view is open by now.
    const retryTargets = report.failures.flatMap(({ code, ...target }) =>
      code === "needs_attention" || target.sourceFolderIds.length === 0 ? [] : [target],
    );
    const more = report.failures.length - 1;
    toast.error(`${first.label}: ${failureReason(first.code)}${more > 0 ? ` (${t().moreNotApplied({ count: more })})` : ""}`, {
      title:
        report.conversationCount === 1
          ? t().changeNotApplied
          : t().changesNotApplied({ failed: report.failures.length, total: report.conversationCount }),
      action:
        retryTargets.length > 0
          ? {
              label: t().tryAgain,
              onClick: () =>
                void runAction(report.actionId, { targets: retryTargets, destinationFolderId: report.destinationFolderId ?? undefined }),
            }
          : null,
    });
  };
  const pollActionOutcomes = async () => {
    outcomePollTimer = null;
    const commandIds = actionOutcomes.pendingCommandIds();
    let outcomes: MailActionCommand[] | null = null;
    if (commandIds.length > 0) {
      try {
        const response = await apiClient.mailboxes[":mailboxId"].commands.outcomes.$post(
          { param: { mailboxId }, json: { commandIds } },
          { init: { signal: AbortSignal.timeout(outcomePollMaxMs) } },
        );
        if (response.ok) outcomes = await response.json();
      } catch {
        // The next poll asks again.
      }
    }
    // Applied after a failed request too, so following still ends after its lifetime.
    for (const report of actionOutcomes.apply(outcomes ? commandIds : [], outcomes ?? [])) showActionFailures(report);
    if (!disposed && actionOutcomes.hasPending()) scheduleActionOutcomePoll();
  };
  // Commands usually finish within seconds; one that waits for the mailbox is asked about less often.
  const scheduleActionOutcomePoll = (restart = false) => {
    if (restart) outcomePollAttempt = 0;
    if (outcomePollTimer && !restart) return;
    if (outcomePollTimer) clearTimeout(outcomePollTimer);
    outcomePollTimer = setTimeout(() => void pollActionOutcomes(), Math.min(1_000 * 2 ** outcomePollAttempt, outcomePollMaxMs));
    outcomePollAttempt += 1;
  };
  onCleanup(() => {
    if (outcomePollTimer) clearTimeout(outcomePollTimer);
  });

  const actionUiController = new AbortController();
  // A reload that a newer one replaces resolves before its snapshot arrives, and a row released on it would show again.
  // Actions that settle together share one reload, and those that settle during it share the next.
  let actionReconcile: Promise<boolean> | null = null;
  let nextActionReconcile: Promise<boolean> | null = null;
  let actionReconcileStarted = false;
  const reconcileAfterAction = (): Promise<boolean> => {
    if (disposed) return Promise.resolve(false);
    if (!actionReconcile) {
      actionReconcile = Promise.resolve()
        .then(() => {
          actionReconcileStarted = true;
          return reconcileWorkspaceForActions();
        })
        .finally(() => {
          actionReconcile = null;
          actionReconcileStarted = false;
        });
      return actionReconcile;
    }
    if (!actionReconcileStarted) return actionReconcile;
    nextActionReconcile ??= actionReconcile.then(() => {
      nextActionReconcile = null;
      return reconcileAfterAction();
    });
    return nextActionReconcile;
  };
  const createActionHost = (invocationActionId: MailActionId): MailWorkspaceActionRunnerHost => {
    const owner = Symbol("mail-action");
    const savedRemovals = new Map<string, MailListRemoval>();
    const owns = (removal: MailListRemoval, target: MailBulkTarget) =>
      removalOwners.get(removal) === owner &&
      removal.conversationId === target.conversationId &&
      (!target.messageIds || target.messageIds.includes(removal.item.id));
    const release = (target: MailBulkTarget) => {
      if (disposed) return;
      setRemovals((current) => current.filter((removal) => !owns(removal, target)));
      for (const key of target.messageIds?.map(mailListMessagePendingKey) ?? [target.conversationId]) {
        const owners = pendingActionOwners.get(key);
        if (!owners) continue;
        for (const field of mailOptimisticFields(invocationActionId)) if (owners[field] === owner) delete owners[field];
        if (Object.keys(owners).length === 0) pendingActionOwners.delete(key);
      }
    };
    return {
      queue: actionQueue,
      releaseOnNextSnapshot: (target, wanted) => {
        if (disposed) return;
        releasesOnNextSnapshot.add(() => {
          if (wanted()) release(target);
        });
      },
      resolveTargets: actionTargets,
      chooseDestinationFolder,
      roleDestinationFolderId: (nextActionId) => mailRoleDestinationFolderId(nextActionId, data.folders),
      applyOptimistic: (nextActionId, targets, destinationFolderId) => {
        if (disposed) return;
        let projectedFocus: string | null | undefined;
        batch(() => {
          for (const target of targets) {
            for (const key of target.messageIds?.map(mailListMessagePendingKey) ?? [target.conversationId]) {
              const owners = pendingActionOwners.get(key) ?? {};
              for (const field of mailOptimisticFields(nextActionId)) owners[field] = owner;
              if (Object.keys(owners).length > 0) pendingActionOwners.set(key, owners);
            }
          }
          if (nextActionId === "mark_read" || nextActionId === "mark_unread") {
            for (const target of targets) setTargetListState(target, { unread: nextActionId === "mark_unread" });
            return;
          }
          if (nextActionId === "flag" || nextActionId === "unflag") {
            for (const target of targets) setTargetListState(target, { flagged: nextActionId === "flag" });
            return;
          }
          const rows = selectableRows();
          const scope = mailListScope(requestPath());
          const added = rows.flatMap((item, index): MailListRemoval[] => {
            const target = targets.find(
              (target) => target.conversationId === item.conversationId && (!target.messageIds || target.messageIds.includes(item.id)),
            );
            if (
              !target ||
              !mailRowLeavesListing({
                item,
                sourceFolderIds: target.sourceFolderIds,
                destinationFolderId,
                folders: data.folders,
                viewFolderId: data.folderId,
                activeView: data.activeView,
                hasSearch: !!data.query || data.search.expression !== null,
                hasSavedView: !!data.savedViewId,
                scheduledMode: data.scheduledMode,
              })
            )
              return [];
            const removal: MailListRemoval = {
              rowKey: mailListRowKey(item),
              conversationId: target.conversationId,
              scope,
              item: structuredClone(unwrap(item)),
              before: rows.slice(0, index).map(mailListRowKey),
              sourceFolderIds: target.sourceFolderIds,
              destinationFolderId,
              phase: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "hidden" : "leaving",
            };
            removalOwners.set(removal, owner);
            return [removal];
          });
          for (const removal of added) savedRemovals.set(`${removal.scope}:${removal.rowKey}`, removal);
          const keys = new Set(added.map((removal) => removal.rowKey));
          const focused = rows.find((item) => {
            const selector =
              item.selectionKind === "message"
                ? `[data-message-id="${CSS.escape(item.id)}"]`
                : `[data-conversation-id="${CSS.escape(item.conversationId ?? "")}"]`;
            return document.querySelector(selector)?.contains(document.activeElement);
          });
          const open = rows.find((item) =>
            item.selectionKind === "message" ? item.id === data.selectedMessageId : item.conversationId === data.selectedConversationId,
          );
          const focusKey =
            focused && keys.has(mailListRowKey(focused))
              ? mailListRowKey(focused)
              : open && keys.has(mailListRowKey(open))
                ? mailListRowKey(open)
                : null;
          const nextFocus = focusKey
            ? findMailFocusAfterRemoval({ orderedRowKeys: rows.map(mailListRowKey), activeRowKey: focusKey, removedRowKeys: keys })
            : null;
          if (focusKey) projectedFocus = nextFocus;
          setRemovals((current) => [...current, ...added]);
          setConversationSelection((current) =>
            pruneMailConversationSelection(
              current,
              new Set(
                rows
                  .filter((item) => !keys.has(mailListRowKey(item)))
                  .flatMap((item) => (item.conversationId ? [item.conversationId] : [])),
              ),
            ),
          );
          if (conversationSelection().ids.size === 0) setSelectionMode(false);
          if (open && keys.has(mailListRowKey(open))) {
            setData({ selectedConversationId: null, selectedMessageId: null });
            void transitionWorkspaceHref(buildMailListHref(mailRouteUrl(requestPath())), true);
          }
          if (added.some((removal) => removal.phase === "leaving")) {
            const timer = setTimeout(() => {
              leaveTimers.delete(timer);
              if (disposed) return;
              setRemovals((current) =>
                current.map((removal) => {
                  if (removalOwners.get(removal) !== owner || removal.phase !== "leaving") return removal;
                  const next = { ...removal, phase: "hidden" as const };
                  removalOwners.set(next, owner);
                  return next;
                }),
              );
            }, MAIL_ROW_LEAVE_MS);
            leaveTimers.add(timer);
          }
        });
        if (projectedFocus !== undefined) focusConversation(projectedFocus, "row");
      },
      restore: (target) => {
        if (disposed) return;
        batch(() => {
          const fields = mailOptimisticFields(invocationActionId);
          const restoredFields = new Map<string, MailListOptimisticField[]>();
          for (const key of target.messageIds?.map(mailListMessagePendingKey) ?? [target.conversationId]) {
            const owners = pendingActionOwners.get(key);
            const ownedFields = fields.filter((field) => owners?.[field] === owner);
            restoredFields.set(key, ownedFields);
            clearPendingListState(key, ownedFields);
            for (const field of ownedFields) if (owners) delete owners[field];
            if (owners && Object.keys(owners).length === 0) pendingActionOwners.delete(key);
          }
          release(target);
          const original = new Map(snapshotItems().map((item) => [mailListRowKey(item), item]));
          setData("listItems", (items) =>
            items.map((item) => {
              if (item.conversationId !== target.conversationId || (target.messageIds && !target.messageIds.includes(item.id))) return item;
              const row = original.get(mailListRowKey(item));
              const ownedFields =
                restoredFields.get(item.selectionKind === "message" && target.messageIds ? mailListRowKey(item) : target.conversationId) ??
                [];
              return !row
                ? item
                : {
                    ...item,
                    ...(ownedFields.includes("unread") ? { unread: row.unread } : {}),
                    ...(ownedFields.includes("flagged") ? { flagged: row.flagged } : {}),
                  };
            }),
          );
        });
      },
      hold: (target) => {
        if (disposed) return;
        setRemovals((current) => [
          ...current.filter((removal) => !owns(removal, target)),
          ...[...savedRemovals.values()]
            .filter(
              (removal) =>
                removal.conversationId === target.conversationId && (!target.messageIds || target.messageIds.includes(removal.item.id)),
            )
            .map((removal) => {
              const next = { ...removal, phase: "held" as const };
              removalOwners.set(next, owner);
              return next;
            }),
        ]);
      },
      release,
      offerUndo: ({ actionId, targets, destinationFolderId, undo }) => {
        if (disposed) return;
        const messageRows = targets.every((target) => target.messageIds);
        const count = messageRows ? targets.reduce((count, target) => count + (target.messageIds?.length ?? 0), 0) : targets.length;
        const folder = data.folders.find((folder) => folder.id === destinationFolderId)?.name ?? "";
        const notice = toast.success(t().actionMoved({ actionId, count, messages: messageRows, folder }), {
          action: {
            label: t().undo,
            onClick: () => {
              notice.dismiss();
              undoNotices.delete(notice);
              void undo();
            },
          },
        });
        undoNotices.add(notice);
        // The toast rail shows at most three notices; an older one is already gone and needs no dismissal on cleanup.
        for (const older of undoNotices) {
          if (undoNotices.size <= 3) break;
          undoNotices.delete(older);
        }
      },
      announce: (actionId, targets) => {
        if (disposed) return;
        const count = targets.reduce((count, target) => count + (target.messageIds?.length ?? 1), 0);
        announce(
          actionId === "undo"
            ? t().undone
            : t().actionAnnouncement({ actionId, count, messages: targets.every((target) => target.messageIds) }),
        );
      },
      submit: async ({ actionId: nextActionId, target, sourceFolderId, destinationFolderId, correlationId, idempotencyKey }) => {
        const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].actions.$post(
          {
            param: { mailboxId, conversationId: target.conversationId },
            json: buildMailActionInput({
              actionId: nextActionId,
              sourceFolderId,
              messageIds: target.messageIds,
              destinationFolderId,
              correlationId,
              idempotencyKey,
            }),
          },
          { init: { keepalive: true } },
        );
        if (!response.ok) throw new Error(await readApiError(response, t().actionFailed));
        return (await response.json()).commands;
      },
      submitUndo: async ({ target, commandIds }) => {
        const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].actions.undo.$post(
          {
            param: { mailboxId, conversationId: target.conversationId },
            json: { commandIds },
          },
          { init: { keepalive: true } },
        );
        if (!response.ok) throw new Error(await readApiError(response, t().undoFailed));
        return (await response.json()).commands;
      },
      followOutcomes: ({ target, commands, ...params }) => {
        if (disposed) return () => {};
        const key = Symbol("followed-action");
        const report = actionOutcomes.follow({ ...params, key, conversations: [{ ...target, commands }] });
        if (report) showActionFailures(report);
        if (actionOutcomes.hasPending()) scheduleActionOutcomePoll(true);
        return () => actionOutcomes.stop(key, target.conversationId);
      },
      reconcile: reconcileAfterAction,
      showMissingTarget: async () => {
        if (!disposed) await prompts.error(t().chooseFolderFirstBody, { title: t().chooseFolderFirst });
      },
      showNothingToMove: () => {
        if (!disposed) toast(t().nothingToMoveBody, { title: t().nothingToMove });
      },
      showFailures: (failures, { targetCount, retry }) => {
        const failureMessage = (message: string) =>
          message === MAIL_BULK_NO_PROVIDER_PLACEMENT
            ? t().noProviderPlacement
            : message === MAIL_BULK_QUEUE_FAILED
              ? t().actionCouldNotBeQueued
              : message === MAIL_ACTION_MISSING_DESTINATION
                ? t().chooseDestinationBeforeMoving
                : message;
        retryToast(
          failures
            .slice(0, 5)
            .map(
              (failure) =>
                `${failure.label}: ${failureMessage(failure.message)}${failure.submittedPlacements > 0 ? ` (${t().somePlacementsQueued})` : ""}`,
            )
            .join("\n"),
          {
            title: t().conversationsFailed({ failed: failures.length, total: targetCount }),
            retryLabel: t().tryAgain,
            retry: () => (!disposed && canWrite() && !structureMutationLoading() ? retry() : undefined),
          },
        );
      },
      showUndoFailed: (targets, destinationFolderId) => {
        if (disposed) return;
        const folder = data.folders.find((folder) => folder.id === destinationFolderId)?.name ?? null;
        const first = targets[0];
        if (!first) return;
        toast.error(
          `${t().undoNotMoved({ label: first.label, folder })}${targets.length > 1 ? ` (${t().moreNotApplied({ count: targets.length - 1 })})` : ""}`,
          { title: t().undoFailed },
        );
      },
      showError: (error) => {
        if (!disposed) toast.error(error instanceof Error ? error.message : t().updateConversationsFailed);
      },
    };
  };
  const runAction = (actionId: MailActionId, options: MailWorkspaceActionOptions = {}) => {
    if (!canWrite() || structureMutationLoading() || disposed) return Promise.resolve();
    return runMailWorkspaceAction(actionId, options, createActionHost(actionId), actionUiController.signal);
  };

  const addTagsMutation = mutation.create<void, string[]>({
    mutation: async (conversationIds, { abortSignal }) => {
      const tagIds = await chooseBulkTags(data.localTags);
      if (!tagIds?.length || abortSignal.aborted || disposed) return;
      const response = await apiClient.mailboxes[":mailboxId"].conversations["local-tags"].$post(
        {
          param: { mailboxId },
          json: { conversationIds, tagIds },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, t().addTagsFailed));
      const result = await response.json();
      if (abortSignal.aborted || disposed) return;
      const addedTags = data.localTags.filter((tag) => tagIds.includes(tag.id));
      for (const conversationId of conversationIds) {
        const item = data.listItems.find((candidate) => candidate.conversationId === conversationId);
        if (!item) continue;
        const nextTags = [...item.localTags];
        const existingIds = new Set(nextTags.map((tag) => tag.id));
        for (const tag of addedTags) {
          if (!existingIds.has(tag.id)) nextTags.push(tag);
        }
        const patch: MailListOptimisticPatch = { localTags: nextTags };
        rememberPendingListState(conversationId, patch);
        setConversationListState(conversationId, patch);
      }
      setConversationSelection(emptyMailConversationSelection());
      setSelectionMode(false);
      const refreshError = await captureMailWorkspaceRefreshError(requireWorkspaceReconcile);
      if (abortSignal.aborted || disposed) return;
      toast.success(
        result.updatedConversationIds.length === 0
          ? t().tagsAlreadyPresent
          : t().tagsAdded({ count: result.updatedConversationIds.length }),
      );
      if (refreshError) reportRefreshFailure(refreshError, t().tagsRefreshFailed);
    },
    onError: (error) => toast.error(error.message),
  });
  const addTagsToSelection = () => {
    const conversationIds = [...selectedConversationIds()];
    if (!canWrite() || structurePending() || conversationIds.length === 0) return Promise.resolve();
    return addTagsMutation.mutate(conversationIds);
  };

  const manageConversationTagsMutation = mutation.create<void, MailListItem>({
    mutation: async (item, { abortSignal }) => {
      if (!item.conversationId) return;
      const tagIds = await chooseConversationTags(data.localTags, item.localTags);
      if (tagIds === undefined || tagIds === null || abortSignal.aborted || disposed) return;
      const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"]["local-tags"].$put(
        {
          param: { mailboxId, conversationId: item.conversationId },
          json: { expectedRevision: item.revision, tagIds },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, t().updateTagsFailed));
      const next = await response.json();
      if (abortSignal.aborted || disposed) return;
      // The row and the details show the new tags; focus is back on the row, which does not say so.
      applyConversationTags(next);
      announce(t().tagsUpdated);
    },
    onError: (error) => {
      void reconcileWorkspace()
        .catch(() => undefined)
        .then(() => {
          if (!disposed) return prompts.error(error.message, { title: t().conversationChanged });
        });
    },
  });
  const manageConversationTags = (item: MailListItem) => {
    if (!canWrite() || structurePending() || !item.conversationId) return Promise.resolve();
    return manageConversationTagsMutation.mutate(item);
  };

  const assignSelectionMutation = mutation.create<void, string[]>({
    mutation: (conversationIds, { abortSignal }) =>
      runMailBulkAssignment(
        conversationIds,
        {
          chooseAssignee: () => chooseMailAssignee({ mailboxId, currentUserId: props.currentUserId }),
          assign: async (ids, assigneeUserIds, mode) => {
            const response = await apiClient.mailboxes[":mailboxId"].conversations.assign.$post({
              param: { mailboxId },
              json: { conversationIds: ids, assigneeUserIds, mode },
            });
            if (!response.ok) throw new Error(await readApiError(response, t().assignFailed));
            return response.json();
          },
          assigneesOf: (conversationId) => data.listItems.find((item) => item.conversationId === conversationId)?.assigneeUserIds ?? null,
          clearSelection: () => {
            setConversationSelection(emptyMailConversationSelection());
            setSelectionMode(false);
          },
          refresh: () => captureMailWorkspaceRefreshError(requireWorkspaceReconcile),
          success: (message, undo) =>
            toast.success(message, undo ? { duration: 8_000, action: { label: undo.label, onClick: undo.run } } : undefined),
          error: (message, title) => void toast.error(message, title ? { title } : undefined),
          refreshFailed: (error, title) => reportRefreshFailure(error, title),
          active: () => !abortSignal.aborted && !disposed,
        },
        t(),
      ),
    onError: (error) => toast.error(error.message),
  });
  const assignSelection = () => {
    const conversationIds = [...selectedConversationIds()];
    if (!canWrite() || structurePending() || conversationIds.length === 0) return Promise.resolve();
    return assignSelectionMutation.mutate(conversationIds);
  };

  structureMutationLoading = () =>
    assignSelectionMutation.loading() ||
    mergeConversationMutation.loading() ||
    reassignMessageMutation.loading() ||
    splitMessageMutation.loading() ||
    keepMutation.loading() ||
    addTagsMutation.loading() ||
    manageConversationTagsMutation.loading();
  onCleanup(() => {
    mergeConversationMutation.abort();
    reassignMessageMutation.abort();
    splitMessageMutation.abort();
    addTagsMutation.abort();
    manageConversationTagsMutation.abort();
    assignSelectionMutation.abort();
  });

  let consumedOpenIntent = -1;
  createEffect(() => {
    const intent = conversationOpenIntent();
    const pending = structureMutationLoading() || rowRefreshes() > 0;
    const item = selectedListItem();
    const conversationId = item?.conversationId ?? data.selectedConversationId;
    const target = conversationId ? (item ? actionTargetForItem(item, "mark_read") : actionTargets("mark_read")[0]) : undefined;
    const decision = decideMailAutoReadIntent({
      intent,
      consumedIntent: consumedOpenIntent,
      busy: pending,
      unread: selectedUnread(),
      canSubmit: Boolean(target?.sourceFolderIds.length),
    });
    if (decision === "ignore" || decision === "wait") return;
    consumedOpenIntent = intent;
    if (decision === "consume" || !target) return;
    void runAction("mark_read", { silent: true, targets: [target] });
  });

  const setDetailsVisible = (open: boolean, moveFocus = true) => {
    setDetailsOpen(open);
    persistPreferences({ detailsOpen: open });
    // The shared head control owns its pointer/keyboard focus behavior.
    if (!moveFocus) return;
    const frame = requestAnimationFrame(() => {
      focusFrames.delete(frame);
      if (disposed) return;
      const target = open
        ? document.querySelector<HTMLElement>("[data-mail-details-heading]")
        : [
            document.querySelector<HTMLElement>(".mail-workspace [data-app-workspace-detail-toggle]"),
            document.querySelector<HTMLElement>(".mail-workspace [data-mail-details-trigger]"),
          ].find((element) => element && element.getClientRects().length > 0);
      target?.focus({ preventScroll: true });
    });
    focusFrames.add(frame);
  };

  const sidebarText = createMemo(() => mailSidebarMessages.resolve([locale()]).t);
  const mailboxMenu = createMailboxMenu(() => ({
    mailboxId: data.mailbox.id,
    syncEnabled: data.mailbox.syncEnabled,
    needsConnection: mailboxNeedsConnection(data.mailbox.health),
    canWrite: canWrite(),
    canAdmin: canAdmin(),
    assignedOnly: assignedOnly(),
    managementOpening: managementOpening(),
    settingsOpening: settingsOpening(),
    detailsOpening: detailsOpening(),
    onOpenDetails: () => void openDetails(),
    onOpenHealth: () => void openHealth(),
    onOpenSharedLinks: () => void openSharedLinks(),
    onOpenRemoteContent: () => void openRemoteContent(),
    onOpenSubscriptions: () => void openSubscriptions(),
    onOpenSettings: () => void openSettings(),
  }));
  // Folder, view, and saved view exclude each other: a folder shows no tabs, only its chips.
  const currentTab = createMemo(() =>
    mailboxCurrentTab({
      scheduledMode: data.scheduledMode,
      draftsMode: data.draftsMode,
      folderId: data.folderId,
      activeView: data.query ? null : data.activeView,
      savedViewId: data.savedViewId,
    }),
  );
  // The sidebar reports when the person collapsed what holds the open place's row; the heading then names it again.
  const [openPlaceRowHidden, setOpenPlaceRowHidden] = createSignal(false);
  const listNamedBy = createMemo(() => {
    if (currentTab() !== null) return "tabs";
    if (openPlaceRowHidden()) return null;
    if (
      data.scheduledMode ||
      data.draftsMode ||
      data.activeView === "send_problems" ||
      flattenMailFolderTree(buildVisibleMailFolderTree(data.folders)).some(({ folder }) => folder.id === data.folderId)
    )
      return "sidebar";
    return null;
  });
  const viewTabs = createMemo(() =>
    mailboxViewTabs({
      mailboxId: data.mailbox.id,
      viewCounts: listCounts().viewCounts,
      savedViews: data.savedViews,
      assignedOnly: assignedOnly(),
      labels: {
        all: sidebarText().allConversations,
        needs_action: sidebarText().needsAction,
        mine: sidebarText().assignedToMe,
        waiting: sidebarText().waitingForReply,
        unassigned: sidebarText().unassigned,
        snoozed: sidebarText().snoozed,
        done: sidebarText().done,
        recently_active: sidebarText().recentActivity,
        kept: sidebarText().kept,
      },
      formatCount: (count) => count.toLocaleString(locale()),
    }),
  );
  /** A search narrows the list: the head offers Reset back to where the search started. */
  const searchFiltered = () => Boolean(data.query.trim() || activeSearch().expression);

  props.onReady({
    open: () => ({
      mailboxId: data.mailbox.id,
      mailboxName: data.mailbox.name,
      canWrite: canWrite(),
      assignedOnly: assignedOnly(),
      mailbox: { health: data.mailbox.health, healthReason: data.mailbox.healthReason, receivingAddress: data.receivingAddress },
      folders: listCounts().folders,
      scheduledMode: data.scheduledMode,
      scheduledCount: data.scheduledCount,
      activeFolderId: data.folderId,
      activeView: data.query ? null : data.activeView,
      viewCounts: listCounts().viewCounts,
      menu: mailboxMenu,
      onCompose: (options) => void startCompose(options),
      onMoveConversation: (input) => {
        // The dragged row, not the first row of its conversation: in a message list, rows of one
        // conversation can sit in different folders.
        const item = selectableRows().find((candidate) => candidate.id === input.itemId);
        const target = item ? actionTargetForItem(item, "move") : null;
        return runAction("move", { targets: target ? [target] : [], destinationFolderId: input.destinationFolderId });
      },
      onNavigate: navigateWorkspace,
    }),
    onOpenPlaceRowHiddenChange: setOpenPlaceRowHidden,
    preferences: () => ({
      ...props.initialPreferences,
      listCollapsed: listCollapsed(),
      detailsOpen: detailsOpen(),
      toolbarActions: toolbarActions(),
      listMode: data.listMode,
    }),
    handle: {
      listMode: () => data.listMode,
      navigateHere: navigateWorkspace,
      supersede: () => {
        searchControls?.cancelPending();
        ++routeGeneration;
        cancelConversationDetail();
        workspaceTransition?.resolve("stale");
        workspaceTransition = null;
        if (routeSource() !== committedRouteSource) setRouteSource(committedRouteSource);
      },
    },
  });
  createEffect(() => {
    onCleanup(publishPageContext({ scope: { type: "mail.mailbox", id: mailboxId } }));
  });

  return (
    <>
      <AppWorkspace.Head
        mobilePane="conversations"
        views={
          currentTab() !== null ? (
            <MailboxViewTabs
              items={viewTabs()}
              current={currentTab()!}
              onOpenHref={(href) => {
                searchControls?.cancelPending();
                void openWorkspaceHref(href);
              }}
            />
          ) : undefined
        }
        filters={
          data.scheduledMode || data.draftsMode ? undefined : (
            <MailboxHeadFilters
              requestUrl={requestPath()}
              search={data.search}
              folders={data.folders}
              localTags={data.localTags}
              onOpenHref={(href) => {
                searchControls?.cancelPending();
                void openWorkspaceHref(href);
              }}
            />
          )
        }
        filtered={searchFiltered()}
        resetHref={searchFiltered() ? buildMailSearchClearHref(mailRouteUrl(requestPath())) : undefined}
        onReset={() => {
          searchControls?.cancelPending();
          void openWorkspaceHref(buildMailSearchClearHref(mailRouteUrl(requestPath())));
        }}
        actions={
          <>
            <Show when={!data.scheduledMode && !data.draftsMode}>
              <MailListModeMenu listMode={data.listMode} onListModeChange={updateListMode} />
            </Show>
            <MailboxMenuButton menu={mailboxMenu} label={sidebarText().mailboxMenu({ name: data.mailbox.name })} />
          </>
        }
        primary={
          canWrite() && !assignedOnly()
            ? {
                label: sidebarText().compose,
                icon: composeStarting() ? "ti ti-loader-2 animate-spin" : "ti ti-pencil",
                // Modified and middle clicks, a new tab, and a page before hydration open the compose page.
                href: `/app/mail/compose?mailbox=${data.mailbox.id}&autostart=1`,
                onClick: (event) => {
                  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
                    return;
                  event.preventDefault();
                  const href = `/app/mail/compose?mailbox=${data.mailbox.id}&autostart=1`;
                  // The spinner replaces the icon; screen readers hear the same progress.
                  if (!composeStarting()) announce(t().preparingMessage);
                  void startCompose({ fallback: () => documentNavigate(href), progressToast: false });
                },
              }
            : undefined
        }
      />
      <AppWorkspace.Content>
        <AppWorkspace.Main
          class="p-0"
          aria-busy={routeLoading()}
          mobilePane={hasSelection() ? "main" : "conversations"}
          scroll={false}
          minWidth={data.scheduledMode || data.draftsMode ? undefined : listOpen() ? MAIL_MAIN_WITH_LIST : MAIL_READER_BESIDE_DETAIL}
        >
          <Show
            when={data.scheduledMode || data.draftsMode}
            fallback={
              <>
                <AppWorkspace.MainPane
                  id="conversations"
                  label={t().conversationList}
                  scroll={false}
                  open={listOpen()}
                  defaultSize={MAIL_LIST_WIDTH}
                  minSize={300}
                  maxSize={620}
                >
                  <MailConversationList
                    mailbox={data.mailbox}
                    mailboxId={data.mailbox.id}
                    requestUrl={requestPath()}
                    query={data.query}
                    search={data.search}
                    title={data.listTitle}
                    namedBy={listNamedBy()}
                    items={listView().items}
                    leavingKeys={listView().leavingKeys}
                    error={data.listError}
                    selectedConversationId={data.selectedConversationId}
                    selectedMessageId={data.selectedMessageId}
                    selectedConversationIds={selectedConversationIds()}
                    selectionMode={selectionMode()}
                    nextCursor={data.nextListCursor}
                    dateConfig={props.dateConfig}
                    canWrite={canWrite()}
                    canAdmin={canAdmin()}
                    viewFolderId={data.folderId}
                    folders={data.folders}
                    localTags={data.localTags}
                    savedViews={data.savedViews}
                    activeSavedViewId={data.savedViewId}
                    folderOnlyHint={folderOnlyHint()}
                    listMode={data.listMode}
                    loading={routeLoading()}
                    liveDegraded={liveUnavailable()}
                    onCollapse={() => setCollapsed(true)}
                    onOpenHealth={() => void openHealth()}
                    onOpenDeliverySettings={() => void openSettings("delivery")}
                    onNavigate={navigateWorkspace}
                    onNavigateItem={navigateConversation}
                    onToggleSelectionMode={toggleConversationSelectionMode}
                    onToggleSelection={toggleConversationSelection}
                    onClearSelection={clearConversationSelection}
                    onAddTags={assignedOnly() ? undefined : addTagsToSelection}
                    onAssign={canAssign() ? assignSelection : undefined}
                    onBulkAction={runAction}
                    onItemAction={(item, actionId) => {
                      const target = actionTargetForItem(item, actionId);
                      if (target) void runAction(actionId, { targets: [target] });
                    }}
                    onManageTags={manageConversationTags}
                    onMergeItem={
                      assignedOnly()
                        ? undefined
                        : (item) => {
                            if (item.conversationId)
                              void mergeConversation({
                                conversationId: item.conversationId,
                                revision: item.revision,
                                subject: item.subject,
                              });
                          }
                    }
                    onOpenHref={openWorkspaceHref}
                    onNavigationStart={props.onNavigationStart}
                    onSearchControls={(controls) => {
                      searchControls = controls;
                    }}
                    onLoadMore={loadMoreConversations}
                    onRefresh={reconcileWorkspace}
                  />
                </AppWorkspace.MainPane>
                <MailConversationReader
                  mailboxId={data.mailbox.id}
                  requestUrl={requestPath()}
                  canWrite={canWrite()}
                  canAdmin={canAdmin()}
                  mailboxWide={!assignedOnly()}
                  identities={data.identities}
                  onOpenDeliverySettings={() => void openSettings("delivery")}
                  selectionKey={data.selectedMessageId ?? data.selectedConversationId}
                  selectedConversationId={data.selectedConversationId}
                  selectedMessageId={data.selectedMessageId}
                  unread={selectedUnread()}
                  flagged={selectedFlagged()}
                  inJunk={selectedInJunk()}
                  keep={data.keep}
                  reference={data.selectedReference}
                  subject={data.selectedSubject}
                  messages={hasSelection() ? data.detailMessages : []}
                  activity={conversationActivity()}
                  conversationSummary={data.conversationSummary}
                  conversationDrafts={data.conversationDrafts}
                  totalMessageCount={hasSelection() ? (selectedListItem()?.messageCount ?? data.detailMessages.length) : 0}
                  error={hasSelection() ? data.detailError : null}
                  dateConfig={props.dateConfig}
                  readingFormat={userPreferences().readingFormat}
                  theme={theme()}
                  calendarIntegrationAvailable={props.calendarIntegrationAvailable}
                  listCollapsed={listCollapsed()}
                  detailsOpen={detailsOpen()}
                  toolbarActions={toolbarActions()}
                  onRestoreList={() => setCollapsed(false)}
                  onToggleDetails={() => canShowDetails() && setDetailsVisible(!detailsOpen())}
                  onToolbarActionsChange={updateToolbarActions}
                  actionPending={structureMutationLoading()}
                  structurePending={structurePending()}
                  onAction={runAction}
                  onOpenHref={openWorkspaceHref}
                  onManageTags={() => {
                    const item = selectedListItem();
                    if (item) return manageConversationTags(item);
                  }}
                  onMergeConversation={mergeSelectedConversation}
                  onReassignMessage={reassignMessage}
                  onSplitMessage={splitMessage}
                  onKeep={() => setConversationKept(true)}
                  onStopKeeping={() => setConversationKept(false)}
                  onSummarySaved={applySavedConversationSummary}
                  onReconcile={reconcileWorkspace}
                  onReconcileAfterWrite={requireWorkspaceReconcile}
                  onClose={closeConversation}
                />
              </>
            }
          >
            <Show
              when={data.draftsMode}
              fallback={
                <MailScheduledView
                  mailboxId={data.mailbox.id}
                  page={
                    data.scheduledPage ?? {
                      items: [],
                      nextCursor: null,
                      total: data.scheduledCount,
                    }
                  }
                  error={data.scheduledError}
                  dateConfig={props.dateConfig}
                  canWrite={canWrite()}
                  loading={routeLoading()}
                  onNavigate={async () => {
                    await workspaceQuery.loadMore();
                    if (workspaceQuery.error()) toast.error(workspaceQuery.error()!.message);
                  }}
                  onRefresh={requireWorkspaceReconcile}
                />
              }
            >
              <MailDraftsView
                mailboxId={data.mailbox.id}
                canWrite={canWrite()}
                title={data.listTitle}
                returnHref={requestPath()}
                page={data.draftsPage ?? { items: [], nextCursor: null, total: 0 }}
                error={data.draftsError}
                dateConfig={props.dateConfig}
                loading={routeLoading()}
                onNavigate={async () => {
                  await workspaceQuery.loadMore();
                  if (workspaceQuery.error()) toast.error(workspaceQuery.error()!.message);
                }}
              />
            </Show>
          </Show>
        </AppWorkspace.Main>
        <AppWorkspace.Detail
          id={MAIL_CONTEXT_DETAIL_ID}
          openOnChoice={false}
          open={detailsOpen() && canShowDetails()}
          available={canShowDetails()}
          onOpen={() => setDetailsVisible(true, false)}
          onClose={() => setDetailsVisible(false)}
          width="lg"
          maxWidth={520}
        >
          <Show
            when={data.selectedConversationId && data.collaborationState && data.conversationLocalTags}
            fallback={
              <div class="flex h-full items-center justify-center p-4">
                <Placeholder
                  state={routeLoading() ? "loading" : "error"}
                  title={routeLoading() ? t().loadingDetails : t().detailsUnavailable}
                  description={
                    routeLoading()
                      ? undefined
                      : (data.detailErrors.collaboration ?? data.detailErrors.tags ?? data.collaborationError ?? t().refreshConversation)
                  }
                />
              </div>
            }
          >
            <MailDetailsPanel
              mailboxId={data.mailbox.id}
              conversationId={data.selectedConversationId!}
              active={detailsOpen()}
              canWrite={canWrite()}
              mailboxWide={!assignedOnly()}
              initialState={data.collaborationState!}
              initialLocalTags={data.localTags}
              initialConversationLocalTags={data.conversationLocalTags!}
              initialComments={data.comments}
              initialCommentsCursor={data.commentsCursor}
              assignableUsers={data.assignableUsers}
              presence={presence().participants}
              currentUserId={props.currentUserId}
              activity={conversationActivity()}
              initialReminder={data.reminder}
              detailErrors={data.detailErrors}
              conversationDrafts={data.conversationDrafts}
              messages={data.detailMessages}
              subject={data.selectedSubject}
              requestUrl={requestPath()}
              dateConfig={props.dateConfig}
              onCollaborationChange={applyCollaborationState}
              onConversationTagsChange={applyConversationTags}
              onClose={() => setDetailsVisible(false)}
              onOpenHref={openWorkspaceHref}
              onReconcile={reconcileWorkspace}
            />
          </Show>
        </AppWorkspace.Detail>
      </AppWorkspace.Content>
    </>
  );
}

export default function MailWorkspace(props: MailWorkspaceProps) {
  const locale = useLocale();
  const mailboxPreferences = createMailboxPreferences(props.sidebar);
  const [session, setSession] = createSignal<MailboxSession>({
    data: props.data,
    requestPath: props.requestPath,
    initialPreferences: props.initialPreferences,
    initialUserPreferences: props.initialUserPreferences,
  });
  const [controls, setControls] = createSignal<MailboxSessionControls>();
  const [switching, setSwitching] = createSignal(false);
  let switchRequest: AbortController | undefined;
  let switchGeneration = 0;
  const cancelSwitch = () => {
    ++switchGeneration;
    switchRequest?.abort();
    switchRequest = undefined;
    setSwitching(false);
  };
  onCleanup(cancelSwitch);

  const switchMailbox = async (url: URL, nav?: LinkNavigateEvent, completeScrollRestore?: () => void) => {
    const shown = controls();
    if (nav && shown && isMailWorkspaceUrl(url, session().data.mailbox.id, window.location.origin)) {
      // Clicking the shown mailbox is a newer intent even when its default URL is already current.
      cancelSwitch();
      await shown.handle.navigateHere(nav);
      return;
    }
    const target = props.sidebar.mailboxes.find((mailbox) => isMailWorkspaceUrl(url, mailbox.id, window.location.origin));
    const fallback = () => (nav ? nav.fallback() : documentNavigate(url.href, { replace: true }));
    if (!target || target.id === session().data.mailbox.id || !shown) {
      cancelSwitch();
      fallback();
      return;
    }
    cancelSwitch();
    const generation = switchGeneration;
    const request = new AbortController();
    switchRequest = request;
    shown.handle.supersede();
    setSwitching(true);
    try {
      const response = await apiClient.mailboxes[":mailboxId"]["workspace-route"].$get(
        { param: { mailboxId: target.id }, query: { href: `${url.pathname}${url.search}`, listMode: shown.handle.listMode() } },
        { init: { signal: request.signal } },
      );
      if (!response.ok) throw new Error(`Mailbox workspace: ${response.status}`);
      const data = await response.json();
      if (request.signal.aborted || generation !== switchGeneration) return;
      const initialPreferences = shown.preferences();
      nav?.push(undefined, { scroll: "preserve" });
      setSession({
        data,
        requestPath: `${url.pathname}${url.search}`,
        initialUserPreferences: readMailUserPreferences(target.id),
        initialPreferences,
      });
      const { t } = mailPageMessages.resolve([locale()]);
      layout.update({
        breadcrumbs: [
          { title: t.breadcrumbStart, href: "/" },
          { title: t.breadcrumbMail, href: "/app/mail" },
          { title: data.mailbox.name },
        ],
      });
      announce(data.mailbox.name);
      completeScrollRestore?.();
    } catch {
      if (!request.signal.aborted && generation === switchGeneration) fallback();
    } finally {
      if (generation === switchGeneration) {
        switchRequest = undefined;
        setSwitching(false);
      }
    }
  };

  return (
    <MailContactDirectoryProvider value={props.contactDirectory}>
      <AppWorkspace mobileSurface="flush" class="mail-workspace">
        {(() => {
          // Resolve the session before the sidebar, so its first server and browser render already has the open mailbox.
          const workspace = (
            <Show when={session()} keyed>
              {(s) => (
                <MailboxWorkspace
                  {...props}
                  {...s}
                  switching={switching}
                  onReady={setControls}
                  onNavigationStart={cancelSwitch}
                  onOpenMailboxHistory={(url, completeScrollRestore) => {
                    void switchMailbox(url, undefined, completeScrollRestore);
                  }}
                />
              )}
            </Show>
          );
          return (
            <>
              <MailSidebar
                canCreate={Boolean(props.currentUserId)}
                currentUserEmail={props.currentUserEmail}
                contactDirectory={props.contactDirectory}
                mailboxes={props.sidebar.mailboxes}
                preferences={mailboxPreferences}
                counts={[]}
                open={controls()?.open() ?? null}
                onOpenPlaceRowHiddenChange={(hidden) => controls()?.onOpenPlaceRowHiddenChange(hidden)}
                onOpenMailbox={(nav) => switchMailbox(new URL(nav.href, window.location.origin), nav)}
              />
              {workspace}
            </>
          );
        })()}
      </AppWorkspace>
    </MailContactDirectoryProvider>
  );
}
