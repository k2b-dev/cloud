import { layout } from "@k2b/cloud/ssr/layout-runtime";
import { type LinkNavigateEvent, listenPopState, navigate, refreshCurrentPath } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { AppWorkspace, announce, type MessageRowStatus, Placeholder, toast, useLocale, type VirtualFeedController } from "@k2b/ui";
import { batch, createMemo, createSignal, type JSX, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import type { z } from "zod";
import { chatMessages } from "../messages";
import type { ConversationPageSchema, ConversationSchema, MessagePageSchema } from "../service/contracts";
import { renderSystemMessage } from "../system-messages";
import ChatConversation, { type ChatFeedItem } from "./ChatConversation";
import ChatList from "./ChatList";
import { createChatSends, createChatSendsApi } from "./chat-sends";
import { createChatStore, type OpenChat } from "./chat-store";

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
  const publishTrail = () =>
    layout.update({ breadcrumbs: breadcrumbs(route().chatId ? (conversation()?.title ?? t().noAccessTitle) : undefined) });

  const items = createMemo<readonly ChatFeedItem[]>((previous) => {
    const current = openChat();
    if (!current) return [];
    const cache = new Map(previous?.map((item) => [item.key, item]));
    sendsVersion();
    const own = outbox?.sends(current.id) ?? [];
    for (const send of own) if (send.message) sendKeys.set(send.message.id, send.clientId);
    const stored = new Set(current.messages.map((message) => message.id));
    const reuse = (item: ChatFeedItem) => {
      const known = cache.get(item.key);
      return known && known.body === item.body && known.status === item.status && known.at === item.at ? known : item;
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
      });
    });
    // Sends wait at the end of the newest history; a window further back shows them once the reader is there.
    if (!current.hasNewer) {
      for (const send of own) {
        if (send.message && stored.has(send.message.id)) continue;
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
            ...(status === "failed" ? { retry: () => outbox?.retry(send.clientId) } : {}),
          }),
        );
      }
    }
    return result;
  });
  const focusKey = () => {
    const id = route().messageId;
    return id ? (sendKeys.get(id) ?? id) : null;
  };

  const applyRoute = (next: Route) => {
    const previous = route().chatId;
    if (previous) drafts.set(previous, draft());
    setRoute(next);
    setDraft(next.chatId ? (drafts.get(next.chatId) ?? "") : "");
    setNow(new Date());
    sortRows();
    publishTrail();
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
    if (current.hasNewer) await store?.loadLatest();
    outbox.send(current.id, text);
    feed?.scrollToEnd();
    return true;
  };

  onMount(() => {
    const live = createChatStore({
      cursor: props.cursor,
      sidebar: props.sidebar,
      ...(props.open ? { open: { conversation: props.open.conversation, page: props.open.page } } : {}),
    });
    store = live;
    const sync = () => {
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
    onCleanup(() => {
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
    />
  );

  return (
    <AppWorkspace mobileSurface="flush" class="chat-workspace h-full">
      <AppWorkspace.Sidebar label={t().chats}>
        <AppWorkspace.SidebarDesktop>
          <AppWorkspace.SidebarBody scrollPreserveKey="chat-sidebar">
            <AppWorkspace.SidebarSection title={t().chats}>
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
                      hint={current().permission === "read" ? t().readOnly : liveStopped() ? t().liveStopped : undefined}
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
                {list()}
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
