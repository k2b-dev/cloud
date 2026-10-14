import { layout } from "@k2b/cloud/ssr/layout-runtime";
import { type LinkNavigateEvent, listenPopState, navigate, refreshCurrentPath } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import {
  AppWorkspace,
  announce,
  Dropdown,
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
  MESSAGE_BODY_MAX,
  type MessagePageSchema,
  readStart,
} from "../service/contracts";
import { renderSystemMessage } from "../system-messages";
import ChatConversation, { type ChatFeedItem } from "./ChatConversation";
import ChatList from "./ChatList";
import { createChatSends, createChatSendsApi } from "./chat-sends";
import { createChatStore, type OpenChat } from "./chat-store";
import { createReadReporter, seenRange } from "./read-reporter";

type Conversation = z.infer<typeof ConversationSchema>;
type Store = ReturnType<typeof createChatStore>;
type Sends = ReturnType<typeof createChatSends>;

export type ChatWorkspaceProps = {
  /** The live cursor the server read before every part of this snapshot. */
  cursor: string;
  sidebar: z.infer<typeof ConversationPageSchema>;
  open: { conversation: Conversation; page: z.infer<typeof MessagePageSchema>; focus: string | null } | null;
  /** The chat in the address, also when the reader may not see it. */
  chatId: string | null;
  viewerId: string;
  dateConfig: DateContext;
  /** The server's clock, so relative day labels render the same on the server and in the browser. */
  now: string;
};

type Route = { chatId: string | null; messageId: string | null };

const parseRoute = (url: URL): Route | null => {
  const match = /^\/app\/chat(?:\/c\/([^/]+)(?:\/m\/([^/]+))?)?\/?$/.exec(url.pathname);
  return match ? { chatId: match[1] ?? null, messageId: match[2] ?? null } : null;
};

const initialChat = (open: NonNullable<ChatWorkspaceProps["open"]>): OpenChat => {
  const items = open.page.items;
  return {
    id: open.conversation.id,
    status: "live",
    conversation: open.conversation,
    messages: items,
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
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  const [route, setRoute] = createSignal<Route>({ chatId: props.chatId, messageId: props.open?.focus ?? null });
  const [rows, setRows] = createSignal<readonly Conversation[]>(props.sidebar.items);
  const [hasMore, setHasMore] = createSignal(props.sidebar.nextCursor !== null);
  const [chat, setChat] = createSignal<OpenChat | null>(props.open ? initialChat(props.open) : null);
  const [liveStopped, setLiveStopped] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  // The outbox changes its entries in place; this counts its changes so the history reads them again.
  const [sendsVersion, setSendsVersion] = createSignal(0);
  // The list keeps its order while messages arrive elsewhere; it sorts again on the reader's own actions.
  const [order, setOrder] = createSignal<readonly string[]>(props.sidebar.items.map((row) => row.id));
  const [now, setNow] = createSignal(new Date(props.now));
  const drafts = new Map<string, string>();
  const [draft, setDraft] = createSignal("");
  // A stored message keeps the key of the send it came from, so its row is not replaced when it arrives.
  const sendKeys = new Map<string, string>();
  let store: Store | undefined;
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
  const reading = () => document.visibilityState === "visible" && document.hasFocus();
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
    const previous = route().chatId;
    if (previous) drafts.set(previous, draft());
    setRoute(next);
    setDraft(next.chatId ? (drafts.get(next.chatId) ?? "") : "");
    setNow(new Date());
    sortRows();
  };
  /** Loads the chat's snapshot before the address changes; only an applied open may change it. */
  const open = async (next: Route): Promise<"applied" | "superseded" | "failed"> => {
    if (!store) return "failed";
    if (!next.chatId) {
      const live = store;
      batch(() => {
        live.closeConversation();
        applyRoute(next);
      });
      return "applied";
    }
    setBusy(true);
    try {
      const result = await store.openChat(next.chatId, next.messageId ?? undefined);
      if (result.status === "superseded") return "superseded";
      applyRoute({ chatId: next.chatId, messageId: result.status === "opened" ? next.messageId : null });
      return "applied";
    } catch {
      toast.error(t().openFailed);
      return "failed";
    } finally {
      setBusy(false);
    }
  };
  const openFromList = async (id: string, navigation: LinkNavigateEvent) => {
    const fromList = route().chatId === null;
    if ((await open({ chatId: id, messageId: null })) === "applied")
      navigation.push(undefined, { scroll: "preserve", state: { chatFromList: fromList } });
  };

  // A list opened before the chat is the previous history entry, so going back to it does not stack entries.
  const openedFromList = () => {
    const state: unknown = history.state;
    return Boolean(state && typeof state === "object" && "chatFromList" in state && state.chatFromList === true);
  };
  const backToList = async (navigation: LinkNavigateEvent) => {
    if (openedFromList()) history.back();
    else if ((await open({ chatId: null, messageId: null })) === "applied") navigation.push(undefined, { scroll: "preserve" });
  };

  const send = async (text: string): Promise<boolean> => {
    const current = openChat();
    if (!current || !outbox || !text.trim()) return false;
    // The server refuses longer messages; checking here keeps the text in the composer.
    if ([...text].length > MESSAGE_BODY_MAX) {
      toast.error(t().messageTooLong({ max: MESSAGE_BODY_MAX.toLocaleString(locale()) }));
      return false;
    }
    if (current.hasNewer) await store?.loadLatest();
    outbox.send(current.id, text);
    feed?.scrollToEnd();
    return true;
  };

  onMount(() => {
    const live = createChatStore({
      viewerId: props.viewerId,
      cursor: props.cursor,
      sidebar: props.sidebar,
      ...(props.open ? { open: { conversation: props.open.conversation, page: props.open.page } } : {}),
    });
    store = live;
    const sync = () => {
      prune();
      // The reader's own message moves its chat to the top: that is the reader's action, not a move under the pointer.
      const top = live.sidebar[0];
      const ownTop = top?.lastMessage?.author.id === props.viewerId && top.id === live.openConversation?.id && order()[0] !== top.id;
      setRows(live.sidebar);
      if (ownTop) sortRows();
      setHasMore(live.hasMoreSidebar);
      setChat(live.openConversation);
      setLiveStopped(live.liveStatus === "stopped");
    };
    onCleanup(live.subscribe(sync));
    sync();

    const box = createChatSends({ post: createChatSendsApi() });
    outbox = box;
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
        if (openedFromList()) history.back();
        else void open({ chatId: null, messageId: null }).then((result) => result === "applied" && navigate("/app/chat"));
        return true;
      }),
    );
    const activate = () => reporter?.reporter.activate();
    document.addEventListener("visibilitychange", activate);
    window.addEventListener("focus", activate);
    onCleanup(() => {
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
    <AppWorkspace mobileSurface="flush" class="chat-workspace h-full">
      <AppWorkspace.Sidebar label={t().chats}>
        <AppWorkspace.SidebarDesktop>
          <AppWorkspace.SidebarBody scrollPreserveKey="chat-sidebar">
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
                      canWrite={current().permission !== "read"}
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
                      onDraftChange={setDraft}
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
                      onEscape={markOpenRead}
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
              />
            </Match>
            <Match when={true}>
              <nav class="chat-list-page" aria-label={t().chats}>
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
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}
