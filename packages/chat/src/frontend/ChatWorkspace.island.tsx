import { onPanelBeforeLeave } from "@k2b/cloud/browser/panel";
import { layout } from "@k2b/cloud/ssr/layout-runtime";
import { type LinkNavigateEvent, listenPopState, navigate, refreshCurrentPath } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import {
  AppWorkspace,
  announce,
  Button,
  Dropdown,
  dialogCore,
  FilterToggle,
  IconButton,
  IconButtonLink,
  InlineGuidance,
  type MessageRowStatus,
  NoticeCard,
  Placeholder,
  prompts,
  ScrollArea,
  toast,
  useLocale,
  type VirtualFeedController,
} from "@k2b/ui";
import { batch, createEffect, createMemo, createSignal, type JSX, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import type { z } from "zod";
import { chatMessages } from "../messages";
import {
  type ConversationPageSchema,
  type ConversationSchema,
  MESSAGE_MAX_CODE_POINTS,
  MessageBodySchema,
  type MessagePageSchema,
  type PersonalConversationSchema,
  readStart,
  type SidebarPreferencesSchema,
} from "../service/contracts";
import { renderSystemMessage } from "../system-messages";
import { openAddPeopleDialog } from "./AddPeopleDialog";
import ChatConversation, { type ChatFeedItem } from "./ChatConversation";
import { openChatDetailsDialog } from "./ChatDetailsDialog";
import ChatInfoPanel from "./ChatInfoPanel";
import ChatList from "./ChatList";
import { ChatDraftConflict, chatDrafts } from "./chat-drafts";
import { createChatSends, createChatSendsApi } from "./chat-sends";
import { ChatRequestError, createChatStore, type OpenChat } from "./chat-store";
import { openLeaveChatDialog } from "./LeaveChatDialog";
import { openNewChatDialog } from "./NewChatDialog";
import { createReadReporter, seenRange } from "./read-reporter";
import { panelHref as conversationHref, parseRoute, type Route } from "./route";

type Conversation = z.infer<typeof ConversationSchema>;
type Store = ReturnType<typeof createChatStore>;
type Sends = ReturnType<typeof createChatSends>;

export type ChatWorkspaceProps = {
  /** The same workspace served without the Cloud shell in its provider route. */
  embedded?: boolean;
  archived?: boolean;
  filter?: "all" | "unread";
  collapsed?: z.infer<typeof SidebarPreferencesSchema>["collapsed"];
  /** The live cursor the server read before every part of this snapshot. */
  cursor: string;
  sidebar: z.infer<typeof ConversationPageSchema>;
  open: { conversation: Conversation; page: z.infer<typeof MessagePageSchema>; focus: string | null } | null;
  /** The chat in the address, also when the reader may not see it. */
  chatId: string | null;
  viewerId: string;
  guest: boolean;
  panel: "info" | null;
  dateConfig: DateContext;
  /** The server's clock, so relative day labels render the same on the server and in the browser. */
  now: string;
};

const initialChat = (open: NonNullable<ChatWorkspaceProps["open"]>): OpenChat => {
  const items = open.page.items;
  return {
    id: open.conversation.id,
    status: "live",
    conversation: open.conversation,
    messages: items,
    membershipRev: 0,
    watermark: open.page.rev,
    seqHead: open.page.seqHead,
    hasOlder: (items[0]?.seq ?? 1) > 1,
    hasNewer: (items.at(-1)?.seq ?? open.page.seqHead) < open.page.seqHead,
  };
};

/**
 * The chat app's full view: the chats in the sidebar and one open chat. The server renders the authorized snapshot;
 * in the browser one store keeps it live, and switching chats loads the next snapshot before the address changes.
 * Below 64 rem the list and a chat are separate pages.
 */
export default function ChatWorkspace(props: ChatWorkspaceProps): JSX.Element {
  const basePath = props.embedded ? "/app/chat/panel" : "/app/chat";
  const panelHref = (id: string, info: "info" | null, message?: string | null) => conversationHref(id, info, message, basePath);
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  const [route, setRoute] = createSignal<Route>({ chatId: props.chatId, messageId: props.open?.focus ?? null, panel: props.panel });
  const [archived, setArchived] = createSignal(props.archived ?? false);
  const [filter, setFilter] = createSignal(props.filter ?? "all");
  const [collapsed, setCollapsed] = createSignal(props.collapsed ?? []);
  const [listRetry, setListRetry] = createSignal<(() => void) | null>(null);
  const [listError, setListError] = createSignal<string | null>(null);
  const [listPending, setListPending] = createSignal(false);
  let collapsePending = false;
  const [listLoading, setListLoading] = createSignal(false);
  let activeListLoads = 0;
  const loadList = async <T,>(work: () => Promise<T>): Promise<T> => {
    setListLoading(++activeListLoads > 0);
    try {
      return await work();
    } finally {
      setListLoading(--activeListLoads > 0);
    }
  };
  const retainedUnread = new Set<string>();
  let listIntent = 0;
  let pendingListIntent: number | null = null;
  const listHref = (path = archived() ? `${basePath}/archive` : basePath) => {
    const url = new URL(path, "https://chat.invalid");
    if (filter() === "unread") url.searchParams.set("filter", "unread");
    if (archived() && url.pathname.includes("/c/")) url.searchParams.set("list", "archive");
    return url.pathname + url.search;
  };
  const [panel, setPanel] = createSignal<"info" | null>(props.panel);
  const [rows, setRows] = createSignal<readonly Conversation[]>(props.sidebar.items);
  const [hasMore, setHasMore] = createSignal(props.sidebar.nextCursor !== null);
  const [chat, setChat] = createSignal<OpenChat | null>(props.open ? initialChat(props.open) : null);
  const [liveStopped, setLiveStopped] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  // The latest open whose snapshot is still loading; an older one that a newer navigation superseded no longer counts.
  let openToken = 0;
  let pendingOpen = 0;
  let pendingSends = 0;
  // The outbox changes its entries in place; this counts its changes so the history reads them again.
  const [sendsVersion, setSendsVersion] = createSignal(0);
  // The list keeps its order while messages arrive elsewhere; it sorts again on the reader's own actions.
  const [order, setOrder] = createSignal<readonly string[]>(props.sidebar.items.map((row) => row.id));
  const [now, setNow] = createSignal(new Date(props.now));
  const drafts = new Map<string, string>();
  const savedTexts = new Map<string, string>();
  const [draftConflicts, setDraftConflicts] = createSignal<Record<string, string>>({});
  const [draft, setDraft] = createSignal("");
  const draftError = createMemo(() => {
    const body = draft();
    if (!body.trim() || MessageBodySchema.safeParse(body).success) return undefined;
    return body.includes("\u0000")
      ? t().messageInvalidCharacters
      : t().messageTooLong({ limit: MESSAGE_MAX_CODE_POINTS.toLocaleString(locale()) });
  });
  const [draftStorageFailed, setDraftStorageFailed] = createSignal(false);
  const [composerReady, setComposerReady] = createSignal(!props.embedded);
  const unsavedDrafts = new Set<string>();
  let savedDrafts: ReturnType<typeof chatDrafts> | undefined;
  const readDraft = (id: string) => {
    if (drafts.has(id)) return drafts.get(id)!;
    try {
      if (!savedDrafts) throw new Error("Draft storage unavailable");
      const text = savedDrafts.read(id);
      drafts.set(id, text);
      savedTexts.set(id, text);
      return text;
    } catch {
      setDraftStorageFailed(true);
      return "";
    }
  };
  const changeDraft = (text: string) => {
    const id = route().chatId;
    setDraft(text);
    if (!id) return;
    drafts.set(id, text);
    unsavedDrafts.add(id);
    try {
      if (!savedDrafts) throw new Error("Draft storage unavailable");
      savedDrafts.write(id, text, savedTexts.get(id) ?? "");
      savedTexts.set(id, text);
      unsavedDrafts.delete(id);
    } catch (error) {
      if (error instanceof ChatDraftConflict) setDraftConflicts((all) => ({ ...all, [id]: error.saved }));
      else setDraftStorageFailed(true);
    }
  };
  const retryDraftStorage = () => {
    try {
      savedDrafts = chatDrafts(props.viewerId, window.sessionStorage);
      for (const id of unsavedDrafts) {
        try {
          const text = drafts.get(id)!;
          savedDrafts.write(id, text, savedTexts.get(id) ?? "");
          savedTexts.set(id, text);
          unsavedDrafts.delete(id);
        } catch (error) {
          if (error instanceof ChatDraftConflict) setDraftConflicts((all) => ({ ...all, [id]: error.saved }));
          else throw error;
        }
      }
      const id = route().chatId;
      if (id && !drafts.has(id)) {
        const text = savedDrafts.read(id);
        drafts.set(id, text);
        savedTexts.set(id, text);
      }
      if (id) setDraft(drafts.get(id) ?? "");
      if (props.embedded) savedDrafts.select(id);
      setDraftStorageFailed(false);
    } catch {
      setDraftStorageFailed(true);
    }
  };
  const resolveDraftConflict = (id: string, useSaved: boolean) => {
    if (!savedDrafts) return;
    try {
      const expected = draftConflicts()[id];
      if (expected === undefined) return;
      const saved = savedDrafts.read(id);
      // A newer edit requires a fresh choice; never overwrite text absent from the displayed comparison.
      if (saved !== expected) {
        setDraftConflicts((all) => ({ ...all, [id]: saved }));
        return;
      }
      if (useSaved) {
        drafts.set(id, saved);
        savedTexts.set(id, saved);
        unsavedDrafts.delete(id);
        if (route().chatId === id) setDraft(saved);
      } else {
        const local = drafts.get(id) ?? "";
        savedDrafts.write(id, local, expected);
        savedTexts.set(id, local);
        unsavedDrafts.delete(id);
      }
      setDraftConflicts((all) => {
        const next = { ...all };
        delete next[id];
        return next;
      });
    } catch (error) {
      if (error instanceof ChatDraftConflict) setDraftConflicts((all) => ({ ...all, [id]: error.saved }));
      else setDraftStorageFailed(true);
    }
  };
  const draftNotice = () => (
    <>
      <Show when={draftStorageFailed()}>
        <NoticeCard tone="danger" title={t().draftNotSaved} detail={t().draftNotSavedDescription}>
          <Button variant="ghost" onClick={retryDraftStorage}>
            {t().retry}
          </Button>
        </NoticeCard>
      </Show>
      <Show when={route().chatId && draftConflicts()[route().chatId!] !== undefined}>
        <NoticeCard tone="warning" title={t().draftChangedElsewhere} detail={t().draftChangedElsewhereDescription}>
          <pre class="max-h-32 overflow-auto whitespace-pre-wrap">{draftConflicts()[route().chatId!]}</pre>
          <Button variant="secondary" onClick={() => resolveDraftConflict(route().chatId!, true)}>
            {t().useSavedDraft}
          </Button>
          <Button variant="ghost" onClick={() => resolveDraftConflict(route().chatId!, false)}>
            {t().keepLocalDraft}
          </Button>
        </NoticeCard>
      </Show>
    </>
  );
  // A stored message keeps the key of the send it came from, so its row is not replaced when it arrives.
  const sendKeys = new Map<string, string>();
  let store: Store | undefined;
  // The same store as `store`, for the info panel, which renders before the store exists and loads once it does.
  const [liveStore, setLiveStore] = createSignal<Store>();
  const [localBumps, setLocalBumps] = createSignal(0);
  let outbox: Sends | undefined;
  let feed: VirtualFeedController | undefined;

  const sortRows = () => setOrder(rows().map((row) => row.id));
  const listRows = createMemo(() => {
    const rank = new Map(order().map((id, index) => [id, index]));
    const known = rows()
      .filter((row) => rank.has(row.id))
      .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    const ordered = [...rows().filter((row) => !rank.has(row.id)), ...known];
    if (filter() !== "unread") return ordered;
    return ordered.filter((row) => {
      if (row.unread > 0 || row.read?.unreadFromSeq != null) retainedUnread.add(row.id);
      return retainedUnread.has(row.id);
    });
  });
  // The store may hold the next chat a moment before the address names it; the chat it holds is what shows.
  const openChat = () => {
    const current = chat();
    return current && current.status !== "no-access" && current.conversation ? current : null;
  };
  const conversation = () => openChat()?.conversation ?? null;
  const noAccess = () => route().chatId !== null && openChat() === null;
  const breadcrumbs = (title?: string) => [
    { title: t().start, href: "/" },
    title ? { title: t().appName, href: listHref(archived() ? `${basePath}/archive` : basePath) } : { title: t().appName },
    ...(title ? [{ title }] : []),
  ];
  // The trail names the chat in the address. It follows live renames and lost access, and keeps its last title while
  // the store already holds the next chat but the address does not name it yet.
  const trailTitle = createMemo<string | undefined>((previous) => {
    const id = route().chatId;
    if (!id) return undefined;
    if (chat()?.id !== id) return previous;
    return conversation()?.title ?? t().noAccessTitle;
  });
  createEffect(
    on(
      () => [trailTitle(), archived(), filter()] as const,
      ([title]) => layout.update({ breadcrumbs: breadcrumbs(title) }),
      { defer: true },
    ),
  );

  // A sent message the loaded history covers leaves the outbox; its stored row keeps the send's key.
  const prune = () => {
    const current = store?.openConversation;
    if (!current || current.status === "no-access" || !outbox) return;
    const lastSeq = current.messages.at(-1)?.seq ?? 0;
    for (const send of outbox.sends(current.id)) {
      if (!send.message) continue;
      sendKeys.set(send.message.id, send.clientId);
      if (send.status === "sent" && send.message.seq <= lastSeq) outbox.forget(send.clientId);
    }
  };

  const items = createMemo<readonly ChatFeedItem[]>((previous) => {
    const current = openChat();
    if (!current) return [];
    const cache = new Map(previous?.map((item) => [item.key, item]));
    sendsVersion();
    const own = outbox?.sends(current.id) ?? [];
    const stored = new Set(current.messages.map((message) => message.id));
    const reuse = (item: ChatFeedItem) => {
      const known = cache.get(item.key);
      return known && known.body === item.body && known.status === item.status && known.at === item.at && known.seq === item.seq
        ? known
        : item;
    };
    const result = current.messages.map((message) => {
      const own = message.kind === "text" && message.author.id === props.viewerId;
      return reuse({
        key: sendKeys.get(message.id) ?? message.id,
        kind: message.kind,
        authorId: message.author.id,
        authorName: own ? t().you : message.author.name,
        body: message.system ? renderSystemMessage(message.system, message.author.name, locale()) : (message.body ?? ""),
        at: message.createdAt,
        own,
        status: own ? "sent" : undefined,
        seq: message.seq,
        messageId: message.id,
      });
    });
    // Sends wait at the end of the newest history; a window further back shows them once the reader is there.
    if (!current.hasNewer) {
      const lastSeq = current.messages.at(-1)?.seq ?? 0;
      for (const send of own) {
        if (send.message && stored.has(send.message.id)) continue;
        if (send.status === "sent" && (!send.message || send.message.seq <= lastSeq)) continue;
        const status: MessageRowStatus = send.status;
        result.push(
          reuse({
            key: send.clientId,
            kind: "text",
            authorId: props.viewerId,
            authorName: t().you,
            body: send.body,
            at: send.message?.createdAt ?? send.createdAt,
            own: true,
            status,
            ...(status === "failed" ? { retry: () => outbox?.retry(send.clientId), discard: () => outbox?.forget(send.clientId) } : {}),
          }),
        );
      }
    }
    return result;
  });
  // A send that was not sent holds back the later ones of its chat until it is retried or discarded.
  const waiting = () => {
    const current = openChat();
    sendsVersion();
    return current ? outbox?.sends(current.id).find((send) => send.status !== "sent")?.status === "failed" : false;
  };
  const focusKey = () => {
    const id = route().messageId;
    return id ? (sendKeys.get(id) ?? id) : null;
  };

  // "New messages" stands above the first message from others after the read position as the chat opened, and stays
  // there until the reader leaves the chat, also while the read position moves on.
  const [marker, setMarker] = createSignal<string | null>(null);
  // Reports what the reader sees in the open chat. After the reader marks it unread, nothing is reported until they
  // leave it, so the mark is not read away at once.
  let reporter: { chatId: string; reporter: ReturnType<typeof createReadReporter> } | undefined;
  let paused = false;
  let phone: MediaQueryList | undefined;
  const reading = () =>
    Boolean(phone) && document.visibilityState === "visible" && document.hasFocus() && !(panel() === "info" && phone?.matches);
  // Per chat, not per change of the open chat.
  const openId = createMemo(() => openChat()?.id ?? null);
  createEffect(
    on(openId, (id) => {
      const current = openChat();
      const start = readStart(current?.conversation?.read ?? null);
      const first =
        start === null || !current || (current.hasOlder && (current.messages[0]?.seq ?? Infinity) > start + 1)
          ? undefined
          : current?.messages.find((message) => message.seq > start && message.kind === "text" && message.author.id !== props.viewerId);
      setMarker(first?.id ?? null);
      reporter?.reporter.dispose();
      reporter = undefined;
      paused = false;
      if (!id || start === null) return;
      reporter = {
        chatId: id,
        reporter: createReadReporter({
          start,
          active: reading,
          post: (seq) => (paused ? Promise.resolve() : store ? store.markRead(id, seq) : Promise.reject(new Error("Chat is not live yet"))),
        }),
      };
    }),
  );
  createEffect(() => {
    const current = openChat();
    const start = readStart(current?.conversation?.read ?? null);
    if (current && start !== null && reporter?.chatId === current.id) reporter.reporter.setStart(start);
  });
  const reportVisible = (visible: { first: ChatFeedItem; last: ChatFeedItem } | null) => {
    if (!visible) return;
    const list = items();
    const range = seenRange(
      list,
      list.findIndex((item) => item.key === visible.first.key),
      list.findIndex((item) => item.key === visible.last.key),
    );
    if (range) reporter?.reporter.seen(range.first, range.last);
  };
  const changeRead = async (work: () => Promise<unknown> | undefined) => {
    try {
      await work();
      return true;
    } catch {
      toast.error(t().readStateFailed);
      return false;
    }
  };
  // The server stops at the newest message, so the largest position marks the whole chat read.
  const markRead = (id: string) => void changeRead(() => store?.markRead(id, Number.MAX_SAFE_INTEGER));
  const markUnread = async (id: string, from?: ChatFeedItem) => {
    const open = openChat()?.id === id;
    if (open) paused = true;
    // Let earlier reads finish before the server applies the unread mark.
    if (open && reporter?.chatId === id) await reporter.reporter.settled();
    if (from) setMarker(from.key);
    if (!(await changeRead(() => store?.markUnread(id, from?.messageId))) && open) paused = false;
  };
  const markOpenRead = () => {
    const current = openChat();
    if (!current) return;
    paused = false;
    setMarker(null);
    announce(t().markedRead);
    void changeRead(() => store?.markRead(current.id, current.seqHead));
  };
  const readAll = async () => {
    const live = store;
    if (!live) return;
    await changeRead(async () => {
      let result = await live.readAll(false);
      if (result.outcome === "confirm") {
        const confirmed = await prompts.confirm(t().markAllReadDescription, {
          title: t().markAllReadTitle,
          icon: "ti ti-checks",
          confirmText: t().markAllRead,
        });
        if (!confirmed) return;
        result = await live.readAll(true);
      }
      // Each request marks one bounded batch; the server says whether more chats wait.
      while (result.outcome === "done" && result.more) result = await live.readAll(true);
    });
  };

  const applyListUrl = (url: URL, refresh = false) =>
    loadList(async () => {
      const token = ++listIntent;
      const nextArchived = url.pathname === `${basePath}/archive` || url.searchParams.get("list") === "archive";
      const nextFilter = url.searchParams.get("filter") === "unread" ? "unread" : "all";
      // A newer intent must also undo a pending request whose target has not reached the signals yet.
      const changed = nextArchived !== archived() || nextFilter !== filter();
      const reload = refresh || pendingListIntent !== null || changed;
      pendingListIntent = token;
      try {
        if (reload) await store?.showArchive(nextArchived, nextFilter === "unread", !changed ? [...retainedUnread] : []);
        if (token !== listIntent) return null;
        if (reload) {
          if (changed) retainedUnread.clear();
          setArchived(nextArchived);
          sortRows();
        }
        setFilter(nextFilter);
        return token;
      } catch (error) {
        if (token !== listIntent) return null;
        throw error;
      } finally {
        if (pendingListIntent === token) pendingListIntent = null;
      }
    });
  const changeList = async (next: "all" | "unread" | "archive") => {
    if (!store || listLoading() || listPending()) return;
    if (next === "archive" && pendingSends > 0) {
      toast(t().sendPreparing);
      return;
    }
    if ((!archived() && filter() === next) || (next === "archive" && archived() && filter() === "all" && !route().chatId)) return;
    setListError(null);
    const path =
      next === "archive"
        ? `${basePath}/archive`
        : next === "unread" && archived()
          ? `${basePath}/archive${filter() === "unread" ? "" : "?filter=unread"}`
          : `${basePath}${next === "unread" ? "?filter=unread" : ""}`;
    const url = new URL(path, location.href);
    try {
      const token = await applyListUrl(url);
      if (token === null) return;
      const current = route();
      const target =
        next !== "archive" && current.chatId
          ? listHref(panelHref(current.chatId, current.panel, current.messageId))
          : url.pathname + url.search;
      if (next === "archive" && (await open({ chatId: null, messageId: null, panel: null })) !== "applied") return;
      if (token === listIntent) navigate(target, { scroll: "preserve" });
    } catch {
      setListError(t().listFailed);
      setListRetry(() => () => void changeList(next));
    }
  };
  const refreshList = async (path = location.pathname + location.search) => {
    if (!store) return;
    try {
      if ((await applyListUrl(new URL(path, location.href), true)) === null) return;
      sortRows();
      setListError(null);
      setListRetry(null);
    } catch {
      setListError(t().listFailed);
      setListRetry(() => () => void refreshList());
    }
  };
  const personal = async (id: string, patch: z.infer<typeof PersonalConversationSchema>) => {
    if (!store) return;
    if (listPending()) {
      toast(t().savingList);
      return;
    }
    setListPending(true);
    setListError(null);
    setListRetry(null);
    try {
      await store.personal(id, patch);
      sortRows();
    } catch (error) {
      if (error instanceof ChatRequestError && error.status === 400) {
        setListError(t().pinPositionChanged);
        setListRetry(() => () => void refreshList());
      } else {
        setListError(t().personalFailed);
        setListRetry(() => () => void personal(id, patch));
      }
    } finally {
      setListPending(false);
    }
  };
  const collapse = async (section: z.infer<typeof SidebarPreferencesSchema>["collapsed"][number], isOpen: boolean) => {
    if (!store) return;
    if (listPending()) {
      toast(t().savingList);
      return;
    }
    setListPending(true);
    setListError(null);
    collapsePending = true;
    const previous = collapsed();
    const next = isOpen ? collapsed().filter((value) => value !== section) : [...new Set([...collapsed(), section])];
    setCollapsed(next);
    try {
      const saved = await store.savePreferences(next);
      setCollapsed(saved.collapsed);
    } catch {
      setCollapsed(previous);
      setListError(t().personalFailed);
      setListRetry(() => () => void collapse(section, isOpen));
    } finally {
      collapsePending = false;
      setCollapsed(store.collapsed);
      setListPending(false);
    }
  };
  const more = async () => {
    const live = store;
    if (!live || listLoading()) return;
    setListError(null);
    try {
      await loadList(async () => {
        const previous = listRows().map((row) => row.id);
        await live.loadMoreSidebar();
        setOrder([
          ...previous,
          ...rows()
            .map((row) => row.id)
            .filter((id) => !previous.includes(id)),
        ]);
      });
    } catch {
      setListError(t().listFailed);
      setListRetry(() => () => void more());
    }
  };
  const applyRoute = (next: Route) => {
    setRoute(next);
    setPanel(next.panel);
    setDraft(next.chatId ? readDraft(next.chatId) : "");
    setNow(new Date());
    sortRows();
    if (props.embedded) {
      try {
        if (!savedDrafts) throw new Error("Draft storage unavailable");
        savedDrafts.select(next.chatId);
      } catch {
        setDraftStorageFailed(true);
      }
    }
  };
  /** Loads the chat's snapshot before the address changes; only an applied open may change it. */
  const open = async (next: Route): Promise<"applied" | "superseded" | "failed" | "blocked"> => {
    if (!store) return "failed";
    if (pendingSends > 0 && next.chatId !== route().chatId) {
      toast(t().sendPreparing);
      return "blocked";
    }
    if (pendingOpen === 0 && route().chatId === next.chatId && route().messageId === next.messageId && route().panel !== next.panel) {
      setRoute(next);
      setPanel(openChat() ? next.panel : null);
      return "applied";
    }
    if (!next.chatId) {
      const live = store;
      // Closing the chat supersedes a pending open.
      pendingOpen = 0;
      setBusy(false);
      batch(() => {
        live.closeConversation();
        applyRoute(next);
      });
      return "applied";
    }
    const token = ++openToken;
    pendingOpen = token;
    setBusy(true);
    try {
      const result = await store.openChat(next.chatId, next.messageId ?? undefined);
      if (result.status === "superseded") return "superseded";
      applyRoute({
        chatId: next.chatId,
        messageId: result.status === "opened" ? next.messageId : null,
        panel: result.status === "opened" ? next.panel : null,
      });
      return "applied";
    } catch {
      toast.error(t().openFailed);
      return "failed";
    } finally {
      if (pendingOpen === token) {
        pendingOpen = 0;
        setBusy(false);
      }
    }
  };
  const openFromList = async (id: string, navigation: LinkNavigateEvent) => {
    const fromList = route().chatId === null;
    if ((await open({ chatId: id, messageId: null, panel: null })) !== "applied") return;
    const target = listHref(panelHref(id, null));
    if (location.pathname + location.search !== target) navigation.push(target, { scroll: "preserve", state: { chatFromList: fromList } });
    // A row navigation keeps its visible list context even if an older mode request is still pending.
    if (pendingListIntent !== null) await refreshList(target);
  };

  // Info adds one entry above a chat opened from the list.
  const listDepth = () => {
    const state: unknown = history.state;
    if (!state || typeof state !== "object" || !("chatFromList" in state) || state.chatFromList !== true) return 0;
    return "chatInfoFromChat" in state && state.chatInfoFromChat === true ? 2 : 1;
  };
  const backToList = async (navigation: LinkNavigateEvent) => {
    const depth = listDepth();
    if (depth > 0) history.go(-depth);
    else if ((await open({ chatId: null, messageId: null, panel: null })) === "applied")
      navigation.push(listHref(archived() ? `${basePath}/archive` : basePath), { scroll: "preserve" });
  };

  const openInfo = (navigation?: LinkNavigateEvent) => {
    if (pendingOpen !== 0) return;
    const id = route().chatId;
    if (!id || !openChat() || panel() === "info") return;
    const messageId = route().messageId;
    setPanel("info");
    setRoute({ chatId: id, messageId, panel: "info" });
    const options = { scroll: "preserve" as const, state: { chatFromList: listDepth() === 1, chatInfoFromChat: true } };
    if (navigation) navigation.push(listHref(panelHref(id, "info", messageId)), options);
    else navigate(listHref(panelHref(id, "info", messageId)), options);
  };
  const infoFromChat = () => {
    const state: unknown = history.state;
    return !!state && typeof state === "object" && "chatInfoFromChat" in state && state.chatInfoFromChat === true;
  };
  const closeInfo = (navigation?: LinkNavigateEvent) => {
    if (pendingOpen !== 0) return;
    const id = route().chatId;
    if (!id || panel() === null) return;
    if (infoFromChat()) {
      history.back();
      return;
    }
    const messageId = route().messageId;
    setPanel(null);
    setRoute({ chatId: id, messageId, panel: null });
    if (navigation) navigation.push(listHref(panelHref(id, null, messageId)), { scroll: "preserve" });
    else navigate(listHref(panelHref(id, null, messageId)), { scroll: "preserve" });
  };

  /** A chat the person just started, or chose among existing ones, opens in place like a chat from the list. */
  const openChosen = async (id: string | undefined) => {
    if (!id) return;
    const fromList = route().chatId === null;
    if ((await open({ chatId: id, messageId: null, panel: null })) !== "applied") return;
    const chosen = store?.openConversation?.conversation;
    const listPath = chosen?.archived ? `${basePath}/archive` : basePath;
    const target = new URL(panelHref(id, null), location.href);
    if (chosen?.archived) target.searchParams.set("list", "archive");
    // The chat has opened successfully. A failed list refresh must not leave the address naming the previous chat.
    navigate(target.pathname + target.search, { scroll: "preserve", state: { chatFromList: fromList } });
    await refreshList(listPath);
  };
  const newChat = async () => {
    if (!store) return;
    await openChosen(
      await openNewChatDialog({ store, guest: props.guest, viewerId: props.viewerId, dateConfig: props.dateConfig, locale: locale() }),
    );
  };
  // The dialogs only offer what the viewer may do; the server decides every request again.
  const addPeople = async () => {
    const current = conversation();
    if (!store || current?.permission !== "admin") return;
    await openChosen(
      await openAddPeopleDialog({
        store,
        conversation: current,
        guest: props.guest,
        viewerId: props.viewerId,
        locale: locale(),
        onAdded: () => setLocalBumps((revision) => revision + 1),
      }),
    );
  };
  const editDetails = () => {
    const current = conversation();
    if (store && current && current.permission !== "read") void openChatDetailsDialog({ store, conversation: current, locale: locale() });
  };
  const leaveChat = async () => {
    const current = conversation();
    if (!store || !current) return;
    if (!(await openLeaveChatDialog({ store, conversation: current, viewerId: props.viewerId, locale: locale() }))) return;
    // The chat now shows "No access"; its address drops the panel that went with it. Info opened from the chat goes
    // back to the chat's own entry, so one Back press still leaves the chat.
    if (route().chatId === current.id && infoFromChat()) {
      history.back();
      return;
    }
    setPanel(null);
    if (route().chatId === current.id) {
      setRoute({ chatId: current.id, messageId: null, panel: null });
      navigate(listHref(panelHref(current.id, null)), { replace: true, scroll: "preserve" });
    }
  };

  const send = async (text: string): Promise<boolean> => {
    const current = openChat();
    if (
      !current ||
      !outbox ||
      !MessageBodySchema.safeParse(text).success ||
      draftStorageFailed() ||
      draftConflicts()[current.id] !== undefined ||
      pendingOpen !== 0
    )
      return false;
    // The composer has cleared its draft, but the outbox does not own it until history is ready.
    pendingSends++;
    try {
      if (current.hasNewer) await store?.loadLatest();
      outbox.send(current.id, text);
      feed?.scrollToEnd();
      return true;
    } finally {
      pendingSends--;
    }
  };

  onMount(() => {
    try {
      savedDrafts = chatDrafts(props.viewerId, window.sessionStorage);
    } catch {
      setDraftStorageFailed(true);
    }
    if (route().chatId) setDraft(readDraft(route().chatId!));
    const storageChanged = (event: StorageEvent) => {
      if (!savedDrafts) return;
      try {
        if (event.storageArea !== window.sessionStorage) return;
        for (const id of drafts.keys()) {
          if (event.key !== null && event.key !== savedDrafts.key(id)) continue;
          const text = savedDrafts.read(id);
          if (unsavedDrafts.has(id)) {
            if (text !== savedTexts.get(id)) setDraftConflicts((all) => ({ ...all, [id]: text }));
            continue;
          }
          drafts.set(id, text);
          savedTexts.set(id, text);
          if (route().chatId === id) setDraft(text);
        }
      } catch {
        setDraftStorageFailed(true);
      }
    };
    window.addEventListener("storage", storageChanged);
    onCleanup(() => window.removeEventListener("storage", storageChanged));
    phone = window.matchMedia("(max-width: 47.999rem)");
    const live = createChatStore({
      viewerId: props.viewerId,
      cursor: props.cursor,
      sidebar: props.sidebar,
      archived: props.archived,
      unread: props.filter === "unread",
      collapsed: props.collapsed,
      ...(props.open ? { open: { conversation: props.open.conversation, page: props.open.page } } : {}),
    });
    store = live;
    setLiveStore(live);
    const sync = () => {
      const focused = document.activeElement;
      prune();
      // The reader's own message moves its chat to the top: that is the reader's action, not a move under the pointer.
      const top = live.sidebar.find((row) => row.pinnedRank === null);
      const firstUnpinned = order().find((id) => live.sidebar.some((row) => row.id === id && row.pinnedRank === null));
      const ownTop = top?.lastMessage?.author.id === props.viewerId && top.id === live.openConversation?.id && firstUnpinned !== top.id;
      if (!collapsePending) setCollapsed(live.collapsed);
      setRows(live.sidebar);
      if (ownTop) sortRows();
      setHasMore(live.hasMoreSidebar);
      setChat(live.openConversation);
      if (live.openConversation?.status === "no-access") setPanel(null);
      setLiveStopped(live.liveStatus === "stopped");
      // Moving a keyed pin with insertBefore can blur its handle or menu trigger in the browser.
      if (
        focused instanceof HTMLElement &&
        focused.isConnected &&
        focused.closest(".chat-list-pins") &&
        document.activeElement === document.body
      ) {
        // The blur hides hover actions, so reveal them through the row's visible link before restoring its control.
        focused.closest(".k2b-app-workspace__sidebar-item")?.querySelector<HTMLAnchorElement>("a[href]")?.focus({ preventScroll: true });
        focused.focus({ preventScroll: true });
      }
    };
    onCleanup(live.subscribe(sync));
    sync();

    const box = createChatSends({ post: createChatSendsApi() });
    outbox = box;
    onCleanup(onPanelBeforeLeave(() => !box.unsent() && unsavedDrafts.size === 0 && !dialogCore.isOpen() && pendingSends === 0));
    setComposerReady(true);
    const leave = (event: BeforeUnloadEvent) => {
      if (box.unsent() || unsavedDrafts.size > 0 || pendingSends > 0) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", leave);
    onCleanup(() => window.removeEventListener("beforeunload", leave));
    const failed = new Set<string>();
    onCleanup(
      box.subscribe(() => {
        prune();
        const current = route().chatId;
        for (const entry of current ? box.sends(current) : []) {
          if (entry.status === "failed" && !failed.has(entry.clientId)) announce(t().messageNotSent);
          if (entry.status === "failed") failed.add(entry.clientId);
          else failed.delete(entry.clientId);
        }
        setSendsVersion((version) => version + 1);
      }),
    );

    onCleanup(
      listenPopState(({ url }) => {
        const next = parseRoute(url);
        if (!next) return;
        // The browser already shows the new address; when its chat cannot load in place, the server renders it.
        void applyListUrl(url)
          .then((token) => (token === null ? "superseded" : open(next)))
          .then((result) => {
            if (result === "failed") refreshCurrentPath();
            if (result === "blocked") {
              const current = route();
              navigate(listHref(current.chatId ? panelHref(current.chatId, current.panel, current.messageId) : undefined), {
                replace: true,
                scroll: "preserve",
              });
            }
          })
          .catch(() => refreshCurrentPath());
      }),
    );
    // The way up from a chat goes back to the list in place; a list opened before the chat is the previous entry.
    onCleanup(
      layout.handleUp((href) => {
        if (![basePath, `${basePath}/archive`].includes(new URL(href, location.href).pathname) || !route().chatId) return false;
        const depth = listDepth();
        if (depth > 0) history.go(-depth);
        else
          void open({ chatId: null, messageId: null, panel: null }).then(
            (result) => result === "applied" && navigate(listHref(archived() ? `${basePath}/archive` : basePath)),
          );
        return true;
      }),
    );
    const activate = () => reporter?.reporter.activate();
    createEffect(on(panel, activate));
    phone.addEventListener("change", activate);
    document.addEventListener("visibilitychange", activate);
    window.addEventListener("focus", activate);
    onCleanup(() => {
      phone?.removeEventListener("change", activate);
      document.removeEventListener("visibilitychange", activate);
      window.removeEventListener("focus", activate);
      reporter?.reporter.dispose();
      box.dispose();
      live.dispose();
    });
    if (props.embedded) {
      try {
        const selected = props.chatId ?? savedDrafts?.selection();
        if (props.chatId) savedDrafts?.select(props.chatId);
        else if (selected) {
          void open({ chatId: selected, messageId: null, panel: null }).then((result) => {
            if (result === "applied") navigate(panelHref(selected, null), { replace: true, scroll: "manual" });
          });
        }
      } catch {
        setDraftStorageFailed(true);
      }
    }
  });

  const pinnedRows = () =>
    listRows()
      .filter((row) => row.pinnedRank !== null)
      .sort((a, b) => a.pinnedRank! - b.pinnedRank!);
  const reorder = (id: string, direction: "up" | "down") => {
    const pins = pinnedRows();
    const neighbor = pins[pins.findIndex((row) => row.id === id) + (direction === "up" ? -1 : 1)];
    if (neighbor) void personal(id, { pinned: true, ...(direction === "up" ? { before: neighbor.id } : { after: neighbor.id }) });
  };
  const list = (entries: () => readonly Conversation[], pinned = false): JSX.Element => (
    <ChatList
      rows={entries()}
      href={(id) => listHref(panelHref(id, null))}
      activeId={openChat()?.id ?? null}
      viewerId={props.viewerId}
      dateConfig={props.dateConfig}
      now={now}
      hasMore={false}
      onOpen={openFromList}
      onMore={() => void more()}
      pending={listPending() || listLoading()}
      onPersonal={(id, patch) => void personal(id, patch)}
      onReorder={pinned ? reorder : undefined}
      onMarkRead={markRead}
      onMarkUnread={(id) => void markUnread(id)}
    />
  );
  const chatsActions = () => (
    <Dropdown.Root position="bottom-right" items={[{ label: t().markAllRead, icon: "ti ti-checks", action: () => void readAll() }]}>
      <Dropdown.Trigger iconOnly label={t().chatsActions} tooltip={t().chatsActions} size="xs">
        <i class="ti ti-dots text-xs" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );

  const archiveLink = () => (
    <AppWorkspace.SidebarItem
      href={`${basePath}/archive`}
      navigation="enhanced"
      active={archived()}
      icon="ti ti-archive"
      onNavigate={() => void changeList("archive")}
    >
      {t().archive}
    </AppWorkspace.SidebarItem>
  );
  const listContent = (includeArchive = true) => (
    <>
      <AppWorkspace.SidebarItem icon="ti ti-message-plus" onClick={() => void newChat()}>
        {t().newChat}
      </AppWorkspace.SidebarItem>
      <div class="chat-list-filters" role="group" aria-label={t().chats}>
        <FilterToggle
          label={t().allChats}
          icon="ti ti-messages"
          active={!archived() && filter() === "all"}
          disabled={listLoading() || listPending()}
          onClick={() => void changeList("all")}
        />
        <FilterToggle
          label={t().unreadChats}
          icon="ti ti-mail"
          active={filter() === "unread"}
          disabled={listLoading() || listPending()}
          onClick={() => void changeList("unread")}
        />
      </div>
      <div class="chat-list-feedback">
        <p role="status" aria-live="polite" class="chat-list-status">
          {!listError() && (listLoading() ? t().loadingChats : listPending() ? t().savingList : "")}
        </p>
        <Show when={listError()}>
          {(error) => (
            <InlineGuidance role="alert" tone="danger" class="chat-list-error">
              {error()}
              <Show when={listRetry()}>
                <Button size="sm" variant="ghost" disabled={listPending() || listLoading()} onClick={() => listRetry()?.()}>
                  {t().retry}
                </Button>
              </Show>
            </InlineGuidance>
          )}
        </Show>
      </div>
      <Show
        when={archived()}
        fallback={
          <>
            <Show when={pinnedRows().length > 0}>
              <AppWorkspace.SidebarSection
                title={t().pinnedChats}
                collapsible
                open={!collapsed().includes("pinned")}
                onOpenChange={(open) => void collapse("pinned", open)}
              >
                <ScrollArea class="chat-list-pins" scrollPreserveKey="chat-pins">
                  {list(pinnedRows, true)}
                </ScrollArea>
              </AppWorkspace.SidebarSection>
            </Show>
            <AppWorkspace.SidebarSection
              title={t().chats}
              actions={chatsActions()}
              collapsible
              open={!collapsed().includes("chats")}
              onOpenChange={(open) => void collapse("chats", open)}
            >
              <Show
                when={listRows().some((row) => row.pinnedRank === null)}
                fallback={
                  <Show when={!hasMore() && !listLoading() && listRows().length === 0}>
                    <Placeholder variant="inline" align="left" description={filter() === "unread" ? t().noUnreadChats : t().noneYet} />
                  </Show>
                }
              >
                {list(() => listRows().filter((row) => row.pinnedRank === null))}
              </Show>
            </AppWorkspace.SidebarSection>
          </>
        }
      >
        <AppWorkspace.SidebarSection title={t().archive}>
          <Show when={listRows().length > 0} fallback={<Placeholder variant="inline" align="left" description={t().archiveEmpty} />}>
            {list(listRows)}
          </Show>
        </AppWorkspace.SidebarSection>
      </Show>
      <Show when={hasMore()}>
        <AppWorkspace.SidebarItem disabled={listLoading() || listPending()} icon="ti ti-dots" onClick={() => void more()}>
          {t().showMoreChats}
        </AppWorkspace.SidebarItem>
      </Show>
      <Show when={includeArchive}>{archiveLink()}</Show>
    </>
  );
  return (
    <>
      <Show when={!openChat()}>{draftNotice()}</Show>
      <Show when={props.embedded && !openChat()}>
        <div class="flex shrink-0 justify-end p-1">
          <IconButtonLink
            href={listHref(
              route().chatId ? conversationHref(route().chatId!, null, route().messageId) : archived() ? "/app/chat/archive" : "/app/chat",
            )}
            target={composerReady() ? undefined : "_top"}
            label={t().openFullView}
          >
            <i class="ti ti-arrows-maximize" aria-hidden="true" />
          </IconButtonLink>
        </div>
      </Show>
      <AppWorkspace mobileSurface="flush" class={`chat-workspace ${props.embedded ? "flex-1 min-h-0" : "h-full"}`}>
        <AppWorkspace.Sidebar label={t().chats}>
          <AppWorkspace.SidebarDesktop>
            <AppWorkspace.SidebarBody scrollPreserveKey="chat-sidebar">{listContent(false)}</AppWorkspace.SidebarBody>
            <AppWorkspace.SidebarFooter>{archiveLink()}</AppWorkspace.SidebarFooter>
          </AppWorkspace.SidebarDesktop>
        </AppWorkspace.Sidebar>
        <AppWorkspace.Content>
          <AppWorkspace.Main scroll={false} aria-busy={busy()}>
            <Switch>
              <Match when={openChat()?.id}>
                {/* One history per chat: a new chat starts at its end or its linked message, never at the last chat's place. */}
                <Show when={openChat()?.id} keyed>
                  <Show when={conversation()}>
                    {(current) => (
                      <ChatConversation
                        actions={
                          <>
                            <Show when={props.embedded}>
                              <IconButtonLink
                                href={listHref(conversationHref(current().id, null, route().messageId))}
                                target={composerReady() ? undefined : "_top"}
                                label={t().openFullView}
                              >
                                <i class="ti ti-arrows-maximize" aria-hidden="true" />
                              </IconButtonLink>
                            </Show>
                            <Show when={current().permission === "admin"}>
                              <IconButton label={t().addPeople} variant="ghost" onClick={() => void addPeople()}>
                                <i class="ti ti-user-plus" aria-hidden="true" />
                              </IconButton>
                            </Show>
                            <IconButtonLink
                              label={t().chatInfo}
                              href={listHref(panelHref(current().id, panel() === "info" ? null : "info", route().messageId))}
                              navigation="enhanced"
                              onNavigate={(navigation) => (panel() === "info" ? closeInfo(navigation) : openInfo(navigation))}
                              aria-expanded={panel() === "info"}
                              aria-controls="k2b-workspace-detail-chat-info"
                            >
                              <i class="ti ti-info-circle" aria-hidden="true" />
                            </IconButtonLink>
                          </>
                        }
                        chatId={current().id}
                        title={current().title}
                        listHref={listHref(archived() ? `${basePath}/archive` : basePath)}
                        memberCount={current().memberCount}
                        items={items()}
                        hasOlder={openChat()?.hasOlder ?? false}
                        hasNewer={openChat()?.hasNewer ?? false}
                        onLoadOlder={() => store?.loadOlder() ?? Promise.resolve(false)}
                        onLoadNewer={() => store?.loadNewer() ?? Promise.resolve(false)}
                        onLoadNewest={() => store?.loadLatest() ?? Promise.resolve()}
                        focusKey={focusKey()}
                        canWrite={
                          composerReady() &&
                          !busy() &&
                          current().permission !== "read" &&
                          !draftStorageFailed() &&
                          draftConflicts()[current().id] === undefined
                        }
                        notice={draftNotice()}
                        hint={
                          current().permission === "read"
                            ? t().readOnly
                            : draftError()
                              ? draftError()
                              : liveStopped()
                                ? t().liveStopped
                                : waiting()
                                  ? t().messagesWaiting
                                  : undefined
                        }
                        draft={draft()}
                        onDraftChange={changeDraft}
                        onSend={send}
                        onBack={backToList}
                        busy={busy()}
                        dateConfig={props.dateConfig}
                        now={now}
                        controller={(controller) => {
                          feed = controller;
                        }}
                        markerKey={marker()}
                        onVisibleChange={reportVisible}
                        onMarkUnreadFrom={(item) => void markUnread(current().id, item)}
                        // With the info open, Esc closes it first; the workspace owns that.
                        onEscape={() => panel() === null && markOpenRead()}
                      />
                    )}
                  </Show>
                </Show>
              </Match>
              <Match when={noAccess()}>
                <Placeholder
                  variant="panel"
                  class="flex-1"
                  icon="ti ti-lock"
                  title={t().noAccessTitle}
                  description={t().noAccessDescription}
                />
              </Match>
              <Match when={rows().length === 0 && !archived() && filter() === "all"}>
                <nav class="chat-list-page" aria-label={t().chats}>
                  {listContent()}
                </nav>
                <div class="chat-select">
                  <Placeholder
                    variant="panel"
                    class="flex-1"
                    icon="ti ti-messages"
                    title={t().noChatsTitle}
                    description={t().noChatsDescription}
                    action={<Button onClick={() => void newChat()}>{t().newChat}</Button>}
                  />
                </div>
              </Match>
              <Match when={true}>
                <nav class="chat-list-page" aria-label={t().chats}>
                  {listContent()}
                </nav>
                <div class="chat-select">
                  <Placeholder
                    variant="panel"
                    class="flex-1"
                    icon="ti ti-messages"
                    title={t().selectChatTitle}
                    description={t().selectChatDescription}
                  />
                </div>
              </Match>
            </Switch>
          </AppWorkspace.Main>
          <AppWorkspace.Detail
            id="chat-info"
            phone="page"
            width="md"
            open={panel() === "info" && conversation() !== null}
            onClose={() => closeInfo()}
          >
            {/* One panel per chat, like its history: search and loaded members never carry over to the next chat. */}
            <Show when={openChat()?.id} keyed>
              <Show when={conversation()}>
                {(current) => (
                  <ChatInfoPanel
                    conversation={current()}
                    viewerId={props.viewerId}
                    active={panel() === "info"}
                    revision={(openChat()?.membershipRev ?? 0) + localBumps()}
                    store={liveStore()}
                    onClose={() => closeInfo()}
                    onAddPeople={() => void addPeople()}
                    onEditDetails={editDetails}
                    onLeave={() => void leaveChat()}
                  />
                )}
              </Show>
            </Show>
          </AppWorkspace.Detail>
        </AppWorkspace.Content>
      </AppWorkspace>
    </>
  );
}
