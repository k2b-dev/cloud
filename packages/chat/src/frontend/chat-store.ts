/**
 * SSR reads chatLive.cursor() BEFORE loading each snapshot. Replay may overlap
 * that snapshot; revisions make the overlap harmless.
 */
import { createApiClient } from "@k2b/cloud/browser";
import { type LiveConnection, type LiveSubscription, liveConnection } from "@k2b/cloud/browser/live";
import type { z } from "zod";
import type { ApiType } from "../api";
import {
  ChangesPageSchema,
  ChatLiveEventSchema,
  ChatSnapshotSchema,
  ConversationPageSchema,
  ConversationSchema,
  MessagePageSchema,
  MessageSchema,
} from "../service/contracts";

type Conversation = z.infer<typeof ConversationSchema>;
type Message = z.infer<typeof MessageSchema>;
type ConversationPage = z.infer<typeof ConversationPageSchema>;
type MessagePage = z.infer<typeof MessagePageSchema>;
type ChangesPage = z.infer<typeof ChangesPageSchema>;
type Summary = Extract<z.infer<typeof ChatLiveEventSchema>, { type: "summary" }>;
export type ChatStoreApi = {
  conversations(cursor?: string): Promise<ConversationPage>;
  conversation(id: string): Promise<Conversation | null>;
  messages(id: string, query?: { before?: number; after?: number }): Promise<MessagePage | null>;
  snapshot(id: string, message?: string): Promise<(OpenChatSnapshot & { focus: string | null }) | null>;
  changes(id: string, afterRev: number): Promise<ChangesPage | "RESYNC_REQUIRED" | null>;
};
export type OpenChatSnapshot = { cursor: string; conversation: Conversation; page: MessagePage };
export type ChatStoreSnapshot = { cursor: string; sidebar: ConversationPage; open?: { conversation: Conversation; page: MessagePage } };
export type OpenChat = {
  id: string;
  status: "live" | "no-access" | "stopped";
  conversation: Conversation | null;
  messages: readonly Message[];
  watermark: number;
  seqHead: number;
  hasOlder: boolean;
  hasNewer: boolean;
};

const parseResponse = async <T>(response: Pick<Response, "status" | "ok" | "json">, schema: z.ZodType<T>): Promise<T | null> => {
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Chat request failed (${response.status})`);
  return schema.parse(await response.json());
};
export const createChatStoreApi = (): ChatStoreApi => {
  const client = createApiClient<ApiType>({ baseUrl: "/api/chat" });
  return {
    conversations: async (cursor) => {
      const page = await parseResponse(await client.conversations.$get({ query: { cursor } }), ConversationPageSchema);
      if (!page) throw new Error("Chat request failed (404)");
      return page;
    },
    conversation: async (id) =>
      parseResponse(await client.conversations[":conversation"].$get({ param: { conversation: id } }), ConversationSchema),
    messages: async (id, query) =>
      parseResponse(
        await client.conversations[":conversation"].messages.$get({
          param: { conversation: id },
          query: { before: query?.before?.toString(), after: query?.after?.toString() },
        }),
        MessagePageSchema,
      ),
    snapshot: async (id, message) =>
      parseResponse(
        await client.conversations[":conversation"].snapshot.$get({ param: { conversation: id }, query: { message } }),
        ChatSnapshotSchema,
      ),
    changes: async (id, afterRev) => {
      const response = await client.conversations[":conversation"].changes.$get({
        param: { conversation: id },
        query: { afterRev: String(afterRev) },
      });
      if (response.status === 409) {
        const result = await response.json();
        if (result.code === "RESYNC_REQUIRED") return "RESYNC_REQUIRED";
      }
      return parseResponse(response, ChangesPageSchema);
    },
  };
};

// The live client's maximum waiting backlog; larger catch-ups load the latest page.
const MAX_CATCHUP_ROWS = 1_000;
export const createChatStore = (snapshot: ChatStoreSnapshot, dependencies: { api?: ChatStoreApi; connection?: LiveConnection } = {}) => {
  const api = dependencies.api ?? createChatStoreApi();
  const connection = dependencies.connection ?? liveConnection("/api/chat/live");
  const listeners = new Set<() => void>();
  // Rows stay in server order: a contiguous prefix of the sidebar, the whole list when `complete`.
  let rows = [...snapshot.sidebar.items];
  let nextCursor = snapshot.sidebar.nextCursor;
  let complete = nextCursor === null;
  let moreSidebar: Promise<void> | null = null;
  let opening = 0;
  let liveStatus: "live" | "stopped" = "live";
  let disposed = false;
  let sidebarWork = Promise.resolve();
  const subscriptions: LiveSubscription[] = [];
  type Current = {
    view: OpenChat;
    metadataRev: number;
    messages: Map<string, Message>;
    subscription: LiveSubscription | null;
    from: number | null;
    to: number | null;
    window: number;
    older: Promise<boolean> | null;
    newer: Promise<boolean> | null;
    latest: Promise<void> | null;
  };
  let current: Current | null = null;
  const notify = () => {
    if (!disposed) for (const listener of listeners) listener();
  };
  const active = (chat: Current) => !disposed && current === chat && chat.view.status === "live";
  const noAccess = (chat: Current) => {
    if (!active(chat)) return;
    chat.view = { ...chat.view, status: "no-access", conversation: null, messages: [], seqHead: 0, hasOlder: false, hasNewer: false };
    chat.messages.clear();
    chat.from = chat.to = null;
    chat.window++;
    chat.subscription?.close();
    chat.subscription = null;
    rows = rows.filter((row) => row.id !== chat.view.id);
    notify();
  };
  const stopped = () => {
    liveStatus = "stopped";
    notify();
  };
  const metadata = (chat: Current, conversation: Conversation) => {
    if (active(chat) && conversation.rev >= (chat.view.conversation?.rev ?? 0)) {
      chat.view = { ...chat.view, conversation };
      chat.metadataRev = Math.max(chat.metadataRev, conversation.rev);
    }
  };
  const extendWindow = (chat: Current) => {
    const sequences = new Set([...chat.messages.values()].map((message) => message.seq));
    if (chat.to === null && sequences.has(1)) chat.from = chat.to = 1;
    if (chat.to !== null) while (sequences.has(chat.to + 1)) chat.to++;
  };
  const applyMessage = (chat: Current, message: Message) => {
    if (!active(chat) || message.conversationId !== chat.view.id) return;
    const known = chat.messages.get(message.id);
    if ((chat.from === null || message.seq >= chat.from) && (known ? message.rev > known.rev : message.rev > chat.view.watermark))
      chat.messages.set(message.id, message);
    chat.view = { ...chat.view, watermark: Math.max(chat.view.watermark, message.rev), seqHead: Math.max(chat.view.seqHead, message.seq) };
    extendWindow(chat);
  };
  const publishMessages = (chat: Current) => {
    if (!active(chat)) return;
    chat.view = {
      ...chat.view,
      messages: [...chat.messages.values()]
        .filter((message) => chat.from !== null && chat.to !== null && message.seq >= chat.from && message.seq <= chat.to)
        .sort((a, b) => a.seq - b.seq),
      hasOlder: chat.from !== null && chat.from > 1,
      hasNewer: chat.to !== null && chat.to < chat.view.seqHead,
    };
    notify();
  };
  const refreshMetadata = async (chat: Current) => {
    const row = await api.conversation(chat.view.id);
    if (!active(chat)) return;
    if (row === null) noAccess(chat);
    else metadata(chat, row);
  };
  const replaceMessages = async (chat: Current) => {
    const watermark = chat.view.watermark;
    const page = await api.messages(chat.view.id);
    if (!active(chat)) return;
    if (page === null) return noAccess(chat);
    const conversation = await api.conversation(chat.view.id);
    if (!active(chat)) return;
    if (conversation === null) return noAccess(chat);
    // Retain arrivals during this read, unless its lower revision proves a restore.
    const arrivals = page.rev >= watermark ? [...chat.messages.values()].filter((message) => message.rev > page.rev) : [];
    const currentConversation = chat.view.conversation;
    const keepMetadata = page.rev >= watermark && currentConversation !== null && currentConversation.rev > conversation.rev;
    // A restored chat can move back in revisions, so the replacement wins over the guard.
    chat.messages = new Map(page.items.map((message) => [message.id, MessageSchema.parse(message)]));
    chat.window++;
    chat.from = page.items[0]?.seq ?? null;
    chat.to = page.items.at(-1)?.seq ?? null;
    chat.view = {
      ...chat.view,
      conversation: keepMetadata ? currentConversation : conversation,
      watermark: page.rev,
      seqHead: page.seqHead,
    };
    chat.metadataRev = keepMetadata ? Math.max(chat.metadataRev, currentConversation.rev, conversation.rev) : conversation.rev;
    for (const message of arrivals) applyMessage(chat, message);
    publishMessages(chat);
  };
  const loadPage = (chat: Current, direction: "older" | "newer"): Promise<boolean> => {
    if (chat[direction]) return chat[direction];
    const boundary = direction === "older" ? chat.from : chat.to;
    if (!active(chat) || boundary === null || !(direction === "older" ? chat.view.hasOlder : chat.view.hasNewer))
      return Promise.resolve(false);
    const window = chat.window;
    const work = (async () => {
      const page = await api.messages(chat.view.id, direction === "older" ? { before: boundary } : { after: boundary });
      if (!active(chat) || chat.window !== window) return false;
      if (page === null) {
        noAccess(chat);
        return false;
      }
      for (const row of page.items) {
        const message = MessageSchema.parse(row);
        const known = chat.messages.get(message.id);
        if (!known || message.rev > known.rev) chat.messages.set(message.id, message);
      }
      chat.view = { ...chat.view, seqHead: Math.max(chat.view.seqHead, page.seqHead, ...page.items.map((message) => message.seq)) };
      if (direction === "older" && chat.from !== null) {
        const sequences = new Set([...chat.messages.values()].map((message) => message.seq));
        while (sequences.has(chat.from - 1)) chat.from--;
      }
      extendWindow(chat);
      publishMessages(chat);
      return direction === "older" ? chat.from !== boundary : chat.to !== boundary;
    })();
    chat[direction] = work;
    void work
      .finally(() => {
        if (chat[direction] === work) chat[direction] = null;
      })
      .catch(() => {});
    return work;
  };
  const resyncConversation = async (chat: Current) => {
    let count = 0;
    // Start at the watermark unless SSR details are still older than its messages.
    let after = Math.min(chat.view.watermark, chat.metadataRev);
    while (active(chat)) {
      const delta = await api.changes(chat.view.id, after);
      if (!active(chat)) return;
      if (delta === null) return noAccess(chat);
      if (delta === "RESYNC_REQUIRED" || count + delta.messages.length > MAX_CATCHUP_ROWS) return replaceMessages(chat);
      if (!delta.more && delta.rev < chat.view.watermark) return replaceMessages(chat);
      count += delta.messages.length;
      if (delta.conversation) metadata(chat, delta.conversation);
      for (const message of delta.messages) applyMessage(chat, MessageSchema.parse(message));
      chat.view = { ...chat.view, watermark: Math.max(chat.view.watermark, delta.rev) };
      chat.metadataRev = Math.max(chat.metadataRev, delta.rev);
      publishMessages(chat);
      if (!delta.more) return;
      if (delta.rev <= after) throw new Error("Chat changes did not advance the watermark");
      after = delta.rev;
    }
  };
  const open = (next: OpenChatSnapshot) => {
    opening++;
    if (disposed) return;
    current?.subscription?.close();
    const chat: Current = {
      view: {
        id: next.conversation.id,
        status: "live",
        conversation: next.conversation,
        watermark: next.page.rev,
        seqHead: Math.max(next.page.seqHead, ...next.page.items.map((message) => message.seq)),
        hasOlder: (next.page.items[0]?.seq ?? 0) > 1,
        hasNewer: next.page.items.length > 0 && next.page.items.at(-1)!.seq < next.page.seqHead,
        messages: next.page.items.map((message) => MessageSchema.parse(message)),
      },
      from: next.page.items[0]?.seq ?? null,
      to: next.page.items.at(-1)?.seq ?? null,
      window: 0,
      older: null,
      newer: null,
      latest: null,
      metadataRev: next.conversation.rev,
      messages: new Map(next.page.items.map((message) => [message.id, MessageSchema.parse(message)])),
      subscription: null,
    };
    current = chat;
    chat.subscription = connection.subscribe(
      "conversation",
      { conversation: chat.view.id },
      {
        cursor: next.cursor,
        parse: (data) => ChatLiveEventSchema.parse(data),
        apply: async (events) => {
          let system = false,
            highestRev = 0;
          for (const { data } of events) {
            if (!active(chat)) return;
            if (data.type !== "message" || data.message.conversationId !== chat.view.id) continue;
            applyMessage(chat, data.message);
            if (data.message.kind === "system") system = true;
            highestRev = Math.max(highestRev, data.message.rev);
          }
          if (system) await refreshMetadata(chat);
          if (active(chat)) chat.metadataRev = Math.max(chat.metadataRev, highestRev);
          publishMessages(chat);
        },
        resync: () => resyncConversation(chat),
        revoked: () => noAccess(chat),
        unavailable: () => {
          if (!active(chat)) return;
          chat.view = { ...chat.view, status: "stopped" };
          stopped();
        },
      },
    );
    if (!active(chat)) chat.subscription.close();
    notify();
  };
  // list and me are independent subscriptions but replace the same sidebar.
  const sidebar = (run: () => Promise<void>) => {
    const work = sidebarWork.then(async () => {
      if (!disposed) await run();
    });
    sidebarWork = work.catch(() => {});
    return work;
  };
  const reloadSidebar = async () => {
    const page = await api.conversations();
    if (disposed) return;
    rows = [...page.items];
    nextCursor = page.nextCursor;
    complete = nextCursor === null;
    notify();
  };
  // Server order is last activity, then ID, both descending. Only unknown rows past an incomplete prefix stay out.
  const place = (row: Conversation) => {
    const rest = rows.filter((other) => other.id !== row.id);
    const index = rest.findIndex(
      (other) => row.lastActivityAt > other.lastActivityAt || (row.lastActivityAt === other.lastActivityAt && row.id > other.id),
    );
    if (index >= 0) rest.splice(index, 0, row);
    else if (complete || rest.length < rows.length) rest.push(row);
    rows = rest;
  };
  const applySummary = async (summary: Summary) => {
    const known = rows.find((row) => row.id === summary.conversationId);
    if (known && summary.rev <= known.rev) return;
    if (!known || summary.kind === "system") {
      const row = await api.conversation(summary.conversationId);
      if (disposed) return;
      if (row === null) {
        rows = rows.filter((other) => other.id !== summary.conversationId);
        if (current?.view.id === summary.conversationId) noAccess(current);
      } else if (known && row.lastActivityAt === known.lastActivityAt) rows = rows.map((other) => (other.id === row.id ? row : other));
      else place(row);
    } else
      place({
        ...known,
        rev: summary.rev,
        lastActivityAt: summary.createdAt,
        lastMessage: { id: summary.id, author: summary.author, preview: summary.preview ?? "", createdAt: summary.createdAt },
      });
    notify();
  };
  subscriptions.push(
    connection.subscribe(
      "list",
      {},
      {
        cursor: snapshot.cursor,
        parse: (data) => ChatLiveEventSchema.parse(data),
        apply: (events) =>
          sidebar(async () => {
            for (const { data } of events) if (data.type === "summary") await applySummary(data);
          }),
        resync: () => sidebar(reloadSidebar),
        unavailable: stopped,
      },
    ),
  );
  subscriptions.push(
    connection.subscribe(
      "me",
      {},
      {
        cursor: snapshot.cursor,
        parse: (data) => ChatLiveEventSchema.parse(data),
        apply: (events) =>
          sidebar(async () => {
            if (events.some(({ data }) => data.type === "membership")) await reloadSidebar();
          }),
        resync: () => sidebar(reloadSidebar),
        unavailable: stopped,
      },
    ),
  );
  if (snapshot.open) open({ ...snapshot.open, cursor: snapshot.cursor });
  return {
    get sidebar(): readonly Conversation[] {
      return rows;
    },
    get hasMoreSidebar() {
      return nextCursor !== null;
    },
    loadMoreSidebar: (): Promise<void> => {
      if (moreSidebar) return moreSidebar;
      if (disposed || nextCursor === null) return Promise.resolve();
      const work = sidebar(async () => {
        if (nextCursor === null) return;
        const page = await api.conversations(nextCursor);
        if (disposed) return;
        const present = new Set(rows.map((row) => row.id));
        const appended = [...rows];
        for (const row of page.items)
          if (!present.has(row.id)) {
            appended.push(row);
            present.add(row.id);
          }
        rows = appended;
        nextCursor = page.nextCursor;
        complete = nextCursor === null;
        notify();
      });
      moreSidebar = work;
      void work
        .finally(() => {
          if (moreSidebar === work) moreSidebar = null;
        })
        .catch(() => {});
      return work;
    },
    loadOlder: () => (current ? loadPage(current, "older") : Promise.resolve(false)),
    loadNewer: () => (current ? loadPage(current, "newer") : Promise.resolve(false)),
    loadLatest: (): Promise<void> => {
      const chat = current;
      if (!chat || !active(chat) || !chat.view.hasNewer) return Promise.resolve();
      if (chat.latest) return chat.latest;
      const work = replaceMessages(chat);
      chat.latest = work;
      void work
        .finally(() => {
          if (chat.latest === work) chat.latest = null;
        })
        .catch(() => {});
      return work;
    },
    openChat: async (
      id: string,
      message?: string,
    ): Promise<{ status: "opened"; focus: string | null } | { status: "no-access" } | { status: "superseded" }> => {
      const request = ++opening;
      if (disposed) return { status: "superseded" };
      const next = await api.snapshot(id, message);
      if (disposed || request !== opening) return { status: "superseded" };
      if (next) {
        open(next);
        return { status: "opened", focus: next.focus };
      }
      current?.subscription?.close();
      const chat: Current = {
        view: { id, status: "live", conversation: null, messages: [], watermark: 0, seqHead: 0, hasOlder: false, hasNewer: false },
        metadataRev: 0,
        messages: new Map(),
        subscription: null,
        from: null,
        to: null,
        window: 0,
        older: null,
        newer: null,
        latest: null,
      };
      current = chat;
      noAccess(chat);
      return { status: "no-access" };
    },
    get openConversation(): OpenChat | null {
      return current?.view ?? null;
    },
    get liveStatus() {
      return liveStatus;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open,
    closeConversation: () => {
      opening++;
      current?.subscription?.close();
      current = null;
      notify();
    },
    dispose: () => {
      opening++;
      disposed = true;
      current?.subscription?.close();
      for (const subscription of subscriptions) subscription.close();
      listeners.clear();
    },
  };
};
