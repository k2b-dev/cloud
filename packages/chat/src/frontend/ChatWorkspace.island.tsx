import { layout } from "@k2b/cloud/ssr/layout-runtime";
import { type LinkNavigateEvent, listenPopState, navigate, refreshCurrentPath } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { clipboard } from "@k2b/stdlib/browser";
import {
  AppWorkspace,
  announce,
  Button,
  Dropdown,
  IconButton,
  IconButtonLink,
  type MessageRowStatus,
  Placeholder,
  prompts,
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
  type MessageSchema,
  type ReadUpdateSchema,
  type ThreadListSchema,
} from "../service/contracts";
import { renderSystemMessage } from "../system-messages";
import { openAddPeopleDialog } from "./AddPeopleDialog";
import ChatConversation, { type ChatFeedItem } from "./ChatConversation";
import { openChatDetailsDialog } from "./ChatDetailsDialog";
import ChatInfoPanel from "./ChatInfoPanel";
import ChatList from "./ChatList";
import ChatThreadColumn from "./ChatThreadColumn";
import { ThreadMenu, ThreadPicker } from "./ChatThreads";
import ChatThreadsPage from "./ChatThreadsPage";
import { createChatSends, createChatSendsApi } from "./chat-sends";
import { createChatStore, type OpenChat } from "./chat-store";
import { openLeaveChatDialog } from "./LeaveChatDialog";
import { openNewChatDialog } from "./NewChatDialog";
import { createReadReporter, seenRange } from "./read-reporter";
import { panelHref, parseRoute, type Route, threadsPageHref } from "./route";
import { openThreadDialog } from "./ThreadDialog";
import { chatHasThreads, isUnread, messageThread, type ThreadView, threadHref, threadOf, viewName, viewReadStart } from "./threads";

type ReadUpdate = z.infer<typeof ReadUpdateSchema>;

type Conversation = z.infer<typeof ConversationSchema>;
type Message = z.infer<typeof MessageSchema>;
type Store = ReturnType<typeof createChatStore>;
type Sends = ReturnType<typeof createChatSends>;

export type ChatWorkspaceProps = {
  /** The live cursor the server read before every part of this snapshot. */
  cursor: string;
  sidebar: z.infer<typeof ConversationPageSchema>;
  open: {
    conversation: Conversation;
    page: z.infer<typeof MessagePageSchema>;
    threads: z.infer<typeof ThreadListSchema>;
    focus: string | null;
  } | null;
  /** The chat in the address, also when the reader may not see it. */
  chatId: string | null;
  /** The open part of the chat: "all", "general", or a thread's ID. */
  view: ThreadView;
  /** The phone's page with the chat's threads. */
  threadsPage: boolean;
  viewerId: string;
  guest: boolean;
  panel: "info" | null;
  dateConfig: DateContext;
  /** The server's clock, so relative day labels render the same on the server and in the browser. */
  now: string;
};

const initialChat = (open: NonNullable<ChatWorkspaceProps["open"]>, view: ThreadView): OpenChat => ({
  id: open.conversation.id,
  view,
  threads: open.threads,
  threadsStatus: "ready",
  status: "live",
  conversation: open.conversation,
  messages: open.page.items,
  membershipRev: 0,
  watermark: open.page.rev,
  seqHead: open.page.seqHead,
  hasOlder: open.page.from > 1,
  hasNewer: open.page.to < open.page.seqHead,
});
const chatRoute = (chatId: string | null, view: ThreadView = "all", extra: Partial<Route> = {}): Route => ({
  chatId,
  view,
  threads: false,
  messageId: null,
  panel: null,
  ...extra,
});

/**
 * The chat app's full view: the chats in the sidebar and one open chat. The server renders the authorized snapshot;
 * in the browser one store keeps it live, and switching chats loads the next snapshot before the address changes.
 * Below 64 rem the list and a chat are separate pages.
 */
export default function ChatWorkspace(props: ChatWorkspaceProps): JSX.Element {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  const [route, setRoute] = createSignal<Route>({
    chatId: props.chatId,
    view: props.view,
    threads: props.threadsPage,
    messageId: props.open?.focus ?? null,
    panel: props.panel,
  });
  const [panel, setPanel] = createSignal<"info" | null>(props.panel);
  const [rows, setRows] = createSignal<readonly Conversation[]>(props.sidebar.items);
  const [hasMore, setHasMore] = createSignal(props.sidebar.nextCursor !== null);
  const [chat, setChat] = createSignal<OpenChat | null>(props.open ? initialChat(props.open, props.view) : null);
  const [liveStopped, setLiveStopped] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  // The latest open whose snapshot is still loading; an older one that a newer navigation superseded no longer counts.
  let openToken = 0;
  let pendingOpen = 0;
  // The outbox changes its entries in place; this counts its changes so the history reads them again.
  const [sendsVersion, setSendsVersion] = createSignal(0);
  // The list keeps its order while messages arrive elsewhere; it sorts again on the reader's own actions.
  const [order, setOrder] = createSignal<readonly string[]>(props.sidebar.items.map((row) => row.id));
  const [now, setNow] = createSignal(new Date(props.now));
  const drafts = new Map<string, string>();
  const [draft, setDraft] = createSignal("");
  const draftError = createMemo(() => {
    const body = draft();
    if (!body.trim() || MessageBodySchema.safeParse(body).success) return undefined;
    return body.includes("\u0000")
      ? t().messageInvalidCharacters
      : t().messageTooLong({ limit: MESSAGE_MAX_CODE_POINTS.toLocaleString(locale()) });
  });
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
    title ? { title: t().appName, href: "/app/chat" } : { title: t().appName },
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

  // A quote names its original; a click jumps to it, in the history or, when it is not loaded, around it.
  const quoteOf = (chatId: string, message: Message) => {
    const reply = message.replyTo;
    if (!reply) return undefined;
    if ("deleted" in reply) return { author: "", text: t().quotedDeleted };
    return {
      author: reply.author.id === props.viewerId ? t().you : reply.author.name,
      text: reply.preview,
      onSelect: () => void jumpTo(chatId, reply.id),
    };
  };
  // In "All threads", a chip under each message names its thread and opens it.
  const originOf = (chatId: string, view: ThreadView) => {
    const name = viewName(view, openChat()?.threads ?? null, t());
    if (!name) return undefined;
    return {
      label: name,
      icon: view === "general" ? "ti ti-messages" : "ti ti-hash",
      selectLabel: t().openThread({ name }),
      onSelect: () => void openView(chatId, view),
    };
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
      return known &&
        known.body === item.body &&
        known.status === item.status &&
        known.at === item.at &&
        known.seq === item.seq &&
        known.origin?.label === item.origin?.label &&
        known.quote?.text === item.quote?.text
        ? known
        : item;
    };
    const view = current.view;
    // In "All threads", every message names its thread from its first frame, also a send that is still on its way.
    const mixed = view === "all" && current.threads !== null && chatHasThreads(current.conversation);
    const result = current.messages.map((message) => {
      const own = message.kind === "text" && message.author.id === props.viewerId;
      return reuse({
        thread: message.thread,
        quote: quoteOf(current.id, message),
        origin: mixed && message.kind === "text" ? originOf(current.id, messageThread(message)) : undefined,
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
        if (view !== "all" && send.thread !== view) continue;
        if (send.message && stored.has(send.message.id)) continue;
        if (send.status === "sent" && (!send.message || send.message.seq <= lastSeq)) continue;
        const status: MessageRowStatus = send.status;
        result.push(
          reuse({
            key: send.clientId,
            kind: "text",
            thread: send.thread === "general" ? null : send.thread,
            origin: mixed ? originOf(current.id, send.thread) : undefined,
            quote: send.replyTo ? { author: send.replyTo.author, text: send.replyTo.text } : undefined,
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
  // Per open part of a chat: each thread has its own read state and its own "New messages".
  const openKey = createMemo(() => {
    const current = openChat();
    return current ? `${current.id}:${current.view}` : null;
  });
  createEffect(
    on(openKey, (key) => {
      const current = openChat();
      const read = current?.conversation?.read ?? null;
      const start = current ? viewReadStart(current.view, read, current.threads) : null;
      const first =
        start === null || !current || (current.hasOlder && (current.messages[0]?.seq ?? Infinity) > start + 1)
          ? undefined
          : current.messages.find((message) => isUnread(message, props.viewerId, read, current.threads));
      setMarker(first?.id ?? null);
      reporter?.reporter.dispose();
      reporter = undefined;
      paused = false;
      if (!key || !current || start === null) return;
      const id = current.id;
      const view = current.view;
      reporter = {
        chatId: id,
        reporter: createReadReporter({
          start,
          active: reading,
          // "All threads" reads every thread up to what the reader saw; a thread only itself.
          post: (seq) =>
            paused ? Promise.resolve() : store ? store.markRead(id, seq, view) : Promise.reject(new Error("Chat is not live yet")),
        }),
      };
    }),
  );
  createEffect(() => {
    const current = openChat();
    const start = current ? viewReadStart(current.view, current.conversation?.read ?? null, current.threads) : null;
    if (current && start !== null && reporter?.chatId === current.id) reporter.reporter.setStart(start);
  });
  const reportVisible = (visible: { first: ChatFeedItem; last: ChatFeedItem } | null) => {
    if (!visible) return;
    const list = items();
    const range = seenRange(
      list,
      list.findIndex((item) => item.key === visible.first.key),
      list.findIndex((item) => item.key === visible.last.key),
      openChat()?.hasOlder ?? true,
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
  const markRead = (id: string) => void changeRead(() => store?.markRead(id, Number.MAX_SAFE_INTEGER, "all"));
  const markUnread = async (id: string, from?: ChatFeedItem) => {
    const open = openChat()?.id === id;
    if (!from) {
      if (open) paused = true;
      if (open && reporter?.chatId === id) await reporter.reporter.settled();
      if (!(await changeRead(() => store?.markUnread(id))) && open) paused = false;
      return;
    }
    // "Mark unread from here" in the open chat: the marker moves at once, a failure puts everything back. Every step
    // after an await checks that the chat is still open, so a late answer or a retry from another chat never moves
    // the marker of the chat on screen.
    const isOpen = () => openChat()?.id === id;
    const wasPaused = paused;
    if (open) paused = true;
    // Let earlier reads finish before the server applies the unread mark, so Undo starts from their state.
    if (open && reporter?.chatId === id) await reporter.reporter.settled();
    // Each thread has its own boundary; Undo restores the one of the message's thread.
    const thread = from.thread ?? null;
    const boundary = () =>
      thread === null
        ? (conversation()?.read?.unreadFromSeq ?? null)
        : (threadOf(openChat()?.threads ?? null, thread)?.read?.unreadFromSeq ?? null);
    const before = isOpen()
      ? { marker: marker(), unreadFrom: boundary(), paused: wasPaused, thread }
      : { marker: null, unreadFrom: null, paused: false, thread, closed: true as const };
    if (isOpen()) setMarker(from.key);
    let result: ReadUpdate | undefined;
    try {
      result = await store?.markUnread(id, from.messageId);
    } catch {
      if (isOpen() && !("closed" in before)) {
        setMarker(before.marker);
        paused = before.paused;
      }
      // An action answers once: its message closes, so a second press cannot repeat it.
      const failed = toast.error(t().readStateFailed, {
        action: {
          label: t().retry,
          onClick: () => {
            failed.dismiss();
            void markUnread(id, from);
          },
        },
      });
      return;
    }
    const done = toast(t().markedUnreadFrom({ name: from.authorName.split(" ")[0] ?? from.authorName }), {
      iconClass: "ti ti-mail",
      action: {
        label: t().undo,
        onClick: () => {
          done.dismiss();
          void undoUnread(id, {
            ...before,
            lastReadSeq:
              thread === null ? (result?.lastReadSeq ?? null) : (result?.threads.find((entry) => entry.id === thread)?.lastReadSeq ?? null),
          });
        },
      },
    });
  };
  // Undo puts back the read state from before "Mark unread from here": a boundary that existed is set again, found
  // through the server when its message is not loaded; otherwise the chat is read up to where it was.
  const undoUnread = async (
    id: string,
    before: {
      marker: string | null;
      unreadFrom: number | null;
      paused: boolean;
      thread: string | null;
      lastReadSeq: number | null;
      closed?: true;
    },
  ) => {
    const restored = await changeRead(async () => {
      if (before.unreadFrom === null) return store?.markRead(id, before.lastReadSeq ?? Number.MAX_SAFE_INTEGER, before.thread ?? "general");
      const message = await store?.messageAt(id, before.unreadFrom);
      if (!message) throw new Error("The earlier unread boundary is gone");
      return store?.markUnread(id, message);
    });
    if (!restored || openChat()?.id !== id || before.closed) return;
    setMarker(before.marker);
    paused = before.paused;
  };
  const copy = (item: ChatFeedItem) =>
    void clipboard.copy(item.body).then(
      () => announce(t().copied),
      () => toast.error(t().copyFailed),
    );
  const markOpenRead = () => {
    const current = openChat();
    if (!current) return;
    paused = false;
    setMarker(null);
    announce(t().markedRead);
    void changeRead(() => store?.markRead(current.id, current.seqHead, current.view));
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

  // Each part of a chat keeps its own draft and its own reply.
  const draftKey = (target: Pick<Route, "chatId" | "view">) => (target.chatId ? `${target.chatId}:${target.view}` : null);
  const applyRoute = (next: Route) => {
    const previous = draftKey(route());
    if (previous) {
      drafts.set(previous, draft());
      replies.set(previous, reply());
    }
    setRoute(next);
    setPanel(next.panel);
    const key = draftKey(next);
    setDraft(key ? (drafts.get(key) ?? "") : "");
    setReply(key ? (replies.get(key) ?? null) : null);
    setNow(new Date());
    sortRows();
  };
  /** Loads the chat's snapshot before the address changes; only an applied open may change it. */
  const open = async (next: Route): Promise<"applied" | "superseded" | "failed"> => {
    if (!store) return "failed";
    if (
      pendingOpen === 0 &&
      route().chatId === next.chatId &&
      route().view === next.view &&
      route().threads === next.threads &&
      route().messageId === next.messageId &&
      route().panel !== next.panel
    ) {
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
      const result = await store.openChat(next.chatId, next.messageId ?? undefined, next.view);
      if (result.status === "superseded") return "superseded";
      applyRoute({
        ...next,
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
    // A phone shows a chat with threads as its page of threads first; a wider window opens "All threads" and its rows.
    const row = rows().find((candidate) => candidate.id === id);
    if (phone?.matches && chatHasThreads(row)) {
      if ((await open(chatRoute(id, "all", { threads: true }))) === "applied")
        navigation.push(threadsPageHref(id), { scroll: "preserve", state: { chatFromList: fromList } });
      return;
    }
    if ((await open(chatRoute(id))) === "applied") navigation.push(undefined, { scroll: "preserve", state: { chatFromList: fromList } });
  };
  /** Opens another part of the open chat, from the list, the picker, a thread chip, or a new thread. */
  const openView = async (id: string, view: ThreadView, navigation?: LinkNavigateEvent, message?: string) => {
    // From the phone's page of threads, "Back" in the thread returns to that page in the history; from Info opened
    // on top of it, the previous entry is Info, so "Back" opens the page instead.
    const options = { scroll: "preserve" as const, state: { threadFromPage: route().threads && route().panel === null } };
    const next = chatRoute(id, view, { messageId: message ?? null });
    if ((await open(next)) !== "applied") return;
    const href = threadHref(id, view, message);
    if (navigation) navigation.push(href, options);
    else navigate(href, options);
  };
  /** A quote's original: in the loaded history it is highlighted in place, otherwise the chat opens around it. */
  const jumpTo = async (id: string, message: string) => {
    const key = sendKeys.get(message) ?? message;
    if (openChat()?.id === id && feed?.scrollToKey(key, { highlight: true })) return;
    // A quote lies in the reply's own thread, so the open view holds it once the history around it is loaded.
    await openView(id, openChat()?.view ?? "all", undefined, message);
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
    else if ((await open(chatRoute(null))) === "applied") navigation.push(undefined, { scroll: "preserve" });
  };
  const backToThreads = async (navigation: LinkNavigateEvent) => {
    const state: unknown = history.state;
    const id = route().chatId;
    if (state && typeof state === "object" && "threadFromPage" in state && state.threadFromPage === true) history.back();
    else if (id && (await open(chatRoute(id, route().view, { threads: true }))) === "applied")
      navigation.push(undefined, { scroll: "preserve" });
  };

  const openInfo = (navigation?: LinkNavigateEvent) => {
    if (pendingOpen !== 0) return;
    const id = route().chatId;
    if (!id || !openChat() || panel() === "info") return;
    const messageId = route().messageId;
    setPanel("info");
    setRoute({ ...route(), chatId: id, messageId, panel: "info" });
    const options = { scroll: "preserve" as const, state: { chatFromList: listDepth() === 1, chatInfoFromChat: true } };
    if (navigation) navigation.push(panelHref(id, "info", messageId, route().view), options);
    else navigate(panelHref(id, "info", messageId, route().view), options);
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
    setRoute({ ...route(), chatId: id, messageId, panel: null });
    if (navigation) navigation.push(panelHref(id, null, messageId, route().view), { scroll: "preserve" });
    else navigate(panelHref(id, null, messageId, route().view), { scroll: "preserve" });
  };

  /** A chat the person just started, or chose among existing ones, opens in place like a chat from the list. */
  const openChosen = async (id: string | undefined) => {
    if (!id) return;
    const fromList = route().chatId === null;
    if ((await open(chatRoute(id))) === "applied") navigate(panelHref(id, null), { scroll: "preserve", state: { chatFromList: fromList } });
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
      setRoute(chatRoute(current.id));
      navigate(panelHref(current.id, null), { replace: true, scroll: "preserve" });
    }
  };

  // Admins create, rename, archive, and restore threads; the server decides every request again.
  const createThread = async () => {
    const current = conversation();
    if (!store || current?.permission !== "admin") return;
    const thread = await openThreadDialog({
      store,
      chatId: current.id,
      title: current.title,
      memberCount: current.memberCount,
      threads: openChat()?.threads ?? null,
      locale: locale(),
    });
    if (!thread) return;
    toast(t().threadCreated({ name: thread.name }));
    await openView(current.id, thread.id);
  };
  const renameThread = async () => {
    const current = openChat();
    const thread = threadOf(current?.threads ?? null, current?.view);
    if (!store || !current?.conversation || !thread) return;
    const renamed = await openThreadDialog({
      store,
      chatId: current.id,
      title: current.conversation.title,
      memberCount: current.conversation.memberCount,
      threads: current.threads,
      thread,
      locale: locale(),
    });
    if (renamed && renamed.name !== thread.name) toast(t().threadRenamed({ name: renamed.name }));
  };
  const setArchived = async (id: string, threadId: string, archived: boolean) => {
    try {
      await store?.updateThread(id, threadId, { archived });
      return true;
    } catch {
      toast.error(archived ? t().archiveFailed : t().restoreFailed);
      return false;
    }
  };
  const archiveThread = async () => {
    const current = openChat();
    const thread = threadOf(current?.threads ?? null, current?.view);
    if (!current || !thread) return;
    const confirmed = await prompts.confirm(t().archiveConfirmText, {
      title: t().archiveConfirmTitle({ name: thread.name }),
      icon: "ti ti-archive",
      confirmText: t().archive,
    });
    if (!confirmed || !(await setArchived(current.id, thread.id, true))) return;
    // The archived thread stays readable under "Archived"; the reader continues in General.
    await openView(current.id, "general");
    const done = toast(t().threadArchivedToast({ name: thread.name }), {
      iconClass: "ti ti-archive",
      action: {
        label: t().undo,
        onClick: () => {
          done.dismiss();
          void setArchived(current.id, thread.id, false).then(async (restored) => {
            if (restored) await openView(current.id, thread.id);
          });
        },
      },
    });
  };
  const restoreThread = async () => {
    const current = openChat();
    const thread = threadOf(current?.threads ?? null, current?.view);
    if (current && thread && (await setArchived(current.id, thread.id, false))) toast(t().restored);
  };

  // A message goes to the open thread; in "All threads" to General. A reply goes to its original's thread.
  const [reply, setReply] = createSignal<ChatFeedItem | null>(null);
  const replies = new Map<string, ChatFeedItem | null>();
  const send = async (text: string): Promise<boolean> => {
    const current = openChat();
    if (!current || !outbox || !MessageBodySchema.safeParse(text).success) return false;
    if (current.hasNewer) await store?.loadLatest();
    const answered = reply();
    const thread = answered ? (answered.thread ?? "general") : current.view === "all" ? "general" : current.view;
    outbox.send(current.id, text, {
      thread,
      replyTo: answered?.messageId ? { id: answered.messageId, author: answered.authorName, text: answered.body } : null,
    });
    setReply(null);
    feed?.scrollToEnd();
    return true;
  };

  onMount(() => {
    phone = window.matchMedia("(max-width: 47.999rem)");
    const live = createChatStore({
      viewerId: props.viewerId,
      cursor: props.cursor,
      sidebar: props.sidebar,
      ...(props.open
        ? { open: { conversation: props.open.conversation, page: props.open.page, threads: props.open.threads, view: props.view } }
        : {}),
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
    const leave = (event: BeforeUnloadEvent) => {
      if (box.unsent()) {
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
        });
      }),
    );
    // The way up from a chat goes back to the list in place; a list opened before the chat is the previous entry.
    onCleanup(
      layout.handleUp((href) => {
        if (new URL(href, location.href).pathname !== "/app/chat" || !route().chatId) return false;
        const depth = listDepth();
        if (depth > 0) history.go(-depth);
        else void open(chatRoute(null)).then((result) => result === "applied" && navigate("/app/chat"));
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
  });

  const list = (): JSX.Element => (
    <ChatList
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
      threads={
        openChat() && chatHasThreads(conversation())
          ? {
              threads: openChat()?.threads ?? null,
              status: openChat()?.threadsStatus ?? "loading",
              view: route().threads ? null : (openChat()?.view ?? null),
              canAdmin: conversation()?.permission === "admin",
              onNavigate: (view, navigation) => {
                const id = openChat()?.id;
                return id ? openView(id, view, navigation) : undefined;
              },
              onCreate: () => void createThread(),
              onRetry: () => void store?.refreshThreads(),
            }
          : undefined
      }
    />
  );
  /** The open part of the chat, as the head names it and the composer addresses it. */
  const viewTitle = () => viewName(openChat()?.view ?? "all", openChat()?.threads ?? null, t());
  const openThread = () => threadOf(openChat()?.threads ?? null, openChat()?.view);
  const threaded = () => chatHasThreads(conversation());
  // Where the reader cannot write, a quiet line replaces the composer and names why.
  const notice = (): JSX.Element | undefined => {
    const current = conversation();
    if (!current) return undefined;
    if (openThread()?.archived)
      return (
        <>
          <i class="ti ti-archive" aria-hidden="true" />
          <span>{t().archivedNotice}</span>
          <Show when={current.permission === "admin"}>
            <Button size="sm" variant="ghost" onClick={() => void restoreThread()}>
              {t().restore}
            </Button>
          </Show>
        </>
      );
    if (current.permission === "read")
      return (
        <>
          <i class="ti ti-eye" aria-hidden="true" />
          <span>{t().readOnlyIn({ title: current.title })}</span>
        </>
      );
    return undefined;
  };
  const placeholder = () => {
    const current = conversation();
    if (!current) return undefined;
    const answered = reply();
    if (answered)
      return openChat()?.view === "all" && threaded()
        ? t().replyIn({ name: viewName(answered.thread ?? "general", openChat()?.threads ?? null, t()) })
        : t().replyPlaceholder;
    if (!threaded()) return t().composerPlaceholder({ title: current.title });
    return t().composerPlaceholder({ title: openChat()?.view === "all" ? t().general : viewTitle() });
  };
  const replyHint = (item: ChatFeedItem) =>
    !threaded()
      ? t().replyHintPlain
      : openChat()?.view === "all"
        ? t().replyHintIn({ name: viewName(item.thread ?? "general", openChat()?.threads ?? null, t()) })
        : t().replyHint;
  const unreadHint = (item: ChatFeedItem) =>
    threaded()
      ? t().markUnreadThreadHint({ name: viewName(item.thread ?? "general", openChat()?.threads ?? null, t()) })
      : t().markUnreadFromHereHint;
  const infoLink = (current: Conversation) => (
    <IconButtonLink
      label={t().chatInfo}
      href={panelHref(current.id, panel() === "info" ? null : "info", route().messageId, route().view)}
      navigation="enhanced"
      onNavigate={(navigation) => (panel() === "info" ? closeInfo(navigation) : openInfo(navigation))}
      aria-expanded={panel() === "info"}
      aria-controls="k2b-workspace-detail-chat-info"
    >
      <i class="ti ti-info-circle" aria-hidden="true" />
    </IconButtonLink>
  );
  const chatsActions = () => (
    <Dropdown.Root position="bottom-right" items={[{ label: t().markAllRead, icon: "ti ti-checks", action: () => void readAll() }]}>
      <Dropdown.Trigger iconOnly label={t().chatsActions} tooltip={t().chatsActions} size="xs">
        <i class="ti ti-dots text-xs" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );

  return (
    <AppWorkspace mobileSurface="flush" class="chat-workspace h-full">
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
        <AppWorkspace.Main
          scroll={false}
          aria-busy={busy()}
          class={threaded() && !route().threads ? "chat-main chat-main--threads" : "chat-main"}
        >
          {/* From a 1800 px window, a chat with threads shows them in a column of their own; CSS decides, so the server
              render and the first frame agree, and crossing the width moves nothing in the reading column. The pane
              stays in place for every chat, because a pane that appears later would take the conversation with it. */}
          <AppWorkspace.MainPane
            id="chat-threads"
            label={t().threadsIn({ title: conversation()?.title ?? "" })}
            class="chat-thread-pane"
            defaultSize={336}
            minSize={288}
            maxSize={480}
            scroll={false}
          >
            <Show when={threaded() && !route().threads ? conversation() : null}>
              {(current) => (
                <ChatThreadColumn
                  conversation={current()}
                  threads={openChat()?.threads ?? null}
                  status={openChat()?.threadsStatus ?? "loading"}
                  view={openChat()?.view ?? "all"}
                  viewerId={props.viewerId}
                  dateConfig={props.dateConfig}
                  now={now}
                  onOpen={(view, navigation) => openView(current().id, view, navigation)}
                  onCreate={() => void createThread()}
                  onRetry={() => void store?.refreshThreads()}
                />
              )}
            </Show>
          </AppWorkspace.MainPane>
          <Switch>
            <Match when={route().threads && openChat()?.id && threaded() ? conversation() : null}>
              {(current) => (
                <ChatThreadsPage
                  conversation={current()}
                  threads={openChat()?.threads ?? null}
                  status={openChat()?.threadsStatus ?? "loading"}
                  viewerId={props.viewerId}
                  dateConfig={props.dateConfig}
                  now={now}
                  info={infoLink(current())}
                  onBack={backToList}
                  onOpen={(view, navigation) => openView(current().id, view, navigation)}
                  onCreate={() => void createThread()}
                  onRetry={() => void store?.refreshThreads()}
                />
              )}
            </Match>
            <Match when={openChat()?.id}>
              {/* One history per chat: a new chat starts at its end or its linked message, never at the last chat's place. */}
              <Show when={openChat()?.id} keyed>
                <Show when={conversation()}>
                  {(current) => (
                    <ChatConversation
                      actions={
                        <>
                          <Show when={current().permission === "admin"}>
                            <IconButton label={t().addPeople} variant="ghost" onClick={() => void addPeople()}>
                              <i class="ti ti-user-plus" aria-hidden="true" />
                            </IconButton>
                          </Show>
                          <Show when={current().permission === "admin" && openThread() && !openThread()?.archived}>
                            <ThreadMenu onRename={() => void renameThread()} onArchive={() => void archiveThread()} />
                          </Show>
                          {infoLink(current())}
                        </>
                      }
                      chatId={current().id}
                      title={current().title}
                      // A wider window picks the thread beside the title; a phone names it there and goes back to the
                      // chat's thread page for another one. CSS decides, so server and browser render the same head.
                      titleExtra={
                        threaded() ? (
                          <>
                            <span class="chat-conversation__thread-name">· {viewTitle()}</span>
                            <span class="chat-conversation__picker">
                              <ThreadPicker
                                chatId={current().id}
                                threads={openChat()?.threads ?? null}
                                unread={current().unread}
                                view={openChat()?.view ?? "all"}
                                canAdmin={current().permission === "admin"}
                                onSelect={(view) => void openView(current().id, view)}
                                onCreate={() => void createThread()}
                              />
                            </span>
                          </>
                        ) : undefined
                      }
                      wideTitle={
                        threaded()
                          ? {
                              title: viewTitle(),
                              subtitle:
                                openChat()?.view === "all"
                                  ? `${current().title} · ${t().allThreadsHint}`
                                  : openChat()?.view === "general"
                                    ? `${current().title} · ${t().generalHint}`
                                    : (openThread()?.description ?? current().title),
                            }
                          : undefined
                      }
                      backHref={threaded() ? threadsPageHref(current().id) : undefined}
                      draftKey={`${current().id}:${openChat()?.view ?? "all"}`}
                      notice={notice()}
                      placeholder={placeholder()}
                      target={threaded() ? (openChat()?.view === "all" ? t().general : viewTitle()) : undefined}
                      reply={
                        reply()
                          ? {
                              author: reply()?.authorName ?? "",
                              text: reply()?.body ?? "",
                              onCancel: () => setReply(null),
                              onSelect: () => {
                                const answered = reply();
                                if (answered?.messageId) void jumpTo(current().id, answered.messageId);
                              },
                            }
                          : undefined
                      }
                      onReply={notice() ? undefined : (item) => setReply(item)}
                      replyHint={replyHint}
                      unreadHint={unreadHint}
                      memberCount={current().memberCount}
                      items={items()}
                      hasOlder={openChat()?.hasOlder ?? false}
                      hasNewer={openChat()?.hasNewer ?? false}
                      onLoadOlder={() => store?.loadOlder() ?? Promise.resolve(false)}
                      onLoadNewer={() => store?.loadNewer() ?? Promise.resolve(false)}
                      onLoadNewest={() => store?.loadLatest() ?? Promise.resolve()}
                      focusKey={focusKey()}
                      canWrite={current().permission !== "read"}
                      hint={draftError() ?? (liveStopped() ? t().liveStopped : waiting() ? t().messagesWaiting : undefined)}
                      draft={draft()}
                      onDraftChange={setDraft}
                      onSend={send}
                      onBack={threaded() ? backToThreads : backToList}
                      busy={busy()}
                      dateConfig={props.dateConfig}
                      now={now}
                      controller={(controller) => {
                        feed = controller;
                      }}
                      markerKey={marker()}
                      onVisibleChange={reportVisible}
                      onMarkUnreadFrom={(item) => void markUnread(current().id, item)}
                      onCopy={copy}
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
                  onCreateThread={current().permission === "admin" ? () => void createThread() : undefined}
                  onLeave={() => void leaveChat()}
                />
              )}
            </Show>
          </Show>
        </AppWorkspace.Detail>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}
