import { documentNavigate, type LinkNavigateEvent, listenPopState, navigate } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { mutation, query } from "@k2b/stdlib/solid";
import { AppWorkspace, openSpotlightSearch, Placeholder, prompts, toast } from "@k2b/ui";
import { createLiveWebSocket } from "@valentinkolb/cloud/browser/live";
import { type CloudTheme, getCurrentThemePreference } from "@valentinkolb/cloud/shared";
import { batch, createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { apiClient } from "../api/client";
import { MAIL_LIVE_WS_TYPE, type MailLiveClientMessage, type MailLiveServerMessage, parseMailLiveServerMessage } from "../live-events";
import { resolveMailSearchRoute } from "../search-state";
import type { ConversationCollaboration } from "../service/collaboration";
import type { ConversationLocalTags } from "../service/local-tags";
import type { ConversationPresenceSnapshot } from "../service/presence";
import type { MailboxPageData, MailListItem } from "../service/workspace";
import { readApiError } from "./_components/api-response";
import { openMailAttachmentLinksDialog } from "./_components/MailAttachmentLinksDialog";
import { chooseBulkTags, chooseConversationTags } from "./_components/MailBulkTagDialog";
import { openMailboxHealthDialog } from "./_components/MailboxHealthDialog";
import { openMailboxSettingsDialog } from "./_components/MailboxSettingsDialog";
import MailConversationList from "./_components/MailConversationList";
import MailConversationReader from "./_components/MailConversationReader";
import MailDetailsPanel from "./_components/MailDetailsPanel";
import { openMailRemoteContentRulesDialog } from "./_components/MailRemoteContentRulesDialog";
import MailScheduledView from "./_components/MailScheduledView";
import { observeMailUserPreferences } from "./_components/MailSettingsStore";
import MailSidebar from "./_components/MailSidebar";
import { openMailSubscriptionDialog } from "./_components/MailSubscriptionDialog";
import { buildMailActionInput, getMailAction, type MailActionId } from "./_components/mail-actions";
import type { MailBulkTarget } from "./_components/mail-bulk-actions";
import {
  emptyMailConversationSelection,
  findMailFocusAfterRemoval,
  pruneMailConversationSelection,
  toggleMailConversationSelection,
} from "./_components/mail-conversation-selection";
import type { MailConversationToolbarActionId } from "./_components/mail-conversation-toolbar";
import { mergeMailCursorPage } from "./_components/mail-cursor-page";
import { preserveUnavailableMailDetail } from "./_components/mail-detail-availability";
import { reconcileConversationSummary } from "./_components/mail-details-reconciliation";
import {
  type MailListOptimisticField,
  type MailListOptimisticPatch,
  type PendingMailListState,
  reconcileMailListOptimisticState,
} from "./_components/mail-list-optimistic";
import { createMailLiveInvalidationHub, type MailLiveInvalidation } from "./_components/mail-live-invalidation-hub";
import { buildMailListHref, isMailWorkspaceUrl } from "./_components/mail-navigation";
import { createMailPresenceSession } from "./_components/mail-presence-session";
import type { MailUserPreferences } from "./_components/mail-user-preferences";
import {
  decideMailAutoReadIntent,
  type MailWorkspaceActionExecution,
  type MailWorkspaceActionOptions,
  type MailWorkspaceActionRunnerHost,
  runMailWorkspaceAction,
} from "./_components/mail-workspace-action-runner";
import { type MailWorkspacePreferences, writeMailWorkspacePreferences } from "./_components/mail-workspace-preferences";
import {
  captureMailWorkspaceRefreshError,
  type MailWorkspaceRefreshResult,
  requireMailWorkspaceRefresh,
} from "./_components/mail-workspace-refresh";
import { assertCursorProgress } from "./pagination";

const rank = (permission: string): number => (permission === "admin" ? 3 : permission === "write" ? 2 : permission === "read" ? 1 : 0);
const mailListScope = (href: string): string => {
  const url = new URL(href, "http://mail.local");
  url.searchParams.delete("conversation");
  url.searchParams.delete("message");
  url.searchParams.delete("cursor");
  return `${url.pathname}${url.search}`;
};

export default function MailWorkspace(props: {
  data: MailboxPageData;
  requestUrl: string;
  currentUserId: string;
  currentUserEmail: string | null;
  dateConfig: DateContext;
  initialPreferences: MailWorkspacePreferences;
  initialUserPreferences: MailUserPreferences;
  initialTheme: CloudTheme;
  calendarIntegrationAvailable: boolean;
}) {
  // A store keeps shell, list, and detail consumers granular even though the
  // server snapshot remains one canonical contract.
  const [data, setData] = createStore(props.data);
  const [requestUrl, setRequestUrl] = createSignal(props.requestUrl);
  const [listCollapsed, setListCollapsed] = createSignal(props.initialPreferences.listCollapsed);
  const [detailsOpen, setDetailsOpen] = createSignal(props.initialPreferences.detailsOpen);
  const [toolbarActions, setToolbarActions] = createSignal(props.initialPreferences.toolbarActions);
  const [theme, setTheme] = createSignal(props.initialTheme);
  const [presence, setPresence] = createSignal<ConversationPresenceSnapshot>({
    participants: [],
  });
  const [settingsOpening, setSettingsOpening] = createSignal(false);
  const [managementOpening, setManagementOpening] = createSignal<"health" | "links" | "remote-content" | "subscriptions" | null>(null);
  const [liveTransportDegraded, setLiveTransportDegraded] = createSignal(false);
  const [liveSnapshotDegraded, setLiveSnapshotDegraded] = createSignal(false);
  const liveDegraded = createMemo(() => liveTransportDegraded() || liveSnapshotDegraded());
  const activeSearch = createMemo(() => resolveMailSearchRoute(new URL(requestUrl(), "http://mail.local")));
  const activeTagId = createMemo(() => {
    const expression = activeSearch().expression;
    return expression?.type === "local_tag_id" ? expression.tagId : null;
  });
  const [conversationSelection, setConversationSelection] = createSignal(emptyMailConversationSelection());
  const [selectionMode, setSelectionMode] = createSignal(false);
  const [conversationOpenIntent, setConversationOpenIntent] = createSignal(0);
  const mailboxId = props.data.mailbox.id;
  const userPreferences = createMemo(() => observeMailUserPreferences(mailboxId, props.initialUserPreferences));
  let preferenceTimer: ReturnType<typeof setTimeout> | null = null;
  let liveTransportTimer: ReturnType<typeof setTimeout> | null = null;
  let markLiveApplied: (cursor: string | null | undefined) => void = () => undefined;
  let actionMutationLoading = () => false;
  let structureMutationLoading = () => false;
  const actionPending = () => structureMutationLoading() || actionMutationLoading();
  let disposed = false;
  const focusFrames = new Set<number>();
  let pendingListState = new Map<string, PendingMailListState>();
  const selectedConversationId = createMemo(() => data.selectedConversationId);
  const selectedConversationIds = createMemo(() => conversationSelection().ids);
  const canWrite = createMemo(() => rank(data.permission) >= 2);
  const canAdmin = createMemo(() => rank(data.permission) >= 3);
  let routeLoading = () => false;
  const workspaceRefreshBlocked = () => settingsOpening() || managementOpening() !== null;

  onMount(() => {
    writeMailWorkspacePreferences({
      ...props.initialPreferences,
      lastMailboxId: mailboxId,
    });
    const root = document.documentElement;
    const syncTheme = () => setTheme(getCurrentThemePreference());
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    onCleanup(() => observer.disconnect());
  });

  const applyPendingListState = (snapshot: MailboxPageData): MailboxPageData => {
    const reconciled = reconcileMailListOptimisticState(snapshot.listItems, pendingListState);
    pendingListState = reconciled.pending;
    return { ...snapshot, listItems: reconciled.items };
  };

  const rememberPendingListState = (conversationId: string, patch: MailListOptimisticPatch) => {
    pendingListState.set(conversationId, {
      ...pendingListState.get(conversationId),
      ...patch,
      expiresAt: Date.now() + 30_000,
    });
  };

  const clearPendingListState = (conversationId: string, fields: MailListOptimisticField[]) => {
    const current = pendingListState.get(conversationId);
    if (!current) return;
    const next = { ...current };
    for (const field of fields) delete next[field];
    if (Object.keys(next).length === 1) pendingListState.delete(conversationId);
    else pendingListState.set(conversationId, next);
  };

  const fetchWorkspaceRoute = async (
    href: string,
    signal: AbortSignal,
    listMode: MailboxPageData["listMode"] = data.listMode,
  ): Promise<MailboxPageData | null> => {
    const target = new URL(href, window.location.origin);
    if (!isMailWorkspaceUrl(target, mailboxId, window.location.origin)) return null;
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

  type WorkspaceRouteResult = { source: string; snapshot: MailboxPageData };
  type WorkspaceTransition = {
    source: string;
    resolve: (result: "applied" | "failed" | "stale") => void;
  };
  const encodeRouteSource = (href: string, listMode: MailboxPageData["listMode"]) => JSON.stringify({ href, listMode });
  const decodeRouteSource = (source: string): { href: string; listMode: MailboxPageData["listMode"] } => JSON.parse(source);
  const initialRouteSource = encodeRouteSource(props.requestUrl, props.data.listMode);
  const [routeSource, setRouteSource] = createSignal(initialRouteSource);
  let committedRouteSource = initialRouteSource;
  let workspaceTransition: WorkspaceTransition | null = null;

  const liveHub = createMailLiveInvalidationHub({
    delayMs: 180,
    isBlocked: workspaceRefreshBlocked,
    onApplied: (cursor) => {
      setLiveSnapshotDegraded(false);
      markLiveApplied(cursor);
    },
    onFailed: () => setLiveSnapshotDegraded(true),
  });

  const workspaceQuery = query.createInfinite<string, WorkspaceRouteResult, string, MailLiveInvalidation>({
    source: routeSource,
    initial: { source: initialRouteSource, pages: [{ source: initialRouteSource, snapshot: props.data }] },
    loadPage: async (source, { cursor, abortSignal }) => {
      const target = decodeRouteSource(source);
      const url = new URL(target.href, window.location.origin);
      if (cursor !== undefined) url.searchParams.set("cursor", cursor);
      const snapshot = await fetchWorkspaceRoute(url.toString(), abortSignal, target.listMode);
      if (!snapshot) throw new Error("Could not load mailbox view");
      const nextCursor = snapshot.scheduledMode ? snapshot.scheduledPage?.nextCursor : snapshot.nextListCursor;
      assertCursorProgress(cursor, nextCursor, "mailbox");
      return { source, snapshot };
    },
    getNextCursor: (page) => (page.snapshot.scheduledMode ? page.snapshot.scheduledPage?.nextCursor : page.snapshot.nextListCursor),
    subscribe: ({ invalidate }) =>
      liveHub.register({
        matches: () => true,
        invalidate,
      }),
  });
  routeLoading = () => workspaceQuery.loading() || workspaceQuery.refreshing() || workspaceQuery.loadingMore();

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
    const target = new URL(href, window.location.origin);
    if (!isMailWorkspaceUrl(target, mailboxId, window.location.origin)) return Promise.resolve("failed");
    const source = encodeRouteSource(target.toString(), listMode);
    if (workspaceTransition) workspaceTransition.resolve("stale");
    workspaceTransition = null;
    if (source === routeSource()) {
      return workspaceQuery
        .invalidate({ cursor: null, conversationIds: null })
        .then(() => "applied" as const)
        .catch(() => "failed" as const);
    }
    return new Promise((resolve) => {
      workspaceTransition = { source, resolve };
      setRouteSource(source);
    });
  };

  createEffect(() => {
    const pages = workspaceQuery.pages();
    const first = pages[0];
    if (!first || first.source !== routeSource()) return;
    const target = decodeRouteSource(first.source);
    const scopeChanged = mailListScope(requestUrl()) !== mailListScope(target.href);
    let next = applyPendingListState(preserveCurrentDetail(first.snapshot));
    for (const page of pages.slice(1)) {
      const reconciled = applyPendingListState(page.snapshot);
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
      committedRouteSource = first.source;
      setRequestUrl(target.href);
      setData(reconcile(next));
      setConversationSelection((current) =>
        scopeChanged
          ? emptyMailConversationSelection()
          : pruneMailConversationSelection(
              current,
              new Set(next.listItems.flatMap((item) => (item.conversationId ? [item.conversationId] : []))),
            ),
      );
      if (scopeChanged) setSelectionMode(false);
    });
    if (workspaceTransition?.source === first.source) {
      workspaceTransition.resolve("applied");
      workspaceTransition = null;
    }
  });

  createEffect(() => {
    const error = workspaceQuery.error();
    if (!error || routeLoading() || workspaceTransition?.source !== routeSource()) return;
    const transition = workspaceTransition;
    workspaceTransition = null;
    if (routeSource() !== committedRouteSource) setRouteSource(committedRouteSource);
    transition.resolve("failed");
  });

  const navigateWorkspace = async (nav: LinkNavigateEvent) => {
    const result = await replaceWorkspaceRoute(nav.href);
    if (result === "applied") nav.push(undefined, { scroll: "preserve" });
    else if (result === "failed") toast.error("Could not open this mailbox view. Your current view was kept.");
  };

  const closeConversation = async (nav: LinkNavigateEvent) => {
    const previousConversationId = data.selectedConversationId;
    const result = await replaceWorkspaceRoute(nav.href);
    if (result === "applied") {
      nav.push(undefined, { scroll: "preserve" });
      if (previousConversationId) focusConversation(previousConversationId, "row");
    } else if (result === "failed") toast.error("Could not close this conversation. Your current view was kept.");
  };

  const transitionWorkspaceHref = async (href: string, replace = false): Promise<MailWorkspaceRefreshResult> => {
    const result = await replaceWorkspaceRoute(href);
    if (result === "applied") {
      if (data.selectedConversationId) setConversationOpenIntent((intent) => intent + 1);
      navigate(href, { replace, scroll: "preserve" });
    }
    return result;
  };

  const openWorkspaceHref = async (href: string, replace = false) => {
    const result = await transitionWorkspaceHref(href, replace);
    if (result === "failed") toast.error("Could not open this mailbox view. Your current view was kept.");
  };

  const loadMoreConversations = async (href: string): Promise<boolean> => {
    if (routeLoading()) return false;
    const target = new URL(href, window.location.origin);
    if (!isMailWorkspaceUrl(target, mailboxId, window.location.origin)) return false;
    await workspaceQuery.loadMore();
    const error = workspaceQuery.error();
    if (error) toast.error(error.message);
    return !error;
  };

  const persistPreferences = () => {
    if (preferenceTimer) clearTimeout(preferenceTimer);
    preferenceTimer = setTimeout(
      () =>
        writeMailWorkspacePreferences({
          listCollapsed: listCollapsed(),
          detailsOpen: detailsOpen(),
          toolbarActions: toolbarActions(),
          listMode: data.listMode,
          lastMailboxId: mailboxId,
          pinnedMailboxIds: props.initialPreferences.pinnedMailboxIds,
        }),
      120,
    );
  };

  const setCollapsed = (collapsed: boolean) => {
    setListCollapsed(collapsed);
    persistPreferences();
  };

  const updateToolbarActions = (actions: MailConversationToolbarActionId[]) => {
    setToolbarActions(actions);
    persistPreferences();
  };

  const updateListMode = (listMode: MailboxPageData["listMode"]) => {
    if (listMode === data.listMode) return;
    const previousListMode = data.listMode;
    writeMailWorkspacePreferences({
      listCollapsed: listCollapsed(),
      detailsOpen: detailsOpen(),
      toolbarActions: toolbarActions(),
      listMode,
      lastMailboxId: mailboxId,
      pinnedMailboxIds: props.initialPreferences.pinnedMailboxIds,
    });
    setConversationSelection(emptyMailConversationSelection());
    setSelectionMode(false);
    void (async () => {
      const href = buildMailListHref(new URL(requestUrl()));
      const result = await replaceWorkspaceRoute(href, listMode);
      if (result === "applied") {
        navigate(href, { replace: true, scroll: "preserve" });
        return;
      }
      writeMailWorkspacePreferences({
        listCollapsed: listCollapsed(),
        detailsOpen: detailsOpen(),
        toolbarActions: toolbarActions(),
        listMode: previousListMode,
        lastMailboxId: mailboxId,
        pinnedMailboxIds: props.initialPreferences.pinnedMailboxIds,
      });
      if (result === "failed") toast.error("Could not change the list view. Your current view was kept.");
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

  createEffect(() => {
    if (!workspaceRefreshBlocked()) liveHub.resume();
  });

  const openSettings = async (initialTab?: string) => {
    if (disposed || settingsOpening()) return;
    setSettingsOpening(true);
    try {
      const result = await openMailboxSettingsDialog({
        mailboxId: data.mailbox.id,
        currentUserEmail: props.currentUserEmail,
        initialTab,
      });
      if (disposed) return;
      if (result.deleted) return documentNavigate("/app/mail");
      if (!result.workspaceChanged) return;
      const refreshResult = await replaceWorkspaceRoute(requestUrl());
      if (refreshResult === "failed") toast.error("Mailbox settings were saved, but this view could not be refreshed yet.");
    } finally {
      if (!disposed) setSettingsOpening(false);
    }
  };

  const openHealth = async () => {
    if (disposed || managementOpening()) return;
    setManagementOpening("health");
    try {
      const result = await openMailboxHealthDialog({ mailboxId: data.mailbox.id, dateConfig: props.dateConfig });
      if (disposed) return;
      if (!result.workspaceChanged) return;
      const refreshResult = await replaceWorkspaceRoute(requestUrl());
      if (refreshResult === "failed") toast.error("Mailbox health changed, but this view could not be refreshed yet.");
    } finally {
      if (!disposed) setManagementOpening(null);
    }
  };

  const openSharedLinks = async () => {
    if (disposed || managementOpening()) return;
    setManagementOpening("links");
    try {
      await openMailAttachmentLinksDialog({ mailboxId: data.mailbox.id, dateConfig: props.dateConfig });
    } finally {
      if (!disposed) setManagementOpening(null);
    }
  };

  const openRemoteContent = async () => {
    if (disposed || managementOpening()) return;
    setManagementOpening("remote-content");
    try {
      await openMailRemoteContentRulesDialog(data.mailbox.id);
    } finally {
      if (!disposed) setManagementOpening(null);
    }
  };

  const openSubscriptions = async (initialListKey: string | null = null) => {
    if (disposed || managementOpening()) return;
    setManagementOpening("subscriptions");
    try {
      await openMailSubscriptionDialog({ mailboxId: data.mailbox.id, canWrite: canWrite(), initialListKey });
    } finally {
      if (!disposed) setManagementOpening(null);
      if (!initialListKey || disposed) return;
      const current = new URL(window.location.href);
      const currentListKey = current.searchParams.get("mailingList")?.trim().toLowerCase().slice(0, 4096) || null;
      if (currentListKey !== initialListKey) return;
      current.searchParams.delete("mailingList");
      window.history.replaceState(window.history.state, "", `${current.pathname}${current.search}${current.hash}`);
      setRequestUrl(current.toString());
    }
  };

  let openedMailingListKey: string | null = null;
  createEffect(() => {
    const key = new URL(requestUrl()).searchParams.get("mailingList")?.trim().toLowerCase().slice(0, 4096) || null;
    if (!key) {
      openedMailingListKey = null;
      return;
    }
    if (key === openedMailingListKey || managementOpening()) return;
    openedMailingListKey = key;
    void openSubscriptions(key);
  });

  onMount(() => {
    setRequestUrl(window.location.href);
    const oauthUrl = new URL(window.location.href);
    const oauthOutcome = oauthUrl.searchParams.get("oauth");
    const oauthFlowId = oauthUrl.searchParams.get("flow");
    if (oauthOutcome) {
      oauthUrl.searchParams.delete("oauth");
      oauthUrl.searchParams.delete("flow");
      window.history.replaceState(window.history.state, "", `${oauthUrl.pathname}${oauthUrl.search}${oauthUrl.hash}`);
      if (oauthOutcome === "connected" || oauthOutcome === "reconnected") toast.success("Provider connected with OAuth");
      else if (oauthOutcome === "partial")
        toast("Provider connected, but setup still requires attention", {
          title: "OAuth setup incomplete",
        });
      else toast.error("OAuth authorization could not be completed");
      void (async () => {
        if (oauthFlowId) {
          try {
            const response = await apiClient.oauth.flows[":flowId"].$get({ param: { flowId: oauthFlowId } });
            if (disposed) return;
            if (response.ok) {
              const result = await response.json();
              if (disposed) return;
              const resultCode = result.resultCode?.toLowerCase() ?? null;
              if (result.message && resultCode !== "connected" && resultCode !== "reconnected" && resultCode !== "partial") {
                toast.error(result.message);
              }
              if (result.diagnostics?.imap.status === "failed" || result.diagnostics?.smtp.status === "failed") {
                toast.error(`IMAP: ${result.diagnostics.imap.message}; SMTP: ${result.diagnostics.smtp.message}`);
              }
            }
          } catch {
            if (!disposed) toast.error("OAuth completed, but its connection status could not be loaded");
          }
        }
        if (!disposed) await openSettings("delivery");
      })();
    }
    let readyReceived = false;
    const live = createLiveWebSocket<MailLiveServerMessage>({
      url: "/api/mail/ws",
      initialCursor: props.data.initialLiveCursor,
      activity: "visible",
      subscribe: (cursor) =>
        ({
          type: MAIL_LIVE_WS_TYPE.subscribe,
          payload: { mailboxId: props.data.mailbox.id, fromCursor: cursor },
        }) satisfies MailLiveClientMessage,
      parse: (raw) => {
        const message = parseMailLiveServerMessage(raw);
        if (!message) throw new Error("Invalid Mail live server message");
        return message;
      },
      onStatus: (status) => {
        if (liveTransportTimer) clearTimeout(liveTransportTimer);
        liveTransportTimer = null;
        if (status === "reconnecting") {
          if (!liveTransportDegraded()) {
            liveTransportTimer = setTimeout(() => {
              liveTransportTimer = null;
              if (!disposed) setLiveTransportDegraded(true);
            }, 2_000);
          }
          return;
        }
        if (status === "open" || status === "paused" || status === "closed") setLiveTransportDegraded(false);
      },
      onMessage: (message, controls) => {
        const messageMailboxId = message.payload.mailboxId;
        if (messageMailboxId && messageMailboxId !== props.data.mailbox.id) {
          controls.terminate({
            code: "resource_mismatch",
            message: "Mail live subscription changed resources",
          });
          return;
        }
        if (message.type === MAIL_LIVE_WS_TYPE.ready) {
          if (props.data.initialLiveCursor === null || readyReceived) {
            liveHub.schedule({ cursor: message.payload.cursor, conversationId: null });
          } else controls.markApplied(message.payload.cursor);
          readyReceived = true;
          return;
        }
        if (message.type === MAIL_LIVE_WS_TYPE.event) {
          liveHub.schedule({
            cursor: message.payload.cursor,
            conversationId: message.payload.event.conversationId,
          });
          return;
        }
        if (message.type === MAIL_LIVE_WS_TYPE.revoked) {
          controls.terminate({
            code: message.payload.code,
            message: message.payload.message,
          });
          return;
        }
        if (message.type === MAIL_LIVE_WS_TYPE.error) {
          setLiveSnapshotDegraded(true);
        }
      },
      classifyClose: ({ code, reason }) =>
        code === 1008 ? { code: reason || "access_denied", message: "Mailbox access changed or expired." } : null,
      onFatal: (error) => {
        const current = `${window.location.pathname}${window.location.search}`;
        if (error.code === "login_required") {
          documentNavigate(`/auth/login?redirectTo=${encodeURIComponent(current)}`, { replace: true });
        } else {
          documentNavigate("/app/mail", { replace: true });
        }
      },
    });
    markLiveApplied = live.markApplied;
    const stopPopState = listenPopState(({ url }) => {
      if (!isMailWorkspaceUrl(url, mailboxId, window.location.origin)) {
        documentNavigate(url.href, { replace: true });
        return;
      }
      void (async () => {
        const result = await replaceWorkspaceRoute(`${url.pathname}${url.search}`);
        if (!disposed && result === "failed") {
          navigate(requestUrl(), { replace: true, scroll: "preserve", viewTransition: false });
          toast.error("Could not restore this mailbox view. Your current view was kept.");
        }
      })();
    });
    live.connect();
    onCleanup(() => {
      live.dispose();
      markLiveApplied = () => undefined;
      stopPopState();
    });
  });

  onCleanup(() => {
    disposed = true;
    if (preferenceTimer) clearTimeout(preferenceTimer);
    if (liveTransportTimer) clearTimeout(liveTransportTimer);
    workspaceTransition?.resolve("stale");
    workspaceTransition = null;
    liveHub.dispose();
    for (const frame of focusFrames) cancelAnimationFrame(frame);
    focusFrames.clear();
  });

  const hasSelection = createMemo(() => Boolean(data.selectedConversationId || data.selectedMessageId));
  const selectedListItem = createMemo(() =>
    data.listItems.find((item) =>
      item.selectionKind === "message" ? item.id === data.selectedMessageId : item.conversationId === data.selectedConversationId,
    ),
  );
  const selectedUnread = createMemo(
    () => selectedListItem()?.unread ?? data.detailMessages.some((message) => !message.flags.includes("\\Seen")),
  );
  const selectedFlagged = createMemo(
    () => selectedListItem()?.flagged ?? data.detailMessages.some((message) => message.flags.includes("\\Flagged")),
  );
  const selectedInJunk = createMemo(() => {
    const folderId = selectedListItem()?.sourceFolderId ?? data.folderId ?? data.detailMessages.at(-1)?.folderId;
    return Boolean(folderId && data.folders.some((folder) => folder.id === folderId && folder.role === "junk"));
  });
  const selectedConversationRevision = createMemo(() => selectedListItem()?.revision ?? data.collaborationState?.revision ?? null);
  const canShowDetails = createMemo(() => Boolean(data.selectedConversationId));

  createEffect(() => {
    if (canWrite() || (!selectionMode() && conversationSelection().ids.size === 0)) return;
    setConversationSelection(emptyMailConversationSelection());
    setSelectionMode(false);
  });

  const setConversationUnread = (conversationId: string, unread: boolean) => {
    setData("listItems", (items) => items.map((item) => (item.conversationId === conversationId ? { ...item, unread } : item)));
  };

  const setConversationFlagged = (conversationId: string, flagged: boolean) => {
    setData("listItems", (items) => items.map((item) => (item.conversationId === conversationId ? { ...item, flagged } : item)));
  };

  const setConversationListState = (conversationId: string, patch: MailListOptimisticPatch) => {
    setData("listItems", (items) => items.map((item) => (item.conversationId === conversationId ? { ...item, ...patch } : item)));
  };

  const applyCollaborationState = (next: ConversationCollaboration) => {
    const patch: MailListOptimisticPatch = {
      assigneeUserId: next.assignee?.id ?? null,
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

  const focusConversation = (conversationId: string, target: "reader" | "row") => {
    const frame = requestAnimationFrame(() => {
      focusFrames.delete(frame);
      if (disposed) return;
      const element =
        target === "reader"
          ? document.querySelector<HTMLElement>("[data-mail-reader-heading]")
          : document.querySelector<HTMLElement>(`[data-conversation-id="${CSS.escape(conversationId)}"] .mail-list-row`);
      element?.focus({ preventScroll: true });
      if (target === "row") element?.scrollIntoView({ block: "nearest" });
    });
    focusFrames.add(frame);
  };

  const applyConversationRoute = async (
    href: string,
    item: MailListItem,
    activation: "keyboard" | "pointer",
  ): Promise<"applied" | "failed" | "stale"> => {
    if (!item.conversationId) return "failed";
    const result = await replaceWorkspaceRoute(href);
    if (result === "applied" && activation === "keyboard") focusConversation(item.conversationId, "reader");
    return result;
  };

  const navigateConversation = async (href: string, item: MailListItem, activation: "keyboard" | "pointer") => {
    const result = item.conversationId ? await applyConversationRoute(href, item, activation) : await replaceWorkspaceRoute(href);
    if (result === "applied") {
      setConversationOpenIntent((intent) => intent + 1);
      navigate(href, { scroll: "preserve", viewTransition: false });
    } else if (result === "failed") toast.error("Could not open this conversation. Your current view was kept.");
  };

  const requireWorkspaceReconcile = () =>
    requireMailWorkspaceRefresh(
      () => replaceWorkspaceRoute(requestUrl()),
      "Could not refresh this mailbox yet. Reload to confirm the latest state.",
    );

  const reconcileWorkspace = async () => {
    const refreshError = await captureMailWorkspaceRefreshError(requireWorkspaceReconcile);
    if (refreshError) toast.error(refreshError.message);
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

  const orderedConversationIds = () => data.listItems.flatMap((item) => (item.conversationId ? [item.conversationId] : []));

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

  const actionTargetForItem = (item: MailListItem, actionId: MailActionId): MailBulkTarget | null => {
    if (!item.conversationId) return null;
    const sourceFolderIds =
      actionId === "mark_read" && item.unreadFolderIds.length > 0
        ? item.unreadFolderIds
        : ["mark_unread", "flag", "unflag"].includes(actionId)
          ? item.activeFolderIds
          : [item.sourceFolderId].filter((folderId): folderId is string => Boolean(folderId));
    return {
      conversationId: item.conversationId,
      label: item.subject || "(no subject)",
      sourceFolderIds,
    };
  };

  const actionTargets = (actionId: MailActionId): MailBulkTarget[] => {
    const selectedIds = selectedConversationIds();
    const ids = selectedIds.size > 0 ? selectedIds : new Set(data.selectedConversationId ? [data.selectedConversationId] : []);
    const targets = data.listItems.flatMap((item) => {
      if (!item.conversationId || !ids.has(item.conversationId)) return [];
      const target = actionTargetForItem(item, actionId);
      return target ? [target] : [];
    });
    if (targets.length > 0 || selectedIds.size > 0 || !data.selectedConversationId) return targets;
    const detailFolderIds = ["mark_read", "mark_unread", "flag", "unflag"].includes(actionId)
      ? [
          ...new Set(
            data.detailMessages
              .filter((message) => actionId !== "mark_read" || !message.flags.includes("\\Seen"))
              .map((message) => message.folderId),
          ),
        ]
      : [data.folderId ?? data.detailMessages.at(-1)?.folderId ?? null];
    return [
      {
        conversationId: data.selectedConversationId!,
        label: data.selectedSubject || "(no subject)",
        sourceFolderIds: detailFolderIds.filter((folderId): folderId is string => Boolean(folderId)),
      },
    ];
  };

  const chooseDestinationFolder = async () => {
    const folders = data.folders.filter((folder) => folder.selectable && folder.discoveryState === "active");
    const selected = await openSpotlightSearch<{ folderId: string }>({
      title: "Move to folder",
      icon: "ti ti-folder-symlink",
      placeholder: "Search folders...",
      noResultsText: "No selectable folder found.",
      resolve: ({ query }) => {
        const needle = query.trim().toLocaleLowerCase();
        return folders
          .filter((folder) => !needle || folder.name.toLocaleLowerCase().includes(needle))
          .map((folder) => ({
            label: folder.name,
            desc: folder.role === "folder" ? "Provider folder" : folder.role,
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
      data.listItems
        .filter((item) => item.conversationId && item.conversationId !== excludedConversationId)
        .map((item) => ({
          conversationId: item.conversationId!,
          revision: item.revision,
          subject: item.subject,
          participantSummary: item.participantSummary,
        }));
    const selected = await openSpotlightSearch<ConversationTarget>({
      title: "Choose conversation",
      icon: "ti ti-messages",
      placeholder: "Search by sender or subject...",
      minQueryLength: 0,
      emptyText: "Choose a recent conversation or search this mailbox.",
      noResultsText: "No other conversation found.",
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
              if (!response.ok) throw new Error(await readApiError(response, "Could not search conversations"));
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
          label: target.subject || "(no subject)",
          desc: target.participantSummary || "Unknown sender",
          icon: "ti ti-message",
        }));
      },
    });
    return selected?.value ?? null;
  };

  const conversationHref = (conversationId: string): string => {
    const current = new URL(buildMailListHref(new URL(requestUrl())), window.location.origin);
    current.searchParams.set("conversation", conversationId);
    return `${current.pathname}${current.search}`;
  };

  const mergeConversationMutation = mutation.create<
    { refreshError: Error | null } | undefined,
    { conversationId: string; revision: number; subject: string }
  >({
    mutation: async (source, { abortSignal }) => {
      const { conversationId: sourceConversationId, revision: sourceRevision } = source;
      const target = await chooseConversationTarget(sourceConversationId);
      if (!target || abortSignal.aborted || disposed) return;
      const confirmed = await prompts.confirm(
        `Move every message, comment, draft, tag, and reference from “${source.subject || "this conversation"}” into “${target.subject || "the selected conversation"}”?`,
        {
          title: "Merge conversations?",
          icon: "ti ti-git-merge",
          confirmText: "Merge conversations",
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
      if (!response.ok) throw new Error(await readApiError(response, "Could not merge conversations"));
      if (abortSignal.aborted || disposed) return;
      const refreshError = await captureMailWorkspaceRefreshError(() =>
        requireMailWorkspaceRefresh(
          () => transitionWorkspaceHref(conversationHref(target.conversationId), true),
          "The merged conversation could not be opened yet. Reload to confirm the latest state.",
        ),
      );
      if (abortSignal.aborted || disposed) return;
      return { refreshError };
    },
    onSuccess: (result) => {
      if (!result) return;
      toast.success("Conversations merged");
      if (result.refreshError) void prompts.error(result.refreshError.message, { title: "Conversations merged, refresh failed" });
    },
    onError: (error) =>
      prompts.error(error.message, {
        title: "Conversation was not changed",
      }),
  });
  const mergeConversation = (source: { conversationId: string; revision: number; subject: string }) => {
    if (!canWrite() || actionPending() || disposed) return Promise.resolve();
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
        await prompts.error("This is the only message in the conversation. Merge the whole conversation instead.", {
          title: "Message cannot be moved on its own",
        });
        return;
      }
      const target = await chooseConversationTarget(sourceConversationId);
      if (!target || abortSignal.aborted || disposed) return;
      const confirmed = await prompts.confirm(
        `Move this message and its linked internal comments into “${target.subject || "the selected conversation"}”?`,
        {
          title: "Move message?",
          icon: "ti ti-message-forward",
          confirmText: "Move message",
        },
      );
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
      if (!response.ok) throw new Error(await readApiError(response, "Could not move message"));
      if (abortSignal.aborted || disposed) return;
      const refreshError = await captureMailWorkspaceRefreshError(requireWorkspaceReconcile);
      if (abortSignal.aborted || disposed) return;
      return { refreshError };
    },
    onSuccess: (result) => {
      if (!result) return;
      toast.success("Message moved to another conversation");
      if (result.refreshError) void prompts.error(result.refreshError.message, { title: "Message moved, refresh failed" });
    },
    onError: (error) => prompts.error(error.message, { title: "Message was not moved" }),
  });
  const reassignMessage = (messageId: string) => {
    const sourceConversationId = data.selectedConversationId;
    const sourceRevision = selectedConversationRevision();
    if (!canWrite() || actionPending() || !sourceConversationId || !sourceRevision) return Promise.resolve();
    return reassignMessageMutation.mutate({ messageId, sourceConversationId, sourceRevision });
  };

  const splitMessageMutation = mutation.create<
    { refreshError: Error | null } | undefined,
    { messageId: string; conversationId: string; revision: number }
  >({
    mutation: async ({ messageId, conversationId, revision }, { abortSignal }) => {
      const confirmed = await prompts.confirm("Create a separate conversation from this message and its linked internal comments?", {
        title: "Start a new conversation?",
        icon: "ti ti-arrows-split-2",
        confirmText: "Create conversation",
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
      if (!response.ok) throw new Error(await readApiError(response, "Could not create a separate conversation"));
      const result = await response.json();
      if (abortSignal.aborted || disposed) return;
      const refreshError = await captureMailWorkspaceRefreshError(() =>
        requireMailWorkspaceRefresh(
          () => transitionWorkspaceHref(conversationHref(result.created.id), true),
          "The new conversation could not be opened yet. Reload to confirm the latest state.",
        ),
      );
      if (abortSignal.aborted || disposed) return;
      return { refreshError };
    },
    onSuccess: (result) => {
      if (!result) return;
      toast.success("New conversation created");
      if (result.refreshError) void prompts.error(result.refreshError.message, { title: "Conversation created, refresh failed" });
    },
    onError: (error) => prompts.error(error.message, { title: "Conversation was not changed" }),
  });
  const splitMessage = (messageId: string) => {
    const conversationId = data.selectedConversationId;
    const revision = selectedConversationRevision();
    if (
      !canWrite() ||
      actionPending() ||
      !conversationId ||
      !revision ||
      (selectedListItem()?.messageCount ?? data.detailMessages.length) <= 1
    )
      return Promise.resolve();
    return splitMessageMutation.mutate({ messageId, conversationId, revision });
  };

  const actionHost = {
    resolveTargets: actionTargets,
    chooseDestinationFolder,
    applyOptimistic: (nextActionId, targets) => {
      if (nextActionId === "mark_read" || nextActionId === "mark_unread") {
        const unread = nextActionId === "mark_unread";
        for (const target of targets) {
          rememberPendingListState(target.conversationId, { unread });
          setConversationUnread(target.conversationId, unread);
        }
      }
      if (nextActionId === "flag" || nextActionId === "unflag") {
        const flagged = nextActionId === "flag";
        for (const target of targets) {
          rememberPendingListState(target.conversationId, { flagged });
          setConversationFlagged(target.conversationId, flagged);
        }
      }
    },
    clearOptimistic: (conversationIds, fields) => {
      for (const conversationId of conversationIds) clearPendingListState(conversationId, [...fields]);
    },
    submit: async ({ actionId: nextActionId, target, sourceFolderId, destinationFolderId, correlationId, idempotencyKey, signal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].actions.$post(
        {
          param: { mailboxId, conversationId: target.conversationId },
          json: buildMailActionInput({
            actionId: nextActionId,
            sourceFolderId,
            destinationFolderId,
            correlationId,
            idempotencyKey,
          }),
        },
        { init: { signal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, `Could not ${getMailAction(nextActionId).label.toLocaleLowerCase()}`));
    },
    pruneSelection: (succeeded) => {
      const current = conversationSelection();
      const ids = new Set([...current.ids].filter((id) => !succeeded.has(id)));
      setConversationSelection({
        ids,
        anchorId: current.anchorId && !succeeded.has(current.anchorId) ? current.anchorId : null,
      });
      if (ids.size === 0) setSelectionMode(false);
    },
    removesActiveConversation: (nextActionId, succeeded) =>
      ["archive", "junk", "not_spam", "trash", "move"].includes(nextActionId) &&
      Boolean(data.selectedConversationId && succeeded.has(data.selectedConversationId)),
    refreshAfterSuccess: async ({ removesActiveConversation, succeededConversationIds }) => {
      const focusAfterRemoval = removesActiveConversation
        ? findMailFocusAfterRemoval({
            orderedConversationIds: orderedConversationIds(),
            activeConversationId: data.selectedConversationId,
            removedConversationIds: succeededConversationIds,
          })
        : null;
      const refreshError = await captureMailWorkspaceRefreshError(() =>
        removesActiveConversation
          ? requireMailWorkspaceRefresh(
              () => transitionWorkspaceHref(buildMailListHref(new URL(requestUrl())), true),
              "The action was queued, but this mailbox view could not be refreshed yet.",
            )
          : requireWorkspaceReconcile(),
      );
      if (!disposed && focusAfterRemoval && !refreshError) focusConversation(focusAfterRemoval, "row");
      if (refreshError) void prompts.error(refreshError.message, { title: "Action queued, refresh failed" });
    },
    reconcile: reconcileWorkspace,
    showMissingTarget: async () => {
      await prompts.error("Open the conversation from a mailbox folder, then try this action again.", {
        title: "Choose a folder first",
      });
    },
    showNothingToMove: () => toast("The selected conversations are already in this folder", { title: "Nothing to move" }),
    showSuccess: (nextActionId, targetCount, successCount) =>
      toast.success(
        targetCount === 1
          ? `${getMailAction(nextActionId).label} queued`
          : `${getMailAction(nextActionId).label} queued for ${successCount} conversations`,
      ),
    showFailures: async (failures, targetCount) => {
      await prompts.error(
        failures
          .slice(0, 5)
          .map(
            (failure) =>
              `${failure.label}: ${failure.message}${failure.submittedPlacements > 0 ? " (some placements were already queued)" : ""}`,
          )
          .join("\n"),
        { title: `${failures.length} of ${targetCount} conversations failed` },
      );
    },
    showError: async (error) => {
      await prompts.error(error instanceof Error ? error.message : "Could not update conversations");
    },
  } satisfies MailWorkspaceActionRunnerHost;
  const actionMutation = mutation.create<
    void,
    {
      actionId: MailActionId;
      options: MailWorkspaceActionOptions;
      execution: MailWorkspaceActionExecution;
    }
  >({
    mutation: ({ actionId, options, execution }, { abortSignal }) =>
      runMailWorkspaceAction(actionId, options, actionHost, abortSignal, execution),
  });
  actionMutationLoading = actionMutation.loading;
  const runAction = (actionId: MailActionId, options: MailWorkspaceActionOptions = {}) => {
    if (!canWrite() || actionPending() || disposed) return Promise.resolve();
    return actionMutation.mutate({
      actionId,
      options,
      execution: { correlationId: crypto.randomUUID(), idempotencyKeys: new Map() },
    });
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
      if (!response.ok) throw new Error(await readApiError(response, "Could not add tags"));
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
          ? "Selected conversations already had these tags"
          : `Tags added to ${result.updatedConversationIds.length} ${result.updatedConversationIds.length === 1 ? "conversation" : "conversations"}`,
      );
      if (refreshError) void prompts.error(refreshError.message, { title: "Tags added, refresh failed" });
    },
    onError: (error) => prompts.error(error.message),
  });
  const addTagsToSelection = () => {
    const conversationIds = [...selectedConversationIds()];
    if (!canWrite() || actionPending() || conversationIds.length === 0) return Promise.resolve();
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
      if (!response.ok) throw new Error(await readApiError(response, "Could not update tags"));
      const next = await response.json();
      if (abortSignal.aborted || disposed) return;
      applyConversationTags(next);
      toast.success("Tags updated");
    },
    onError: (error) => {
      void reconcileWorkspace()
        .catch(() => undefined)
        .then(() => {
          if (!disposed) return prompts.error(error.message, { title: "Conversation changed" });
        });
    },
  });
  const manageConversationTags = (item: MailListItem) => {
    if (!canWrite() || actionPending() || !item.conversationId) return Promise.resolve();
    return manageConversationTagsMutation.mutate(item);
  };

  structureMutationLoading = () =>
    mergeConversationMutation.loading() ||
    reassignMessageMutation.loading() ||
    splitMessageMutation.loading() ||
    addTagsMutation.loading() ||
    manageConversationTagsMutation.loading();
  onCleanup(() => {
    actionMutation.abort();
    mergeConversationMutation.abort();
    reassignMessageMutation.abort();
    splitMessageMutation.abort();
    addTagsMutation.abort();
    manageConversationTagsMutation.abort();
  });

  let consumedOpenIntent = -1;
  createEffect(() => {
    const intent = conversationOpenIntent();
    const pending = actionPending();
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

  const setDetailsVisible = (open: boolean) => {
    setDetailsOpen(open);
    persistPreferences();
    const frame = requestAnimationFrame(() => {
      focusFrames.delete(frame);
      if (disposed) return;
      const target = open
        ? document.querySelector<HTMLElement>("[data-mail-details-heading]")
        : document.querySelector<HTMLElement>("[data-mail-details-trigger]");
      target?.focus({ preventScroll: true });
    });
    focusFrames.add(frame);
  };

  return (
    <AppWorkspace>
      <MailSidebar
        mailboxId={data.mailbox.id}
        mailboxName={data.mailbox.name}
        syncEnabled={data.mailbox.syncEnabled}
        folders={data.folders}
        localTags={data.localTags}
        savedViews={data.savedViews}
        scheduledMode={data.scheduledMode}
        scheduledCount={data.scheduledCount}
        activeFolderId={data.folderId}
        activeView={data.query ? null : data.activeView}
        activeSavedViewId={data.savedViewId}
        activeTagId={activeTagId()}
        searchActive={activeSearch().expression !== null}
        viewCounts={data.viewCounts}
        canWrite={canWrite()}
        canAdmin={canAdmin()}
        managementOpening={managementOpening()}
        settingsOpening={settingsOpening()}
        onOpenHealth={() => void openHealth()}
        onOpenSharedLinks={() => void openSharedLinks()}
        onOpenRemoteContent={() => void openRemoteContent()}
        onOpenSubscriptions={() => void openSubscriptions()}
        onOpenSettings={() => void openSettings()}
        onMoveConversation={(input) =>
          runAction("move", {
            targets: [
              {
                conversationId: input.conversationId,
                label: "Conversation",
                sourceFolderIds: [input.sourceFolderId],
              },
            ],
            destinationFolderId: input.destinationFolderId,
          })
        }
        onNavigate={navigateWorkspace}
      />
      <AppWorkspace.Content>
        <AppWorkspace.Main class="p-0" aria-busy={routeLoading()} mobilePane={hasSelection() ? "main" : "conversations"} scroll={false}>
          <Show
            when={data.scheduledMode}
            fallback={
              <>
                <AppWorkspace.MainPane
                  id="conversations"
                  label="Conversation list"
                  scroll={false}
                  open={!listCollapsed() || !hasSelection()}
                  defaultSize={430}
                  minSize={300}
                  maxSize={620}
                >
                  <MailConversationList
                    mailbox={data.mailbox}
                    mailboxId={data.mailbox.id}
                    requestUrl={requestUrl()}
                    query={data.query}
                    title={data.listTitle}
                    items={data.listItems}
                    error={data.listError}
                    selectedConversationId={data.selectedConversationId}
                    selectedMessageId={data.selectedMessageId}
                    selectedConversationIds={selectedConversationIds()}
                    selectionMode={selectionMode()}
                    nextCursor={data.nextListCursor}
                    dateConfig={props.dateConfig}
                    canWrite={canWrite()}
                    canAdmin={canAdmin()}
                    junkFolderIds={data.folders.filter((folder) => folder.role === "junk").map((folder) => folder.id)}
                    savedViews={data.savedViews}
                    activeSavedViewId={data.savedViewId}
                    listMode={data.listMode}
                    loading={routeLoading()}
                    liveDegraded={liveDegraded()}
                    onCollapse={() => setCollapsed(true)}
                    onOpenHealth={() => void openHealth()}
                    onOpenDeliverySettings={() => void openSettings("delivery")}
                    onNavigate={navigateWorkspace}
                    onNavigateItem={navigateConversation}
                    onToggleSelectionMode={toggleConversationSelectionMode}
                    onListModeChange={updateListMode}
                    onToggleSelection={toggleConversationSelection}
                    onClearSelection={clearConversationSelection}
                    onAddTags={addTagsToSelection}
                    onBulkAction={runAction}
                    onItemAction={(item, actionId) => {
                      const target = actionTargetForItem(item, actionId);
                      if (target) void runAction(actionId, { targets: [target] });
                    }}
                    onManageTags={manageConversationTags}
                    onMergeItem={(item) => {
                      if (item.conversationId)
                        void mergeConversation({ conversationId: item.conversationId, revision: item.revision, subject: item.subject });
                    }}
                    onOpenHref={openWorkspaceHref}
                    onLoadMore={loadMoreConversations}
                  />
                </AppWorkspace.MainPane>
                <MailConversationReader
                  mailboxId={data.mailbox.id}
                  requestUrl={requestUrl()}
                  canWrite={canWrite()}
                  canAdmin={canAdmin()}
                  identities={data.identities}
                  selectionKey={data.selectedMessageId ?? data.selectedConversationId}
                  selectedConversationId={data.selectedConversationId}
                  selectedMessageId={data.selectedMessageId}
                  unread={selectedUnread()}
                  flagged={selectedFlagged()}
                  inJunk={selectedInJunk()}
                  reference={data.selectedReference}
                  subject={data.selectedSubject}
                  messages={data.detailMessages}
                  conversationSummary={data.conversationSummary}
                  conversationDrafts={data.conversationDrafts}
                  totalMessageCount={selectedListItem()?.messageCount ?? data.detailMessages.length}
                  error={data.detailError}
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
                  actionPending={actionPending()}
                  onAction={runAction}
                  onOpenHref={openWorkspaceHref}
                  onManageTags={() => {
                    const item = selectedListItem();
                    if (item) return manageConversationTags(item);
                  }}
                  onMergeConversation={mergeSelectedConversation}
                  onReassignMessage={reassignMessage}
                  onSplitMessage={splitMessage}
                  onSummarySaved={applySavedConversationSummary}
                  onReconcile={reconcileWorkspace}
                  onReconcileAfterWrite={requireWorkspaceReconcile}
                  onClose={closeConversation}
                />
              </>
            }
          >
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
          </Show>
        </AppWorkspace.Main>
        <AppWorkspace.Detail id="mail-context" open={detailsOpen() && canShowDetails()} width="lg" maxWidth={520}>
          <Show
            when={data.selectedConversationId && data.collaborationState && data.conversationLocalTags}
            fallback={
              <div class="flex h-full items-center justify-center p-4">
                <Placeholder
                  state={routeLoading() ? "loading" : "error"}
                  title={routeLoading() ? "Loading conversation details" : "Conversation details are unavailable"}
                  description={
                    routeLoading()
                      ? undefined
                      : (data.detailErrors.collaboration ??
                        data.detailErrors.tags ??
                        data.collaborationError ??
                        "Try refreshing this conversation.")
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
              initialState={data.collaborationState!}
              initialLocalTags={data.localTags}
              initialConversationLocalTags={data.conversationLocalTags!}
              initialComments={data.comments}
              initialCommentsCursor={data.commentsCursor}
              assignableUsers={data.assignableUsers}
              presence={presence().participants}
              activity={data.activity}
              initialReminder={data.reminder}
              detailErrors={data.detailErrors}
              conversationDrafts={data.conversationDrafts}
              messages={data.detailMessages}
              subject={data.selectedSubject}
              requestUrl={requestUrl()}
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
    </AppWorkspace>
  );
}
