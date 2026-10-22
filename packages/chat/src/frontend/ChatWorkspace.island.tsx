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
  IconButton,
  IconButtonLink,
  type MessageRowStatus,
  NoticeCard,
  Placeholder,
  prompts,
  toast,
  useLocale,
  type VirtualFeedController,
} from "@k2b/ui";
import { batch, createEffect, createMemo, createSignal, type JSX, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import type { z } from "zod";
import { chatMessages } from "../messages";
import { type ConversationPageSchema, type ConversationSchema, type MessagePageSchema, readStart } from "../service/contracts";
import { renderSystemMessage } from "../system-messages";
import { openAddPeopleDialog } from "./AddPeopleDialog";
import ChatConversation, { type ChatFeedItem } from "./ChatConversation";
import { openChatDetailsDialog } from "./ChatDetailsDialog";
import ChatInfoPanel from "./ChatInfoPanel";
import ChatList from "./ChatList";
import { chatDrafts } from "./chat-drafts";
import { createChatSends, createChatSendsApi } from "./chat-sends";
import { createChatStore, type OpenChat } from "./chat-store";
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
  const [draft, setDraft] = createSignal("");
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
      savedDrafts.write(id, text);
      unsavedDrafts.delete(id);
    } catch {
      setDraftStorageFailed(true);
    }
  };
  const retryDraftStorage = () => {
    try {
      savedDrafts = chatDrafts(props.viewerId, window.sessionStorage);
      for (const id of unsavedDrafts) {
        savedDrafts.write(id, drafts.get(id)!);
        unsavedDrafts.delete(id);
      }
      const id = route().chatId;
      if (id && !drafts.has(id)) drafts.set(id, savedDrafts.read(id));
      if (id) setDraft(drafts.get(id) ?? "");
      if (props.embedded) savedDrafts.select(id);
      setDraftStorageFailed(false);
    } catch {
      setDraftStorageFailed(true);
    }
  };
  const draftNotice = () => (
    <Show when={draftStorageFailed()}>
      <NoticeCard tone="danger" title={t().draftNotSaved} detail={t().draftNotSavedDescription}>
        <Button variant="ghost" onClick={retryDraftStorage}>
          {t().retry}
        </Button>
      </NoticeCard>
    </Show>
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
    return [...rows().filter((row) => !rank.has(row.id)), ...known];
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
    title ? { title: t().appName, href: basePath } : { title: t().appName },
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
  createEffect(on(trailTitle, (title) => layout.update({ breadcrumbs: breadcrumbs(title) }), { defer: true }));

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
    if ((await open({ chatId: id, messageId: null, panel: null })) === "applied")
      navigation.push(undefined, { scroll: "preserve", state: { chatFromList: fromList } });
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
    else if ((await open({ chatId: null, messageId: null, panel: null })) === "applied") navigation.push(undefined, { scroll: "preserve" });
  };

  const openInfo = (navigation?: LinkNavigateEvent) => {
    if (pendingOpen !== 0) return;
    const id = route().chatId;
    if (!id || !openChat() || panel() === "info") return;
    const messageId = route().messageId;
    setPanel("info");
    setRoute({ chatId: id, messageId, panel: "info" });
    const options = { scroll: "preserve" as const, state: { chatFromList: listDepth() === 1, chatInfoFromChat: true } };
    if (navigation) navigation.push(panelHref(id, "info", messageId), options);
    else navigate(panelHref(id, "info", messageId), options);
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
    if (navigation) navigation.push(panelHref(id, null, messageId), { scroll: "preserve" });
    else navigate(panelHref(id, null, messageId), { scroll: "preserve" });
  };

  /** A chat the person just started, or chose among existing ones, opens in place like a chat from the list. */
  const openChosen = async (id: string | undefined) => {
    if (!id) return;
    const fromList = route().chatId === null;
    if ((await open({ chatId: id, messageId: null, panel: null })) === "applied")
      navigate(panelHref(id, null), { scroll: "preserve", state: { chatFromList: fromList } });
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
      navigate(panelHref(current.id, null), { replace: true, scroll: "preserve" });
    }
  };

  const send = async (text: string): Promise<boolean> => {
    const current = openChat();
    if (!current || !outbox || !text.trim() || draftStorageFailed() || pendingOpen !== 0) return false;
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
    phone = window.matchMedia("(max-width: 47.999rem)");
    const live = createChatStore({
      viewerId: props.viewerId,
      cursor: props.cursor,
      sidebar: props.sidebar,
      ...(props.open ? { open: { conversation: props.open.conversation, page: props.open.page } } : {}),
    });
    store = live;
    setLiveStore(live);
    const sync = () => {
      prune();
      // The reader's own message moves its chat to the top: that is the reader's action, not a move under the pointer.
      const top = live.sidebar[0];
      const ownTop = top?.lastMessage?.author.id === props.viewerId && top.id === live.openConversation?.id && order()[0] !== top.id;
      setRows(live.sidebar);
      if (ownTop) sortRows();
      setHasMore(live.hasMoreSidebar);
      setChat(live.openConversation);
      if (live.openConversation?.status === "no-access") setPanel(null);
      setLiveStopped(live.liveStatus === "stopped");
    };
    onCleanup(live.subscribe(sync));
    sync();

    const box = createChatSends({ post: createChatSendsApi() });
    outbox = box;
    onCleanup(
      onPanelBeforeLeave(
        () => !box.unsent() && unsavedDrafts.size === 0 && !dialogCore.isOpen() && pendingOpen === 0 && pendingSends === 0,
      ),
    );
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
        void open(next).then((result) => {
          if (result === "failed") refreshCurrentPath();
          if (result === "blocked") {
            const current = route();
            navigate(current.chatId ? panelHref(current.chatId, current.panel, current.messageId) : basePath, {
              replace: true,
              scroll: "preserve",
            });
          }
        });
      }),
    );
    // The way up from a chat goes back to the list in place; a list opened before the chat is the previous entry.
    onCleanup(
      layout.handleUp((href) => {
        if (new URL(href, location.href).pathname !== basePath || !route().chatId) return false;
        const depth = listDepth();
        if (depth > 0) history.go(-depth);
        else void open({ chatId: null, messageId: null, panel: null }).then((result) => result === "applied" && navigate(basePath));
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

  const list = (): JSX.Element => (
    <ChatList
      basePath={basePath}
      rows={listRows()}
      activeId={openChat()?.id ?? null}
      viewerId={props.viewerId}
      dateConfig={props.dateConfig}
      now={now}
      hasMore={hasMore()}
      onOpen={openFromList}
      onMore={() => void store?.loadMoreSidebar()}
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

  return (
    <>
      <Show when={!openChat()}>{draftNotice()}</Show>
      <Show when={props.embedded && !openChat()}>
        <div class="flex shrink-0 justify-end p-1">
          <IconButtonLink
            href={route().chatId ? conversationHref(route().chatId!, null, route().messageId) : "/app/chat"}
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
            <AppWorkspace.SidebarBody scrollPreserveKey="chat-sidebar">
              <AppWorkspace.SidebarItem icon="ti ti-message-plus" onClick={() => void newChat()}>
                {t().newChat}
              </AppWorkspace.SidebarItem>
              <AppWorkspace.SidebarSection title={t().chats} actions={chatsActions()}>
                <Show when={listRows().length > 0} fallback={<Placeholder variant="inline" align="left" description={t().noneYet} />}>
                  {list()}
                </Show>
              </AppWorkspace.SidebarSection>
            </AppWorkspace.SidebarBody>
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
                        listHref={basePath}
                        actions={
                          <>
                            <Show when={props.embedded}>
                              <IconButtonLink
                                href={conversationHref(current().id, null, route().messageId)}
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
                              href={panelHref(current().id, panel() === "info" ? null : "info", route().messageId)}
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
                        memberCount={current().memberCount}
                        items={items()}
                        hasOlder={openChat()?.hasOlder ?? false}
                        hasNewer={openChat()?.hasNewer ?? false}
                        onLoadOlder={() => store?.loadOlder() ?? Promise.resolve(false)}
                        onLoadNewer={() => store?.loadNewer() ?? Promise.resolve(false)}
                        onLoadNewest={() => store?.loadLatest() ?? Promise.resolve()}
                        focusKey={focusKey()}
                        canWrite={composerReady() && !busy() && current().permission !== "read" && !draftStorageFailed()}
                        notice={draftNotice()}
                        hint={
                          current().permission === "read"
                            ? t().readOnly
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
              <Match when={rows().length === 0}>
                <Placeholder
                  variant="panel"
                  class="flex-1"
                  icon="ti ti-messages"
                  title={t().noChatsTitle}
                  description={t().noChatsDescription}
                  action={<Button onClick={() => void newChat()}>{t().newChat}</Button>}
                />
              </Match>
              <Match when={true}>
                <nav class="chat-list-page" aria-label={t().chats}>
                  <AppWorkspace.SidebarItem icon="ti ti-message-plus" onClick={() => void newChat()}>
                    {t().newChat}
                  </AppWorkspace.SidebarItem>
                  <AppWorkspace.SidebarSection title={t().chats} actions={chatsActions()}>
                    {list()}
                  </AppWorkspace.SidebarSection>
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
