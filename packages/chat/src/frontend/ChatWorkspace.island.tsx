import { onPanelBeforeLeave } from "@k2b/cloud/browser/panel";
import { openCloudResourcePicker } from "@k2b/cloud/browser/resource-picker";
import type { CloudResourceRef } from "@k2b/cloud/contracts";
import { layout } from "@k2b/cloud/ssr/layout-runtime";
import { Link, type LinkNavigateEvent, listenPopState, navigate, refreshCurrentPath } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { clipboard } from "@k2b/stdlib/browser";
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
import { batch, createEffect, createMemo, createSignal, type JSX, Match, on, onCleanup, onMount, Show, Switch, untrack } from "solid-js";
import type { z } from "zod";
import { chatMessages } from "../messages";
import {
  type ConversationPageSchema,
  type ConversationSchema,
  type ItemEventSchema,
  MAX_MESSAGE_REFS,
  MESSAGE_MAX_CODE_POINTS,
  MessageBodySchema,
  type MessagePageSchema,
  type MessageSchema,
  type PersonalConversationSchema,
  type ReadUpdateSchema,
  type SharedItem,
  type SidebarPreferencesSchema,
  type ThreadListSchema,
} from "../service/contracts";
import { renderSystemMessage } from "../system-messages";
import { openAddPeopleDialog } from "./AddPeopleDialog";
import { openChannelDialog } from "./ChannelDialogs";
import ChatConversation, { type ChatFeedItem } from "./ChatConversation";
import { openChatDetailsDialog } from "./ChatDetailsDialog";
import ChatInfoPanel from "./ChatInfoPanel";
import ChatList from "./ChatList";
import ChatSharedSection from "./ChatSharedSection";
import ChatSystemChats, { createSystemChatList } from "./ChatSystemChats";
import ChatThreadColumn from "./ChatThreadColumn";
import { ThreadMenu, ThreadPicker } from "./ChatThreads";
import ChatThreadsPage from "./ChatThreadsPage";
import { createChannelApi } from "./channel-api";
import { ChatDraftConflict, chatDrafts } from "./chat-drafts";
import { messageTime, sameDay } from "./chat-format";
import { createChatSends, createChatSendsApi } from "./chat-sends";
import { ChatRequestError, createChatStore, type OpenChat } from "./chat-store";
import DiscoverChannels from "./DiscoverChannels";
import { createItemEventsApi } from "./item-events-api";
import { openLeaveChatDialog } from "./LeaveChatDialog";
import { openNewChatDialog } from "./NewChatDialog";
import { createReadReporter, seenRange } from "./read-reporter";
import { createResourceCards, FRESH_MS } from "./resource-cards";
import { panelHref as conversationHref, parseRoute, type Route, threadsPageHref as threadsPageAddress } from "./route";
import { containerIcon, openResourceThread, openSystemChat, systemMembers } from "./system-chats";

import { openThreadDialog } from "./ThreadDialog";
import {
  chatHasThreads,
  isUnread,
  messageThread,
  type ThreadView,
  threadHref as threadAddress,
  threadIcon,
  threadOf,
  viewName,
  viewReadStart,
} from "./threads";

type ReadUpdate = z.infer<typeof ReadUpdateSchema>;

type Conversation = z.infer<typeof ConversationSchema>;
type Message = z.infer<typeof MessageSchema>;
type Store = ReturnType<typeof createChatStore>;
type Sends = ReturnType<typeof createChatSends>;

export type ChatWorkspaceProps = {
  /** The same workspace served without the Cloud shell in its provider route. */
  embedded?: boolean;
  archived?: boolean;
  filter?: "all" | "unread";
  collapsed?: z.infer<typeof SidebarPreferencesSchema>["collapsed"];
  channelsPage?: boolean;
  channelQuery?: string;
  channelPage?: z.infer<typeof ConversationPageSchema> | null;
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
  threadsRevision: 0,
  status: "live",
  caughtUp: false,
  conversation: open.conversation,
  messages: open.page.items,
  membershipRev: 0,
  accessRev: 0,
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
  const basePath = props.embedded ? "/app/chat/panel" : "/app/chat";
  const panelHref = (id: string, info: "info" | null, message?: string | null, view: ThreadView = "all") =>
    conversationHref(id, info, message, view, basePath);
  const threadHref = (id: string, view: ThreadView, message?: string | null) => threadAddress(id, view, message, basePath);
  const threadsPageHref = (id: string) => threadsPageAddress(id, basePath);
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  const [route, setRoute] = createSignal<Route>({
    channels: props.channelsPage,
    query: props.channelQuery,
    chatId: props.chatId,
    view: props.view,
    threads: props.threadsPage,
    messageId: props.open?.focus ?? null,
    panel: props.panel,
  });
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
    const id = /\/c\/([^/]+)/.exec(url.pathname)?.[1];
    const target =
      rows().find((row) => row.id === id) ??
      (conversation()?.id === id ? conversation() : null) ??
      (props.open && props.open.conversation.id === id ? props.open.conversation : null);
    // The system thread directory already owns `filter`; personal list state has its own key there.
    if (target?.kind === "system") {
      if (filter() === "unread") url.searchParams.set("listFilter", "unread");
      else url.searchParams.delete("listFilter");
    } else if (filter() === "unread") url.searchParams.set("filter", "unread");
    if (archived() && url.pathname.includes("/c/")) url.searchParams.set("list", "archive");
    return url.pathname + url.search;
  };
  const viewHref = (path: string) => {
    const url = new URL(listHref(path), location.href);
    const source = new URL(location.href);
    if (conversation()?.kind === "system" && /\/c\/([^/]+)/.exec(source.pathname)?.[1] === /\/c\/([^/]+)/.exec(url.pathname)?.[1])
      for (const key of ["q", "filter"]) if (source.searchParams.has(key)) url.searchParams.set(key, source.searchParams.get(key)!);
    return url.pathname + url.search;
  };
  const [panel, setPanel] = createSignal<"info" | null>(props.panel);
  const [rows, setRows] = createSignal<readonly Conversation[]>(props.sidebar.items);
  const [hasMore, setHasMore] = createSignal(props.sidebar.nextCursor !== null);
  const [chat, setChat] = createSignal<OpenChat | null>(props.open ? initialChat(props.open, props.view) : null);
  const [liveStopped, setLiveStopped] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  // The latest open whose snapshot is still loading; an older one that a newer navigation superseded no longer counts.
  let openToken = 0;
  let pendingOpen = 0;
  let systemOpen = 0;
  let pendingSends = 0;

  // The outbox changes its entries in place; this counts its changes so the history reads them again.
  const [sendsVersion, setSendsVersion] = createSignal(0);
  // The list keeps its order while messages arrive elsewhere; it sorts again on the reader's own actions.
  const [order, setOrder] = createSignal<readonly string[]>(props.sidebar.items.map((row) => row.id));
  const [now, setNow] = createSignal(new Date(props.now));
  // Each part of a chat keeps its own draft and its own reply; "All threads" and a chat without threads use the chat's.
  const draftId = (target: Pick<Route, "chatId" | "view">) =>
    target.chatId === null ? null : target.view === "all" ? target.chatId : `${target.chatId}:${target.view}`;
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
    const id = draftId(route());
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
      const id = draftId(route());
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
        if (draftId(route()) === id) setDraft(saved);
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
  const [readFailure, setReadFailure] = createSignal<{ run: () => Promise<unknown> | undefined }>();
  const [retryingRead, setRetryingRead] = createSignal(false);
  const readNotice = () => (
    <Show when={readFailure()}>
      {(failure) => (
        <span class="chat-read-status">
          <span>{t().readStateFailed}</span>
          <Button
            variant="text"
            size="xs"
            class="chat-read-status__retry"
            loading={retryingRead()}
            onClick={async () => {
              setRetryingRead(true);
              try {
                await changeRead(failure().run);
              } finally {
                setRetryingRead(false);
              }
            }}
          >
            {t().retry}
          </Button>
        </span>
      )}
    </Show>
  );
  const draftNotice = () => (
    <>
      <Show when={eventsFailed()}>
        <InlineGuidance tone="danger" icon="ti ti-alert-circle" role="alert">
          {t().itemEventsFailed}{" "}
          <Button variant="text" size="xs" onClick={() => void loadEvents()}>
            {t().retry}
          </Button>
        </InlineGuidance>
      </Show>
      <Show when={draftStorageFailed()}>
        <NoticeCard tone="danger" title={t().draftNotSaved} detail={t().draftNotSavedDescription}>
          <Button variant="ghost" onClick={retryDraftStorage}>
            {t().retry}
          </Button>
        </NoticeCard>
      </Show>
      <Show when={draftId(route()) && draftConflicts()[draftId(route())!] !== undefined}>
        <NoticeCard tone="warning" title={t().draftChangedElsewhere} detail={t().draftChangedElsewhereDescription}>
          <pre class="max-h-32 overflow-auto whitespace-pre-wrap">{draftConflicts()[draftId(route())!]}</pre>
          <Button variant="secondary" onClick={() => resolveDraftConflict(draftId(route())!, true)}>
            {t().useSavedDraft}
          </Button>
          <Button variant="ghost" onClick={() => resolveDraftConflict(draftId(route())!, false)}>
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
      .filter((row) => row.kind !== "system" && rank.has(row.id))
      .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    const ordered = [...rows().filter((row) => row.kind !== "system" && !rank.has(row.id)), ...known];
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
  const system = () => conversation()?.kind === "system";
  const systemList = createSystemChatList();
  createEffect(
    on([liveStore, systemList.page], ([live, page]) => {
      if (live && page) live.includeSystemChats(page.items.flatMap((item) => (item.conversation ? [item.conversation] : [])));
    }),
  );
  const [systemExpanded, setSystemExpanded] = createSignal(props.open?.conversation.kind === "system");
  const [creatingThread, setCreatingThread] = createSignal(false);
  const canCreateThread = () => {
    const current = conversation();
    return !!current && !current.channel && (system() ? current.permission !== "read" : current.permission === "admin");
  };
  const generalName = () => (system() ? (conversation()?.title ?? "") : t().general);
  const threadName = (view: ThreadView) => (view === "general" ? generalName() : viewName(view, openChat()?.threads ?? null, t()));
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
    if (route().channels) return t().browseChannels;
    if (!id) return undefined;
    if (chat()?.id !== id) return previous;
    return conversation()?.title ?? t().threadUnavailable;
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
    const name = threadName(view);
    if (system() && view === "general") return { label: name, icon: containerIcon(conversation()?.resource?.type) };
    if (!name) return undefined;
    return {
      label: name,
      icon: view === "general" ? "ti ti-messages" : threadIcon(threadOf(openChat()?.threads ?? null, view)),
      selectLabel: t().openThread({ name }),
      onSelect: () => void openView(chatId, view),
    };
  };
  // Changes to the items of a Space or notebook show between its messages. They are read through the owning app
  // for the loaded window of messages, again when the history changes, when the page comes back and once a minute.
  // They are no messages; a failed read keeps the ones shown and says so, with a way to read them again.
  type ItemEvent = z.infer<typeof ItemEventSchema>;
  const itemEvents = createItemEventsApi();
  const [events, setEvents] = createSignal<{ key: string; chat: string; view: string; list: readonly ItemEvent[] }>();
  // Event and group rows keep their objects while they show the same, so the feed keeps their elements and focus.
  const eventRows = new Map<string, ChatFeedItem>();
  const keepEventRow = (row: ChatFeedItem) => {
    const known = eventRows.get(row.key);
    if (
      known &&
      known.body === row.body &&
      known.at === row.at &&
      known.icon === row.icon &&
      known.origin?.label === row.origin?.label &&
      known.group?.label === row.group?.label &&
      known.group?.time === row.group?.time
    )
      return known;
    eventRows.set(row.key, row);
    return row;
  };
  const [eventsFailed, setEventsFailed] = createSignal(false);
  const [openGroups, setOpenGroups] = createSignal<ReadonlySet<string>>(new Set());
  /** The window the events belong to: from the first loaded message, up to the last one when newer ones follow. */
  const eventsWindow = () => {
    const current = openChat();
    if (!current || current.conversation?.kind !== "system" || current.view === "general") return null;
    return {
      chat: current.id,
      view: current.view,
      after: current.messages[0]?.createdAt,
      before: current.hasNewer ? current.messages.at(-1)?.createdAt : undefined,
    };
  };
  // Memos, so an update of the chat that keeps the window and the history's length reads nothing again.
  const eventsKey = createMemo(() => {
    const window = eventsWindow();
    return window ? JSON.stringify(window) : null;
  });
  const loadedMessages = createMemo(() => openChat()?.messages.length);
  let eventsRequest: AbortController | undefined;
  const loadEvents = async () => {
    const window = eventsWindow();
    const key = eventsKey();
    eventsRequest?.abort();
    if (!window || !key) return;
    const request = new AbortController();
    eventsRequest = request;
    const list: ItemEvent[] = [];
    try {
      let cursor: string | undefined;
      // A window holds the changes between its messages; ten pages bound a very busy one. A chat without messages
      // shows its latest page of changes.
      for (let page = 0; page < (window.after ? 10 : 1); page++) {
        const result = await itemEvents.list(
          window.chat,
          {
            thread: window.view === "all" ? "all" : window.view,
            limit: 100,
            ...(window.after ? { after: window.after } : {}),
            ...(window.before ? { before: window.before } : {}),
            ...(cursor ? { cursor } : {}),
          },
          request.signal,
        );
        if (result.unavailable) throw new Error("Item events unavailable");
        list.push(...result.items);
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      if (request.signal.aborted) return;
      setEvents({ key, chat: window.chat, view: window.view, list });
      setEventsFailed(false);
    } catch (error) {
      if (!request.signal.aborted && !(error instanceof Error && error.name === "AbortError")) setEventsFailed(true);
    }
  };
  const eventsPlace = createMemo(() => {
    const window = eventsWindow();
    return window ? `${window.chat}:${window.view}` : null;
  });
  createEffect(
    on(eventsPlace, () => {
      setOpenGroups(new Set<string>());
      setEventsFailed(false);
    }),
  );
  createEffect(
    on(eventsKey, (key) => {
      if (key) void loadEvents();
      else {
        eventsRequest?.abort();
        setEvents(undefined);
      }
    }),
  );
  createEffect(on(loadedMessages, () => void loadEvents(), { defer: true }));
  onMount(() => {
    const visible = () => {
      if (document.visibilityState === "visible") void loadEvents();
    };
    document.addEventListener("visibilitychange", visible);
    const timer = setInterval(visible, 60_000);
    onCleanup(() => {
      document.removeEventListener("visibilitychange", visible);
      clearInterval(timer);
      eventsRequest?.abort();
    });
  });
  const eventOrigin = (chatId: string, event: ItemEvent) => {
    const thread = event.thread;
    if ("id" in thread)
      return {
        label: thread.name,
        icon: threadIcon(threadOf(openChat()?.threads ?? null, thread.id)),
        selectLabel: t().openThread({ name: thread.name }),
        onSelect: () => void openView(chatId, thread.id),
      };
    const canOpen = ["write", "admin"].includes(openChat()?.conversation?.permission ?? "");
    return {
      label: thread.name,
      icon: thread.ref.type === "notebooks.note" ? "ti ti-file-text" : "ti ti-circle",
      ...(canOpen
        ? {
            selectLabel: t().openThread({ name: thread.name }),
            onSelect: () =>
              void openResourceThread(chatId, { ref: thread.ref }).then(
                (opened) => openView(chatId, opened.id),
                () => toast(t().requestFailed, { iconClass: "ti ti-alert-circle" }),
              ),
          }
        : {}),
    };
  };
  /** Three or more events in a row on one day stand as one line that opens them. */
  const groupEvents = (list: readonly ChatFeedItem[], mixed: boolean): ChatFeedItem[] => {
    const result: ChatFeedItem[] = [];
    const config = { ...props.dateConfig, locale: locale() };
    for (let index = 0; index < list.length; ) {
      const run: ChatFeedItem[] = [];
      while (index < list.length && list[index]!.kind === "event" && (run.length === 0 || sameDay(run[0]!.at, list[index]!.at, config)))
        run.push(list[index++]!);
      if (run.length >= 3) {
        const first = run[0]!;
        const key = `events:${first.key}`;
        const expanded = openGroups().has(key);
        const names = [...new Set(run.map((item) => item.origin?.label).filter((name): name is string => Boolean(name)))];
        result.push(
          keepEventRow({
            key,
            kind: "eventGroup",
            authorId: "",
            authorName: "",
            body: "",
            at: first.at,
            own: false,
            group: {
              label: mixed
                ? t().eventChangesTo({ count: run.length, names: names.slice(0, 2).join(", "), more: Math.max(names.length - 2, 0) })
                : t().eventChanges({ count: run.length }),
              time: `${messageTime(first.at, config)}–${messageTime(run.at(-1)!.at, config)}`,
              expanded: () => openGroups().has(key),
              toggle: () =>
                setOpenGroups((open) => {
                  const next = new Set(open);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                }),
            },
          }),
        );
        if (expanded) result.push(...run);
      } else if (run.length) result.push(...run);
      else result.push(list[index++]!);
    }
    return result;
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
        refs: message.refs,
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
    // Events stand between the stored messages by time; the window's own bounds keep out what belongs to other pages.
    const loaded = events();
    const first = current.messages[0]?.createdAt;
    const last = current.messages.at(-1)?.createdAt;
    // The previous window's events stay until the new window's arrive, as long as the chat and view are the same.
    if (loaded && loaded.chat === current.id && loaded.view === current.view) {
      const shown = loaded.list
        .filter((event) => (!first || event.at >= first) && (!current.hasNewer || !last || event.at <= last))
        .map((event) =>
          keepEventRow({
            key: `event:${event.id}`,
            kind: "event",
            authorId: "",
            authorName: "",
            body: event.sentence,
            icon: event.icon,
            at: event.at,
            own: false,
            origin: mixed ? eventOrigin(current.id, event) : undefined,
          }),
        )
        .sort((a, b) => a.at.localeCompare(b.at));
      let next = 0;
      const merged: ChatFeedItem[] = [];
      for (const item of result) {
        while (next < shown.length && shown[next]!.at < item.at) merged.push(shown[next++]!);
        merged.push(item);
      }
      merged.push(...shown.slice(next));
      result.splice(0, result.length, ...groupEvents(merged, mixed));
    }
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
            refs: send.refs,
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
  const [unreadGap, setUnreadGap] = createSignal<{ from: number; key: string | null } | null>(null);
  // Reports what the reader sees in the open chat. After the reader marks it unread, nothing is reported until they
  // leave it, so the mark is not read away at once.
  let reporter: { chatId: string; reporter: ReturnType<typeof createReadReporter> } | undefined;
  let paused = false;
  let phone: MediaQueryList | undefined;
  // Replay can paint many intermediate windows. Only the caught-up window starts new reading.
  const catchingUp = createMemo(() => openChat()?.status === "live" && !openChat()?.caughtUp);
  const reading = () =>
    !catchingUp() &&
    Boolean(phone) &&
    document.visibilityState === "visible" &&
    document.hasFocus() &&
    !(panel() === "info" && phone?.matches);
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
      setUnreadGap(null);
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
          active: () => reading() && !paused,
          onGap: (from) => {
            if (from === null) {
              setUnreadGap(null);
              return;
            }
            const current = openChat();
            // A deep link keeps its initial destination; once reading has advanced, a later gap is new.
            if (current?.id !== id || current.view !== view || (route().messageId && from <= start + 1)) return;
            const first = current.messages.find(
              (message) => message.seq >= from && message.kind === "text" && message.author.id !== props.viewerId,
            );
            const key = first && (current.messages[0]?.seq ?? Infinity) <= from ? first.id : null;
            if (!marker() && key) setMarker(key);
            setUnreadGap((previous) => (previous?.from === from && previous.key === key ? previous : { from, key }));
          },
          // "All threads" reads every thread up to what the reader saw; a thread only itself.
          post: async (seq) => {
            if (paused) return;
            if (!store) throw new Error("Chat is not live yet");
            if (!(await changeRead(() => store?.markRead(id, seq, view), key))) throw new Error("Chat read failed");
          },
        }),
      };
    }),
  );
  createEffect(() => {
    const current = openChat();
    const start = current ? viewReadStart(current.view, current.conversation?.read ?? null, current.threads) : null;
    if (current && start !== null && reporter?.chatId === current.id) untrack(() => reporter?.reporter.setStart(start));
  });
  let visibleRange: { first: ChatFeedItem; last: ChatFeedItem } | null = null;
  let readFrame: number | undefined;
  const reportVisible = (visible: { first: ChatFeedItem; last: ChatFeedItem } | null) => {
    visibleRange = visible;
    if (readFrame !== undefined) return;
    // A replay can render several intermediate windows in one task. Read only the window that reaches a frame.
    readFrame = requestAnimationFrame(() => {
      readFrame = undefined;
      const visible = visibleRange;
      if (!visible || catchingUp()) return;
      const list = items();
      const range = seenRange(
        list,
        list.findIndex((item) => item.key === visible.first.key),
        list.findIndex((item) => item.key === visible.last.key),
        openChat()?.hasOlder ?? true,
      );
      if (range) reporter?.reporter.seen(range.first, range.last);
    });
  };
  createEffect(
    on(catchingUp, (pending) => {
      if (!pending) reportVisible(visibleRange);
    }),
  );
  onCleanup(() => {
    if (readFrame !== undefined) cancelAnimationFrame(readFrame);
  });
  const changeRead = async (work: () => Promise<unknown> | undefined, selection?: string) => {
    try {
      await work();
      if (selection === undefined || selection === openKey()) setReadFailure(undefined);
      return true;
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError") && (selection === undefined || selection === openKey()))
        setReadFailure({ run: work });
      return false;
    }
  };
  // The server stops at the newest message, so the largest position marks the whole chat read.
  let unreadAction = 0;
  const markRead = (id: string) => void changeRead(() => store?.markRead(id, Number.MAX_SAFE_INTEGER, "all"));
  const markUnread = async (id: string, from?: ChatFeedItem) => {
    const selection = openKey();
    const target = reporter;
    const previousGap = unreadGap();
    if (openChat()?.id === id) unreadAction++;
    const open = openChat()?.id === id;
    if (!from) {
      if (open) paused = true;
      if (open && reporter?.chatId === id) await reporter.reporter.settled();
      const changed = await changeRead(() => store?.markUnread(id));
      if (open && reporter === target) {
        if (changed) setUnreadGap(null);
        else {
          paused = false;
          target?.reporter.activate();
        }
      }
      return;
    }
    // "Mark unread from here" in the open chat: the marker moves at once, a failure puts everything back. Every step
    // after an await checks that the chat is still open, so a late answer or a retry from another chat never moves
    // the marker of the chat on screen.
    const isOpen = () => openChat()?.id === id && openKey() === selection;
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
    if (isOpen()) {
      setMarker(from.key);
      setUnreadGap(null);
    }
    let result: ReadUpdate | undefined;
    try {
      result = await store?.markUnread(id, from.messageId);
    } catch {
      if (isOpen() && !("closed" in before)) {
        setMarker(before.marker);
        setUnreadGap(previousGap);
        paused = before.paused;
        if (reporter === target) target?.reporter.activate();
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
  // Reactions change in place: rows read them by message, so a new count never rebuilds the message.
  const reactionsById = createMemo(() => new Map(openChat()?.messages.map((message) => [message.id, message.reactions]) ?? []));
  const react = (item: ChatFeedItem, emoji: string, on: boolean) => {
    const current = openChat();
    if (!store || !current || !item.messageId) return;
    void store
      .react(current.id, item.messageId, emoji, on)
      .catch((error: unknown) => toast.error(error instanceof ChatRequestError ? error.message : t().requestFailed));
  };
  const copy = (item: ChatFeedItem) =>
    void clipboard.copy(item.body).then(
      () => announce(t().copied),
      () => toast.error(t().copyFailed),
    );
  const markOpenRead = async () => {
    const current = openChat();
    const live = store;
    if (!current || !live) return;
    const target = reporter;
    const intent = unreadAction;
    await changeRead(async () => {
      await live.markRead(current.id, current.seqHead, current.view);
      if (intent !== unreadAction || target !== reporter || openKey() !== `${current.id}:${current.view}`) return;
      paused = false;
      // Retry repeats the accepted-read cleanup too; a failed write keeps both markers.
      target?.reporter.advance(current.seqHead);
      setMarker(null);
      setUnreadGap(null);
      target?.reporter.activate();
      announce(t().markedRead);
    }, `${current.id}:${current.view}`);
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
      while (result.outcome === "done" && result.more) result = await live.readAll(true, result.nextCursor ?? undefined);
    });
  };

  const applyListUrl = (url: URL, refresh = false) =>
    loadList(async () => {
      const token = ++listIntent;
      const nextArchived = url.pathname === `${basePath}/archive` || url.searchParams.get("list") === "archive";
      const id = /\/c\/([^/]+)/.exec(url.pathname)?.[1];
      const target =
        rows().find((row) => row.id === id) ??
        (conversation()?.id === id ? conversation() : null) ??
        (props.open && props.open.conversation.id === id ? props.open.conversation : null);
      const nextFilter =
        (url.searchParams.get("listFilter") ?? (target?.kind === "system" ? null : url.searchParams.get("filter"))) === "unread"
          ? "unread"
          : "all";
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
  // One step can be refused twice (the link and the history entry it adds), so the notice replaces its earlier copy.
  let preparingNotice: ReturnType<typeof toast> | undefined;
  const notifyPreparing = () => {
    preparingNotice?.dismiss();
    preparingNotice = toast(t().sendPreparing);
  };
  const changeList = async (next: "all" | "unread" | "archive") => {
    if (!store || listLoading() || listPending()) return;
    if (next === "archive" && pendingSends > 0) {
      notifyPreparing();
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
      const currentPath = current.chatId
        ? current.threads
          ? `${threadsPageHref(current.chatId)}${current.panel === "info" ? "?panel=info" : ""}`
          : panelHref(current.chatId, current.panel, current.messageId, current.view)
        : null;
      const target = next !== "archive" && currentPath ? viewHref(currentPath) : url.pathname + url.search;
      if (next === "archive" && (await open(chatRoute(null))) !== "applied") return;
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
  // Each part of a chat keeps its own draft and its own reply.
  const applyRoute = (next: Route) => {
    const previous = draftId(route());
    if (previous) replies.set(previous, reply());
    setRoute(next);
    setPanel(next.panel);
    const key = draftId(next);
    setDraft(key ? readDraft(key) : "");
    setReply(key ? (replies.get(key) ?? null) : null);
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
    systemOpen++;

    if (!store) return "failed";
    if (pendingSends > 0 && next.chatId !== route().chatId) {
      notifyPreparing();
      return "blocked";
    }
    if (
      pendingOpen === 0 &&
      route().chatId === next.chatId &&
      route().view === next.view &&
      route().threads === next.threads &&
      route().channels === next.channels &&
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
      if (result.status === "opened" && store.openConversation?.conversation?.kind === "system") void store.refreshThreads();
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
  const jumpUnreadGap = async () => {
    const gap = unreadGap();
    const id = route().chatId;
    if (!gap || busy() || !id) return;
    if (gap.key && feed?.scrollToKey(gap.key, { align: "start" })) return;
    // A live resync can have discarded the gap. Reuse the permission-aware snapshot around first unread.
    const previous = route();
    const token = openToken;
    await reporter?.reporter.settled();
    // A pending read must not pull the reader back after they opened another chat or panel.
    if (route() !== previous || openToken !== token) return;
    const next = { ...previous, chatId: id, messageId: null };
    if ((await open(next)) !== "applied") return;
    navigate(viewHref(panelHref(id, next.panel, null, next.view)), {
      replace: true,
      scroll: "preserve",
    });
    const current = openChat();
    const start = current ? viewReadStart(current.view, current.conversation?.read ?? null, current.threads) : null;
    const first =
      start === null
        ? undefined
        : current?.messages.find((message) => isUnread(message, props.viewerId, current.conversation?.read ?? null, current.threads));
    if (first) {
      if (!marker()) setMarker(first.id);
      feed?.scrollToKey(first.id, { align: "start" });
    }
    setUnreadGap(null);
  };
  const openFromList = async (id: string, navigation: LinkNavigateEvent) => {
    const fromList = route().chatId === null;
    // A phone shows a chat with threads as its page of threads first; a wider window opens "All threads" and its rows.
    const row = rows().find((candidate) => candidate.id === id);
    if (phone?.matches && row?.kind !== "system" && chatHasThreads(row)) {
      if ((await open(chatRoute(id, "all", { threads: true }))) === "applied")
        navigation.push(viewHref(threadsPageHref(id)), {
          scroll: "preserve",
          state: { chatFromList: fromList },
        });
      return;
    }
    if ((await open(chatRoute(id))) !== "applied") return;
    const target = viewHref(panelHref(id, null));
    if (location.pathname + location.search !== target) navigation.push(target, { scroll: "preserve", state: { chatFromList: fromList } });
    if (pendingListIntent !== null) await refreshList(target);
  };
  const openSystemFromList = async (id: string, navigation: LinkNavigateEvent) => {
    const row = systemList.page()?.items.find((item) => item.conversation?.id === id);
    const ref = row?.ref ?? rows().find((row) => row.id === id)?.resource ?? (conversation()?.id === id ? conversation()?.resource : null);
    if (!ref || (ref.type !== "spaces.space" && ref.type !== "notebooks.notebook")) return;
    const token = ++systemOpen;
    setBusy(true);
    try {
      const current = await openSystemChat({ resourceType: ref.type, resourceId: ref.id });
      if (token !== systemOpen) return;
      store?.includeSystemChats([current]);
      if ((await open(chatRoute(current.id))) === "applied")
        navigation.push(viewHref(threadHref(current.id, "all")), { scroll: "preserve" });
    } catch {
      if (token === systemOpen) toast.error(t().openFailed);
    } finally {
      if (token === systemOpen) setBusy(false);
    }
  };
  const openOverview = async (navigation?: LinkNavigateEvent) => {
    const id = conversation()?.id;
    if (!id || (await open(chatRoute(id, "all", { threads: true }))) !== "applied") return;
    if (navigation) navigation.push(viewHref(threadsPageHref(id)), { scroll: "preserve" });
    else navigate(viewHref(threadsPageHref(id)), { scroll: "preserve" });
  };
  /** Opens another part of the open chat, from the list, the picker, a thread chip, or a new thread. */
  const openView = async (id: string, view: ThreadView, navigation?: LinkNavigateEvent, message?: string) => {
    // From the phone's page of threads, "Back" in the thread returns to that page in the history; from Info opened
    // on top of it, the previous entry is Info, so "Back" opens the page instead.
    const options = { scroll: "preserve" as const, state: { threadFromPage: route().threads && route().panel === null } };
    const next = chatRoute(id, view, { messageId: message ?? null });
    if ((await open(next)) !== "applied") return;
    const href = viewHref(threadHref(id, view, message));
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
    else if ((await open(chatRoute(null))) === "applied") navigation.push(listHref(), { scroll: "preserve" });
  };
  const backToThreads = async (navigation: LinkNavigateEvent) => {
    const state: unknown = history.state;
    const id = route().chatId;
    if (state && typeof state === "object" && "threadFromPage" in state && state.threadFromPage === true) history.back();
    else if (id && (await open(chatRoute(id, route().view, { threads: true }))) === "applied")
      navigation.push(viewHref(threadsPageHref(id)), { scroll: "preserve" });
  };

  const openInfo = (navigation?: LinkNavigateEvent) => {
    if (pendingOpen !== 0) return;
    const id = route().chatId;
    if (!id || !openChat() || panel() === "info") return;
    const messageId = route().messageId;
    setPanel("info");
    setRoute({ ...route(), chatId: id, messageId, panel: "info" });
    const options = { scroll: "preserve" as const, state: { chatFromList: listDepth() === 1, chatInfoFromChat: true } };
    if (navigation) navigation.push(viewHref(panelHref(id, "info", messageId, route().view)), options);
    else navigate(viewHref(panelHref(id, "info", messageId, route().view)), options);
  };
  const infoFromChat = () => {
    const state: unknown = history.state;
    return !!state && typeof state === "object" && "chatInfoFromChat" in state && state.chatInfoFromChat === true;
  };
  // A shared item jumps to its message: in place when the open view holds it, otherwise in the message's thread. A phone
  // shows the message instead of the info page.
  const jumpToShared = (item: SharedItem) => {
    const current = openChat();
    if (!current) return;
    const view = current.view === "all" || current.view === messageThread(item) ? current.view : messageThread(item);
    if (view === current.view && feed?.scrollToKey(sendKeys.get(item.messageId) ?? item.messageId, { highlight: true })) {
      if (phone?.matches) closeInfo();
      return;
    }
    void openView(current.id, view, undefined, item.messageId);
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
    if (navigation) navigation.push(viewHref(panelHref(id, null, messageId, route().view)), { scroll: "preserve" });
    else navigate(viewHref(panelHref(id, null, messageId, route().view)), { scroll: "preserve" });
  };

  /** A chat the person just started, or chose among existing ones, opens in place like a chat from the list. */
  const openChosen = async (id: string | undefined) => {
    if (!id) return;
    const fromList = route().chatId === null;
    if ((await open(chatRoute(id))) !== "applied") return;
    const chosen = store?.openConversation?.conversation;
    const listPath = chosen?.archived ? `${basePath}/archive` : basePath;
    const target = new URL(panelHref(id, null), location.href);
    if (chosen?.archived) target.searchParams.set("list", "archive");
    // The chat has opened successfully. A failed list refresh must not leave the address naming the previous chat.
    navigate(target.pathname + target.search, { scroll: "preserve", state: { chatFromList: fromList } });
    await refreshList(listPath);
  };
  const channelsApi = createChannelApi();
  const [channelRevision, setChannelRevision] = createSignal(0);
  // The SSR catalog seeds only the first mount. Returning later reads current membership and discovery.
  let initialChannelPage = props.channelsPage ? props.channelPage : undefined;
  const takeInitialChannelPage = () => {
    const initial = initialChannelPage;
    initialChannelPage = undefined;
    return initial;
  };
  const discover = async (navigation: LinkNavigateEvent) => {
    if ((await open(chatRoute(null, "all", { channels: true }))) === "applied") navigation.push(listHref(`${basePath}/channels`));
  };
  const subscribe = async (id: string) => {
    await channelsApi.join(id);
    setChannelRevision((revision) => revision + 1);
    await store?.refreshSidebar();
    if (route().chatId === id) await open(route());
  };
  const editDiscovery = async () => {
    const current = conversation();
    if (!store || !current || current.permission !== "admin") return;
    await openChannelDialog({
      store,
      viewerId: props.viewerId,
      locale: locale(),
      guest: props.guest,
      conversation: current,
      onSaved: async () => {
        await store?.refreshSidebar();
        if (route().chatId === current.id) await open(route());
      },
    });
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
      navigate(viewHref(panelHref(current.id, null)), { replace: true, scroll: "preserve" });
    }
  };

  const [unsubscribing, setUnsubscribing] = createSignal(false);
  const unsubscribe = async () => {
    const current = conversation();
    if (!store || !current || unsubscribing()) return;
    setUnsubscribing(true);
    try {
      let canRejoin = false;
      try {
        canRejoin = (await store.leave(current.id)).canRejoin;
      } catch (error) {
        if (!(error instanceof ChatRequestError) || error.status !== 409) throw error;
        // The last manager hands over first; they gave the channel away on purpose, so nothing offers it back.
        if (!(await openLeaveChatDialog({ store, conversation: current, viewerId: props.viewerId, locale: locale() }))) return;
      }
      // Only while the channel is still on screen does the page move on; a chat opened meanwhile stays.
      if (route().chatId === current.id && pendingOpen === 0 && (await open(chatRoute(null, "all", { channels: true }))) === "applied")
        navigate(`${basePath}/channels`, { replace: true });
      // Subscribing again uses the channel's audience, which may not include someone a manager had added directly.
      const done = toast(
        t().unsubscribed({ name: current.title }),
        canRejoin
          ? {
              action: {
                label: t().subscribeAgain,
                onClick: () => {
                  done.dismiss();
                  void subscribe(current.id).catch(() => toast.error(t().requestFailed));
                },
              },
            }
          : undefined,
      );
    } catch {
      toast.error(t().requestFailed);
    } finally {
      setUnsubscribing(false);
    }
  };

  // System chats use item discussions; manual chats let admins create named threads.
  const createThread = async () => {
    const current = conversation();
    if (!store || !current || !canCreateThread() || creatingThread()) return;
    setCreatingThread(true);
    try {
      if (current.kind === "system") {
        if (!current.resource) return;
        const item = await openCloudResourcePicker({
          title: t().discussElement,
          scope: { ref: current.resource, label: current.title, icon: containerIcon(current.resource.type) },
          requireReader: true,
          resourceType: current.resource.type === "notebooks.notebook" ? "notebooks.note" : "spaces.item",
        });
        if (!item || conversation()?.id !== current.id) return;
        if (item.ref.type !== "spaces.item" && item.ref.type !== "notebooks.note") return;
        const thread = await openResourceThread(current.id, { ref: { type: item.ref.type, id: item.ref.id } });
        if (conversation()?.id !== current.id) return;
        await store.refreshThreads();
        await openView(current.id, thread.id);
        return;
      }
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
    } catch (error) {
      if (current.kind === "system") toast.error(t().itemThreadFailed, { duration: 0 });
      else throw error;
    } finally {
      setCreatingThread(false);
    }
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
  const setThreadArchived = async (id: string, threadId: string, archived: boolean) => {
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
      confirmText: t().archiveThread,
    });
    if (!confirmed || !(await setThreadArchived(current.id, thread.id, true))) return;
    // The archived thread stays readable under "Archived"; the reader continues in General.
    await openView(current.id, "general");
    const done = toast(t().threadArchivedToast({ name: thread.name }), {
      iconClass: "ti ti-archive",
      action: {
        label: t().undo,
        onClick: () => {
          done.dismiss();
          void setThreadArchived(current.id, thread.id, false).then(async (restored) => {
            if (restored) await openView(current.id, thread.id);
          });
        },
      },
    });
  };
  const restoreThread = async () => {
    const current = openChat();
    const thread = threadOf(current?.threads ?? null, current?.view);
    if (current && thread && (await setThreadArchived(current.id, thread.id, false))) toast(t().restored);
  };

  // Shared elements resolve in the browser with the reader's own session; the server render shows their placeholders.
  const [cards, setCards] = createSignal<ReturnType<typeof createResourceCards>>();
  onMount(() => {
    const resolver = createResourceCards();
    setCards(resolver);
    // Shown cards read again once a minute while the page is visible, so lost or new access shows without a reload.
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") resolver.tick();
    }, FRESH_MS);
    onCleanup(() => clearInterval(timer));
  });
  const pickResource = async () => {
    const item = await openCloudResourcePicker({ title: t().shareResource, requireReader: true });
    return item ? { ref: item.ref, title: item.title, icon: item.icon ?? item.appIcon } : null;
  };

  // A message goes to the open thread; in "All threads" to General. A reply goes to its original's thread.
  const [reply, setReply] = createSignal<ChatFeedItem | null>(null);
  const replies = new Map<string, ChatFeedItem | null>();
  // A message that only shares Cloud elements has no text.
  const send = async (text: string, refs: readonly CloudResourceRef[] = []): Promise<boolean> => {
    const current = openChat();
    const id = draftId(route());
    const body = refs.length > 0 && !text.trim() ? "" : text;
    if (
      !current ||
      !outbox ||
      refs.length > MAX_MESSAGE_REFS ||
      (body === "" ? refs.length === 0 : !MessageBodySchema.safeParse(body).success) ||
      draftStorageFailed() ||
      (id !== null && draftConflicts()[id] !== undefined) ||
      pendingOpen !== 0
    )
      return false;
    // The composer has cleared its draft, but the outbox does not own it until history is ready.
    pendingSends++;
    try {
      if (current.hasNewer) await store?.loadLatest();
      const answered = reply();
      const thread = answered ? (answered.thread ?? "general") : current.view === "all" ? "general" : current.view;
      outbox.send(current.id, body, {
        thread,
        refs,
        replyTo: answered?.messageId ? { id: answered.messageId, author: answered.authorName, text: answered.body } : null,
      });
      setReply(null);
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
    const opened = draftId(route());
    if (opened) setDraft(readDraft(opened));
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
          if (draftId(route()) === id) setDraft(text);
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
      ...(props.open
        ? { open: { conversation: props.open.conversation, page: props.open.page, threads: props.open.threads, view: props.view } }
        : {}),
    });
    store = live;
    if (props.open?.conversation.kind === "system") void live.refreshThreads();
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
      // Subscriptions changed elsewhere, such as in another tab: the catalog reads them again.
      if (live.subscriptionsVersion !== subscriptionsSeen) {
        subscriptionsSeen = live.subscriptionsVersion;
        setChannelRevision((revision) => revision + 1);
      }
    };
    let subscriptionsSeen = live.subscriptionsVersion;
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
              navigate(listHref(current.chatId ? panelHref(current.chatId, current.panel, current.messageId, current.view) : undefined), {
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
        if (![basePath, `${basePath}/archive`].includes(new URL(href, location.href).pathname) || (!route().chatId && !route().channels))
          return false;
        const depth = listDepth();
        if (depth > 0) history.go(-depth);
        else
          void open(chatRoute(null)).then(
            (result) => result === "applied" && navigate(listHref(archived() ? `${basePath}/archive` : basePath)),
          );
        return true;
      }),
    );
    const activate = () => reporter?.reporter.activate();
    // Back on the catalog after a while away, it reads current subscriptions.
    const revisit = () => {
      if (route().channels && document.visibilityState === "visible") setChannelRevision((revision) => revision + 1);
    };
    document.addEventListener("visibilitychange", revisit);
    onCleanup(() => document.removeEventListener("visibilitychange", revisit));
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
          void open(chatRoute(selected)).then((result) => {
            if (result === "applied") navigate(listHref(panelHref(selected, null)), { replace: true, scroll: "manual" });
          });
        }
      } catch {
        setDraftStorageFailed(true);
      }
    }
  });

  const pinnedRows = () =>
    listRows()
      .filter((row) => row.kind !== "system" && row.pinnedRank !== null)
      .sort((a, b) => a.pinnedRank! - b.pinnedRank!);
  const reorder = (id: string, direction: "up" | "down") => {
    const pins = pinnedRows();
    const neighbor = pins[pins.findIndex((row) => row.id === id) + (direction === "up" ? -1 : 1)];
    if (neighbor) void personal(id, { pinned: true, ...(direction === "up" ? { before: neighbor.id } : { after: neighbor.id }) });
  };
  const listProps = () => ({
    basePath,
    href: (id: string) => listHref(panelHref(id, null)),
    pending: listPending() || listLoading(),
    onPersonal: (id: string, patch: z.infer<typeof PersonalConversationSchema>) => void personal(id, patch),
    activeId: openChat()?.id ?? null,
    viewerId: props.viewerId,
    dateConfig: props.dateConfig,
    now,
    onOpen: openFromList,
    onMarkRead: markRead,
    onMarkUnread: (id: string) => void markUnread(id),
    threads:
      openChat() && threaded()
        ? {
            threads: openChat()?.threads ?? null,
            status: openChat()?.threadsStatus ?? ("loading" as const),
            view: route().threads ? null : (openChat()?.view ?? null),
            canAdmin: canCreateThread(),
            system: system(),
            total: conversation()?.summaryCursor == null ? conversation()?.threads : undefined,
            creating: creatingThread(),
            onOverview: openOverview,
            onNavigate: (view: ThreadView, event: LinkNavigateEvent) => openView(openChat()!.id, view, event),
            onCreate: () => void createThread(),
            onRetry: () => void store?.refreshThreads(),
          }
        : undefined,
  });
  const systemSection = () => (
    <ChatSystemChats
      state={systemList}
      list={listProps()}
      current={conversation()}
      updates={rows()}
      unavailableId={chat()?.status === "no-access" ? chat()!.id : null}
      expanded={systemExpanded()}
      onExpanded={setSystemExpanded}
      onOpen={openSystemFromList}
    />
  );
  const list = (entries: () => readonly Conversation[], pinned = false): JSX.Element => (
    <ChatList
      rows={entries()}
      {...listProps()}
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
  /** The open part of the chat, as the head names it and the composer addresses it. */
  const viewTitle = () => viewName(openChat()?.view ?? "all", openChat()?.threads ?? null, t());
  const openThread = () => (conversation()?.channel ? undefined : threadOf(openChat()?.threads ?? null, openChat()?.view));
  const threaded = () => chatHasThreads(conversation());
  const [subscribing, setSubscribing] = createSignal(false);
  const subscribeOpen = async (id: string) => {
    setSubscribing(true);
    try {
      await subscribe(id);
    } catch {
      toast.error(t().requestFailed);
    } finally {
      setSubscribing(false);
    }
  };
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
    if (current.channel && !current.member)
      return (
        <Button loading={subscribing()} onClick={() => void subscribeOpen(current.id)}>
          {t().subscribe}
        </Button>
      );
    if (current.permission === "read")
      return (
        <>
          <i class="ti ti-eye" aria-hidden="true" />
          <span>{current.channel ? t().channelReadOnly : t().readOnlyIn({ title: current.title })}</span>
        </>
      );
    return undefined;
  };
  const placeholder = () => {
    const current = conversation();
    if (!current) return undefined;
    const answered = reply();
    if (answered)
      return (system() || openChat()?.view === "all") && threaded()
        ? t().replyIn({ name: threadName(answered.thread ?? "general") })
        : t().replyPlaceholder;
    if (!threaded()) return t().composerPlaceholder({ title: current.title });
    return t().composerPlaceholder({ title: openChat()?.view === "all" ? generalName() : viewTitle() });
  };
  const replyHint = (item: ChatFeedItem) =>
    !threaded()
      ? t().replyHintPlain
      : openChat()?.view === "all"
        ? t().replyHintIn({ name: threadName(item.thread ?? "general") })
        : t().replyHint;
  const unreadHint = (item: ChatFeedItem) =>
    threaded() ? t().markUnreadThreadHint({ name: threadName(item.thread ?? "general") }) : t().markUnreadFromHereHint;
  const infoLink = (current: Conversation) => (
    <IconButtonLink
      label={t().chatInfo}
      href={listHref(panelHref(current.id, panel() === "info" ? null : "info", route().messageId, route().view))}
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
                when={listRows().some((row) => row.pinnedRank === null && !row.channel && row.kind !== "system")}
                fallback={
                  <Show when={!hasMore() && !listLoading() && listRows().length === 0}>
                    <Placeholder variant="inline" align="left" description={filter() === "unread" ? t().noUnreadChats : t().noneYet} />
                  </Show>
                }
              >
                {list(() => listRows().filter((row) => row.pinnedRank === null && !row.channel && row.kind !== "system"))}
              </Show>
            </AppWorkspace.SidebarSection>
            <AppWorkspace.SidebarSection
              title={t().channels}
              collapsible
              open={!collapsed().includes("channels")}
              onOpenChange={(open) => void collapse("channels", open)}
            >
              {list(() => listRows().filter((row) => row.channel && row.pinnedRank === null && row.kind !== "system"))}
              <AppWorkspace.SidebarItem
                href={listHref(`${basePath}/channels`)}
                navigation="enhanced"
                onNavigate={discover}
                active={route().channels}
                icon="ti ti-compass"
              >
                {t().browseChannels}
              </AppWorkspace.SidebarItem>
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
      {systemSection()}
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
              route().chatId
                ? conversationHref(route().chatId!, null, route().messageId, route().view)
                : archived()
                  ? "/app/chat/archive"
                  : "/app/chat",
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
                    basePath={basePath}
                    canCreate={canCreateThread()}
                    creating={creatingThread()}
                    revision={(openChat()?.watermark ?? 0) + (openChat()?.threadsRevision ?? 0)}
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
              <Match when={route().channels}>
                <DiscoverChannels
                  initial={takeInitialChannelPage()}
                  query={route().query ?? ""}
                  onQuery={(query) => {
                    setRoute({ ...route(), query });
                    // Typing only rewrites the address; it never animates the page.
                    navigate(`${basePath}/channels${query ? `?q=${encodeURIComponent(query)}` : ""}`, {
                      replace: true,
                      scroll: "preserve",
                      viewTransition: false,
                    });
                  }}
                  revision={channelRevision()}
                  onSubscribe={subscribe}
                  onOpen={(id) => openChosen(id)}
                  onBack={backToList}
                  listHref={basePath}
                />
              </Match>
              <Match when={route().threads && openChat()?.id && threaded() ? conversation() : null}>
                {(current) => (
                  <ChatThreadsPage
                    conversation={current()}
                    basePath={basePath}
                    canCreate={canCreateThread()}
                    creating={creatingThread()}
                    revision={(openChat()?.watermark ?? 0) + (openChat()?.threadsRevision ?? 0)}
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
                            <Show when={props.embedded}>
                              <IconButtonLink
                                href={listHref(conversationHref(current().id, null, route().messageId, route().view))}
                                target={composerReady() ? undefined : "_top"}
                                label={t().openFullView}
                              >
                                <i class="ti ti-arrows-maximize" aria-hidden="true" />
                              </IconButtonLink>
                            </Show>
                            <Show when={!system() && current().permission === "admin"}>
                              <IconButton label={t().addPeople} variant="ghost" onClick={() => void addPeople()}>
                                <i class="ti ti-user-plus" aria-hidden="true" />
                              </IconButton>
                            </Show>
                            <Show when={!system() && current().permission === "admin" && openThread() && !openThread()?.archived}>
                              <ThreadMenu onRename={() => void renameThread()} onArchive={() => void archiveThread()} />
                            </Show>
                            <Show when={current().channel && current().member}>
                              <Dropdown.Root
                                position="bottom-right"
                                items={[
                                  {
                                    label: t().unsubscribe,
                                    icon: "ti ti-bell-off",
                                    description: t().unsubscribeDescription,
                                    disabled: unsubscribing(),
                                    action: () => void unsubscribe(),
                                  },
                                ]}
                              >
                                <Dropdown.Trigger iconOnly label={t().chatActions({ title: current().title })}>
                                  <i class="ti ti-dots" />
                                </Dropdown.Trigger>
                              </Dropdown.Root>
                            </Show>
                            {infoLink(current())}
                          </>
                        }
                        chatId={current().id}
                        title={system() && openThread() ? openThread()!.name : current().title}
                        resource={system() ? (openThread()?.resource ?? undefined) : undefined}
                        // A wider window picks the thread beside the title; a phone names it there and goes back to the
                        // chat's thread page for another one. CSS decides, so server and browser render the same head.
                        titleExtra={
                          threaded() ? (
                            <>
                              <Show when={!system() || !openThread()}>
                                <span class="chat-conversation__thread-name">· {viewTitle()}</span>
                              </Show>
                              <span class="chat-conversation__picker">
                                <ThreadPicker
                                  chatId={current().id}
                                  threads={openChat()?.threads ?? null}
                                  unread={current().unread}
                                  view={openChat()?.view ?? "all"}
                                  basePath={basePath}
                                  canAdmin={canCreateThread()}
                                  system={system()}
                                  total={current().summaryCursor == null ? current().threads : undefined}
                                  creating={creatingThread()}
                                  onOverview={openOverview}
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
                        backHref={threaded() ? listHref(threadsPageHref(current().id)) : undefined}
                        draftKey={`${current().id}:${openChat()?.view ?? "all"}`}
                        notice={draftNotice()}
                        composerNotice={
                          notice() ? (
                            <Show when={readFailure()} fallback={notice()}>
                              {readNotice()}
                            </Show>
                          ) : undefined
                        }
                        placeholder={placeholder()}
                        target={threaded() ? (openChat()?.view === "all" ? generalName() : viewTitle()) : undefined}
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
                        listHref={listHref()}
                        memberCount={current().memberCount}
                        subtitle={
                          system() && openThread()
                            ? current().title
                            : system()
                              ? systemMembers(current().resource?.type, t())
                              : current().channel
                                ? t().subscribers({ count: current().memberCount })
                                : undefined
                        }
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
                          (system() || current().member) &&
                          !draftStorageFailed() &&
                          draftConflicts()[draftId(route()) ?? ""] === undefined
                        }
                        hint={
                          <Show
                            when={readFailure()}
                            fallback={draftError() ?? (liveStopped() ? t().liveStopped : waiting() ? t().messagesWaiting : undefined)}
                          >
                            {readNotice()}
                          </Show>
                        }
                        draft={draft()}
                        onDraftChange={changeDraft}
                        onSend={send}
                        cards={cards()}
                        onPickResource={pickResource}
                        onBack={threaded() ? backToThreads : backToList}
                        busy={busy()}
                        dateConfig={props.dateConfig}
                        now={now}
                        controller={(controller) => {
                          feed = controller;
                        }}
                        markerKey={marker()}
                        unreadGap={unreadGap() ? { key: unreadGap()?.key ?? null, jump: () => void jumpUnreadGap() } : undefined}
                        onVisibleChange={reportVisible}
                        onMarkUnreadFrom={(item) => void markUnread(current().id, item)}
                        reactions={(id) => reactionsById().get(id) ?? []}
                        onReact={react}
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
                  title={t().threadUnavailable}
                  action={
                    <Link href={basePath} onNavigate={backToList}>
                      {t().backToChats}
                    </Link>
                  }
                  description={t().noAccessDescription}
                />
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
                    title={rows().length ? t().selectChatTitle : t().noChatsTitle}
                    description={rows().length ? t().selectChatDescription : t().noChatsDescription}
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
                    onDiscovery={current().permission === "admin" ? () => void editDiscovery() : undefined}
                    onCreateThread={
                      !system() && !current().channel && current().permission === "admin" ? () => void createThread() : undefined
                    }
                    shared={
                      <ChatSharedSection
                        chatId={current().id}
                        revision={openChat() ? `${openChat()!.seqHead}:${openChat()!.accessRev}` : undefined}
                        threads={openChat()?.threads ?? null}
                        viewerId={props.viewerId}
                        dateConfig={props.dateConfig}
                        now={now}
                        cards={cards()}
                        load={(query) => (store ? store.shared(current().id, query) : Promise.reject(new Error("Chat is not live yet")))}
                        onJump={jumpToShared}
                      />
                    }
                    onLeave={() => void (current().channel ? unsubscribe() : leaveChat())}
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
