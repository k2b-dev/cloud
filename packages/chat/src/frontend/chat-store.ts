/**
 * SSR reads chatLive.cursor() BEFORE loading each snapshot. Replay may overlap
 * that snapshot; revisions make the overlap harmless. Slice 1.5 owns rendering.
 */
import { createApiClient } from "@k2b/cloud/browser";
import { type LiveConnection, type LiveSubscription, liveConnection } from "@k2b/cloud/browser/live";
import type { z } from "zod";
import type { ApiType } from "../api";
import {
  ChangesPageSchema,
  ChatLiveEventSchema,
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
  conversations(): Promise<ConversationPage>;
  conversation(id: string): Promise<Conversation | null>;
  messages(id: string): Promise<MessagePage | null>;
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
};

const parseResponse = async <T>(response: Pick<Response, "status" | "ok" | "json">, schema: z.ZodType<T>): Promise<T | null> => {
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Chat request failed (${response.status})`);
  return schema.parse(await response.json());
};
export const createChatStoreApi = (): ChatStoreApi => {
  const client = createApiClient<ApiType>({ baseUrl: "/api/chat" });
  return {
    conversations: async () => {
      const page = await parseResponse(await client.conversations.$get({ query: {} }), ConversationPageSchema);
      if (!page) throw new Error("Chat request failed (404)");
      return page;
    },
    conversation: async (id) =>
      parseResponse(await client.conversations[":conversation"].$get({ param: { conversation: id } }), ConversationSchema),
    messages: async (id) =>
      parseResponse(
        await client.conversations[":conversation"].messages.$get({ param: { conversation: id }, query: {} }),
        MessagePageSchema,
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
  let complete = snapshot.sidebar.nextCursor === null;
  let liveStatus: "live" | "stopped" = "live";
  let disposed = false;
  let sidebarWork = Promise.resolve();
  const subscriptions: LiveSubscription[] = [];
  type Current = { view: OpenChat; messages: Map<string, Message>; subscription: LiveSubscription | null };
  let current: Current | null = null;
  const notify = () => {
    if (!disposed) for (const listener of listeners) listener();
  };
  const active = (chat: Current) => !disposed && current === chat && chat.view.status === "live";
  const noAccess = (chat: Current) => {
    if (!active(chat)) return;
    chat.view = { ...chat.view, status: "no-access", conversation: null, messages: [] };
    chat.messages.clear();
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
    if (active(chat) && conversation.rev >= (chat.view.conversation?.rev ?? 0)) chat.view = { ...chat.view, conversation };
  };
  // A message the watermark already covers is unknown only when it lies before the loaded history; skip it.
  const applyMessage = (chat: Current, message: Message) => {
    if (!active(chat) || message.conversationId !== chat.view.id) return;
    const known = chat.messages.get(message.id);
    if (known ? message.rev > known.rev : message.rev > chat.view.watermark) chat.messages.set(message.id, message);
    chat.view = { ...chat.view, watermark: Math.max(chat.view.watermark, message.rev) };
  };
  const publishMessages = (chat: Current) => {
    if (!active(chat)) return;
    chat.view = { ...chat.view, messages: [...chat.messages.values()].sort((a, b) => a.seq - b.seq) };
    notify();
  };
  const refreshMetadata = async (chat: Current) => {
    const row = await api.conversation(chat.view.id);
    if (!active(chat)) return;
    if (row === null) noAccess(chat);
    else metadata(chat, row);
  };
  const replaceMessages = async (chat: Current) => {
    const page = await api.messages(chat.view.id);
    if (!active(chat)) return;
    if (page === null) return noAccess(chat);
    const conversation = await api.conversation(chat.view.id);
    if (!active(chat)) return;
    if (conversation === null) return noAccess(chat);
    // A restored chat can move back in revisions, so the replacement wins over the guard.
    chat.messages = new Map(page.items.map((message) => [message.id, MessageSchema.parse(message)]));
    chat.view = { ...chat.view, conversation, watermark: page.rev };
    publishMessages(chat);
  };
  const resyncConversation = async (chat: Current) => {
    let count = 0;
    // Start at the older of messages and metadata: an SSR snapshot may have read them at different revisions.
    let after = Math.min(chat.view.watermark, chat.view.conversation?.rev ?? 0);
    while (active(chat)) {
      const delta = await api.changes(chat.view.id, after);
      if (!active(chat)) return;
      if (delta === null) return noAccess(chat);
      if (delta === "RESYNC_REQUIRED" || count + delta.messages.length > MAX_CATCHUP_ROWS) return replaceMessages(chat);
      count += delta.messages.length;
      if (delta.conversation) metadata(chat, delta.conversation);
      for (const message of delta.messages) applyMessage(chat, MessageSchema.parse(message));
      chat.view = { ...chat.view, watermark: Math.max(chat.view.watermark, delta.rev) };
      publishMessages(chat);
      if (!delta.more) return;
      if (delta.rev <= after) throw new Error("Chat changes did not advance the watermark");
      after = delta.rev;
    }
  };
  const open = (next: OpenChatSnapshot) => {
    if (disposed) return;
    current?.subscription?.close();
    const chat: Current = {
      view: {
        id: next.conversation.id,
        status: "live",
        conversation: next.conversation,
        watermark: next.page.rev,
        messages: next.page.items.map((message) => MessageSchema.parse(message)),
      },
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
          for (const { data } of events) {
            if (!active(chat)) return;
            if (data.type !== "message" || data.message.conversationId !== chat.view.id) continue;
            if (data.message.kind === "system") await refreshMetadata(chat);
            applyMessage(chat, data.message);
          }
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
    complete = page.nextCursor === null;
    notify();
  };
  // Server order is last activity, then ID, both descending. A row that sorts after the loaded prefix stays out.
  const place = (row: Conversation) => {
    const rest = rows.filter((other) => other.id !== row.id);
    const index = rest.findIndex(
      (other) => row.lastActivityAt > other.lastActivityAt || (row.lastActivityAt === other.lastActivityAt && row.id > other.id),
    );
    if (index >= 0) rest.splice(index, 0, row);
    else if (complete) rest.push(row);
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
    } else place({ ...known, rev: summary.rev, lastActivityAt: summary.createdAt });
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
      current?.subscription?.close();
      current = null;
      notify();
    },
    dispose: () => {
      disposed = true;
      current?.subscription?.close();
      for (const subscription of subscriptions) subscription.close();
      listeners.clear();
    },
  };
};
