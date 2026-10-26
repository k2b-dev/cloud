/**
 * SSR reads chatLive.cursor() BEFORE loading each snapshot. Replay may overlap
 * that snapshot; revisions make the overlap harmless.
 */
import { createApiClient } from "@k2b/cloud/browser";
import { type LiveConnection, type LiveSubscription, liveConnection } from "@k2b/cloud/browser/live";
import { z } from "zod";
import type { ApiType } from "../api";
import { chatMessages } from "../messages";
import {
  ChangeSchema,
  ChangesPageSchema,
  ChatLiveEventSchema,
  ChatSnapshotSchema,
  CONVERSATION_PAGE_SIZE,
  ConversationPageSchema,
  ConversationSchema,
  type CreateConversationSchema,
  CreateOutcomeSchema,
  LeaveResultSchema,
  MemberPageSchema,
  MemberPreviewSchema,
  type MemberPrincipal,
  MemberRemovalSchema,
  MessagePageSchema,
  MessageSchema,
  PeoplePageSchema,
  type PermissionSchema,
  type PersonalConversationSchema,
  ReactionsSchema,
  ReadAllOutcomeSchema,
  ReadUpdateSchema,
  readStart,
  SharedPageSchema,
  type SharedQuerySchema,
  SidebarPreferencesSchema,
  SuccessSchema,
  ThreadListSchema,
  ThreadSchema,
  UNREAD_CAP,
} from "../service/contracts";
import { chatHasThreads, inView, type ThreadList, type ThreadView } from "./threads";

type Conversation = z.infer<typeof ConversationSchema>;
type Message = z.infer<typeof MessageSchema>;
type ConversationPage = z.infer<typeof ConversationPageSchema>;
type MessagePage = z.infer<typeof MessagePageSchema>;
type ChangesPage = z.infer<typeof ChangesPageSchema>;
type Summary = Extract<z.infer<typeof ChatLiveEventSchema>, { type: "summary" }>;
const compareRows = (a: Conversation, b: Conversation) =>
  (a.pinnedRank ?? 2147483647) - (b.pinnedRank ?? 2147483647) ||
  b.lastActivityAt.localeCompare(a.lastActivityAt) ||
  b.id.localeCompare(a.id);
export type ChatStoreApi = {
  personal(id: string, patch: z.infer<typeof PersonalConversationSchema>): Promise<Conversation>;
  preferences(): Promise<z.infer<typeof SidebarPreferencesSchema>>;
  savePreferences(collapsed: z.infer<typeof SidebarPreferencesSchema>["collapsed"]): Promise<z.infer<typeof SidebarPreferencesSchema>>;
  react(id: string, message: string, emoji: string, on: boolean): Promise<void>;
  reactions(id: string, message: string): Promise<z.infer<typeof ReactionsSchema>>;
  create(input: z.input<typeof CreateConversationSchema>): Promise<z.infer<typeof CreateOutcomeSchema>>;
  updateDetails(id: string, patch: { name?: string | null; icon?: string | null; purpose?: string | null }): Promise<Conversation>;
  members(id: string, query: { q?: string; cursor?: string }): Promise<z.infer<typeof MemberPageSchema>>;
  shared(id: string, query: z.input<typeof SharedQuerySchema>): Promise<z.infer<typeof SharedPageSchema>>;
  previewMembers(id: string, members: MemberPrincipal[]): Promise<z.infer<typeof MemberPreviewSchema>>;
  addMembers(id: string, members: MemberPrincipal[]): Promise<z.infer<typeof ChangeSchema>>;
  updateMember(id: string, accessId: string, permission: z.infer<typeof PermissionSchema>): Promise<z.infer<typeof SuccessSchema>>;
  removeMember(id: string, accessId: string): Promise<z.infer<typeof MemberRemovalSchema>>;
  leave(id: string, successor?: string): Promise<z.infer<typeof LeaveResultSchema>>;
  people(search: string, cursor?: string, signal?: AbortSignal): Promise<z.infer<typeof PeoplePageSchema>>;
  read(
    id: string,
    seq: number,
    thread?: ThreadView,
    summaryCursor?: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof ReadUpdateSchema>>;
  markUnread(id: string, message?: string): Promise<z.infer<typeof ReadUpdateSchema>>;
  readAll(confirmed: boolean, cursor?: string): Promise<z.infer<typeof ReadAllOutcomeSchema>>;
  conversations(cursor?: string, archived?: boolean, unread?: boolean, ids?: string[]): Promise<ConversationPage>;
  conversation(id: string): Promise<Conversation | null>;
  messages(id: string, query?: { before?: number; after?: number; thread?: ThreadView }): Promise<MessagePage | null>;
  snapshot(id: string, message?: string, thread?: ThreadView): Promise<(OpenChatSnapshot & { focus: string | null }) | null>;
  threads(id: string, query?: { cursor?: string; short?: "true"; selected?: string }, signal?: AbortSignal): Promise<ThreadList | null>;
  createThread(id: string, input: { name: string; description: string | null; createKey: string }): Promise<z.infer<typeof ThreadSchema>>;
  updateThread(
    id: string,
    thread: string,
    patch: { name?: string; description?: string | null; archived?: boolean },
  ): Promise<z.infer<typeof ThreadSchema>>;
  changes(id: string, afterRev: number): Promise<ChangesPage | "RESYNC_REQUIRED" | null>;
};
export type OpenChatSnapshot = { cursor: string; conversation: Conversation; page: MessagePage; threads: ThreadList };
export type ChatStoreSnapshot = {
  collapsed?: z.infer<typeof SidebarPreferencesSchema>["collapsed"];
  archived?: boolean;
  unread?: boolean;
  viewerId: string;
  cursor: string;
  sidebar: ConversationPage;
  open?: { conversation: Conversation; page: MessagePage; threads: ThreadList; view: ThreadView };
};
export type OpenChat = {
  id: string;
  /** The open part of the chat: "all", "general", or a thread's ID. Only its messages are in `messages`. */
  view: ThreadView;
  threads: ThreadList | null;
  threadsStatus: "ready" | "loading" | "failed";
  threadsRevision: number;
  status: "live" | "no-access" | "stopped";
  caughtUp: boolean;
  conversation: Conversation | null;
  messages: readonly Message[];
  membershipRev: number;
  /** Changes with every opening and replacement of the loaded history (access reconciliation, the jump to the latest
   * messages, a restore), which can remove messages without a newer revision. Never repeats within a store. */
  historyRev: number;
  watermark: number;
  seqHead: number;
  hasOlder: boolean;
  hasNewer: boolean;
};

export class ChatRequestError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly status: number,
  ) {
    super(message);
    this.name = "ChatRequestError";
  }
}
const requestError = async (response: Pick<Response, "status" | "json">) => {
  const body = z.object({ code: z.string().optional(), message: z.string() }).safeParse(await response.json().catch(() => null));
  const generic = chatMessages.resolve(typeof document === "undefined" ? [] : [document.documentElement.lang]).t.requestFailed;
  return new ChatRequestError(body.success ? body.data.message : generic, body.success ? body.data.code : undefined, response.status);
};
const parseResponse = async <T>(response: Pick<Response, "status" | "ok" | "json">, schema: z.ZodType<T>): Promise<T | null> => {
  if (response.status === 404) return null;
  if (!response.ok) throw await requestError(response);
  return schema.parse(await response.json());
};
export const createChatStoreApi = (): ChatStoreApi => {
  const client = createApiClient<ApiType>({ baseUrl: "/api/chat" });
  const requiredResponse = async <T>(response: Pick<Response, "status" | "ok" | "json">, schema: z.ZodType<T>) => {
    if (!response.ok) throw await requestError(response);
    return schema.parse(await response.json());
  };
  return {
    personal: async (id, patch) =>
      requiredResponse(
        await client.conversations[":conversation"].personal.$put({ param: { conversation: id }, json: patch }),
        ConversationSchema,
      ),
    preferences: async () => requiredResponse(await client.preferences.$get(), SidebarPreferencesSchema),
    savePreferences: async (collapsed) =>
      requiredResponse(await client.preferences.$put({ json: { collapsed } }), SidebarPreferencesSchema),
    react: async (id, message, emoji, on) => {
      const route = client.conversations[":conversation"].messages[":message"].reactions[":emoji"];
      const request = { param: { conversation: id, message, emoji } };
      const response = on ? await route.$put(request) : await route.$delete(request);
      if (!response.ok) throw await requestError(response);
    },
    reactions: async (id, message) =>
      requiredResponse(
        await client.conversations[":conversation"].messages[":message"].reactions.$get({ param: { conversation: id, message } }),
        ReactionsSchema,
      ),
    create: async (input) => requiredResponse(await client.conversations.$post({ json: input }), CreateOutcomeSchema),
    updateDetails: async (id, patch) =>
      requiredResponse(
        await client.conversations[":conversation"].$patch({ param: { conversation: id }, json: patch }),
        ConversationSchema,
      ),
    members: async (id, query) =>
      requiredResponse(await client.conversations[":conversation"].members.$get({ param: { conversation: id }, query }), MemberPageSchema),
    shared: async (id, query) =>
      requiredResponse(await client.conversations[":conversation"].shared.$get({ param: { conversation: id }, query }), SharedPageSchema),
    previewMembers: async (id, members) =>
      requiredResponse(
        await client.conversations[":conversation"].members.preview.$post({ param: { conversation: id }, json: { members } }),
        MemberPreviewSchema,
      ),
    addMembers: async (id, members) =>
      requiredResponse(
        await client.conversations[":conversation"].members.$post({ param: { conversation: id }, json: { members } }),
        ChangeSchema,
      ),
    updateMember: async (id, accessId, permission) =>
      requiredResponse(
        await client.conversations[":conversation"].members[":accessId"].$patch({
          param: { conversation: id, accessId },
          json: { permission },
        }),
        SuccessSchema,
      ),
    removeMember: async (id, accessId) =>
      requiredResponse(
        await client.conversations[":conversation"].members[":accessId"].$delete({ param: { conversation: id, accessId } }),
        MemberRemovalSchema,
      ),
    leave: async (id, successor) =>
      requiredResponse(
        await client.conversations[":conversation"].leave.$post({ param: { conversation: id }, json: { successor } }),
        LeaveResultSchema,
      ),
    people: async (search, cursor, signal) =>
      requiredResponse(await client.people.$get({ query: { search, cursor } }, { init: { signal } }), PeoplePageSchema),

    read: async (id, seq, thread, summaryCursor, signal) =>
      requiredResponse(
        await client.conversations[":conversation"].read.$post(
          {
            param: { conversation: id },
            json: { seq, ...(thread ? { thread } : {}), summaryCursor },
          },
          { init: { signal } },
        ),
        ReadUpdateSchema,
      ),
    markUnread: async (id, message) =>
      requiredResponse(
        await client.conversations[":conversation"].unread.$post({ param: { conversation: id }, json: { message } }),
        ReadUpdateSchema,
      ),
    readAll: async (confirmed, cursor) =>
      requiredResponse(await client.conversations["read-all"].$post({ json: { confirmed, cursor } }), ReadAllOutcomeSchema),
    conversations: async (cursor, archived, unread, ids) =>
      requiredResponse(
        await client.conversations.$get({
          query: { cursor, archived: archived ? "true" : "false", unread: unread ? "true" : "false", ids: ids?.join(",") },
        }),
        ConversationPageSchema,
      ),
    conversation: async (id) =>
      parseResponse(await client.conversations[":conversation"].$get({ param: { conversation: id }, query: {} }), ConversationSchema),
    messages: async (id, query) =>
      parseResponse(
        await client.conversations[":conversation"].messages.$get({
          param: { conversation: id },
          query: {
            before: query?.before?.toString(),
            after: query?.after?.toString(),
            ...(query?.thread && query.thread !== "all" ? { thread: query.thread } : {}),
          },
        }),
        MessagePageSchema,
      ),
    snapshot: async (id, message, thread) =>
      parseResponse(
        await client.conversations[":conversation"].snapshot.$get({
          param: { conversation: id },
          query: { message, ...(thread && thread !== "all" ? { thread } : {}) },
        }),
        ChatSnapshotSchema,
      ),
    threads: async (id, query = {}, signal) =>
      parseResponse(
        await client.conversations[":conversation"].threads.$get({ param: { conversation: id }, query }, { init: { signal } }),
        ThreadListSchema,
      ),
    createThread: async (id, input) =>
      requiredResponse(
        await client.conversations[":conversation"].threads.$post({ param: { conversation: id }, json: input }),
        ThreadSchema,
      ),
    updateThread: async (id, thread, patch) =>
      requiredResponse(
        await client.conversations[":conversation"].threads[":thread"].$patch({ param: { conversation: id, thread }, json: patch }),
        ThreadSchema,
      ),
    changes: async (id, afterRev) => {
      const response = await client.conversations[":conversation"].changes.$get({
        param: { conversation: id },
        query: { afterRev: String(afterRev) },
      });
      if (response.status === 409) {
        const result = z.object({ code: z.string().optional() }).safeParse(
          await response
            .clone()
            .json()
            .catch(() => null),
        );
        if (result.success && result.data.code === "RESYNC_REQUIRED") return "RESYNC_REQUIRED";
      }
      return parseResponse(response, ChangesPageSchema);
    },
  };
};

const membershipCodes = new Set([
  "members_added",
  "groups_added",
  "group_removed",
  "manager_assigned",
  "member_removed",
  "member_left",
  "permission_changed",
]);

// The live client's maximum waiting backlog; larger catch-ups load the latest page.
const MAX_CATCHUP_ROWS = 1_000;
export const createChatStore = (snapshot: ChatStoreSnapshot, dependencies: { api?: ChatStoreApi; connection?: LiveConnection } = {}) => {
  const api = dependencies.api ?? createChatStoreApi();
  const connection = dependencies.connection ?? liveConnection("/api/chat/live");
  const listeners = new Set<() => void>();
  // Rows stay in server order: a contiguous prefix of the sidebar, the whole list when `complete`.
  let collapsed = snapshot.collapsed ?? [];
  let archived = snapshot.archived ?? false;
  let unread = snapshot.unread ?? false;
  let rows = [...snapshot.sidebar.items];
  const excludedRows = new Set<string>();
  const unreadRev = new Map(rows.map((row) => [row.id, row.rev]));
  let nextCursor = snapshot.sidebar.nextCursor;
  let complete = nextCursor === null;
  let moreSidebar: Promise<void> | null = null;
  let opening = 0;
  let liveStatus: "live" | "stopped" = "live";
  let disposed = false;
  const lifetime = new AbortController();
  let sidebarWork = Promise.resolve();
  const subscriptions: LiveSubscription[] = [];
  type Current = {
    view: OpenChat;
    metadataRev: number;
    // Only a covering snapshot rules out unseen messages; live revisions can arrive with replay gaps.
    snapshotRev: number;
    messages: Map<string, Message>;
    subscription: LiveSubscription | null;
    from: number | null;
    to: number | null;
    window: number;
    /** Access reconciliations in flight; an ordinary replacement never commits while one runs. */
    reconciling?: number;
    older: Promise<boolean> | null;
    newer: Promise<boolean> | null;
    latest: Promise<void> | null;
    threadsWork: Promise<void> | null;
    threadsAgain: boolean;
    readsAbort: AbortController;
    threadsAbort?: AbortController;
  };
  let current: Current | null = null;
  // One sequence for every opened or replaced history, so reopening a chat never repeats an earlier value.
  let historyGeneration = 0;
  const notify = () => {
    if (!disposed) for (const listener of listeners) listener();
  };
  const active = (chat: Current) => !disposed && current === chat && chat.view.status === "live";
  const noAccess = (chat: Current) => {
    if (!active(chat)) return;
    chat.view = {
      ...chat.view,
      status: "no-access",
      conversation: null,
      threads: null,
      messages: [],
      seqHead: 0,
      hasOlder: false,
      hasNewer: false,
    };
    chat.threadsAbort?.abort();
    chat.readsAbort.abort();
    chat.messages.clear();
    chat.from = chat.to = null;
    chat.window++;
    chat.subscription?.close();
    chat.subscription = null;
    rows = rows.filter((row) => row.id !== chat.view.id);
    unreadRev.delete(chat.view.id);
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
  type ReactionChange = { emoji: string; on: boolean };
  type ReactionWork = { base: Message["reactions"]; pending: ReactionChange[]; tail: Promise<void> };
  const reactionWork = new WeakMap<Current, Map<string, ReactionWork>>();
  const changeReaction = (items: Message["reactions"], { emoji, on }: ReactionChange): Message["reactions"] => {
    const known = items.find((item) => item.emoji === emoji);
    if ((known?.own ?? false) === on) return items;
    if (!known) return [...items, { emoji, count: 1, own: true }];
    return items.flatMap((item) =>
      item !== known ? [item] : item.count === 1 && !on ? [] : [{ ...item, count: item.count + (on ? 1 : -1), own: on }],
    );
  };
  const pendingReactions = (chat: Current, message: Message): Message => {
    const work = reactionWork.get(chat)?.get(message.id);
    if (!work) return message;
    work.base = message.reactions;
    return { ...message, reactions: work.pending.reduce(changeReaction, work.base) };
  };
  const applyMessage = (chat: Current, message: Message) => {
    if (!active(chat) || message.conversationId !== chat.view.id) return;
    const known = chat.messages.get(message.id);
    if ((chat.from === null || message.seq >= chat.from) && (known ? message.rev > known.rev : message.rev > chat.snapshotRev))
      chat.messages.set(message.id, pendingReactions(chat, message));
    chat.view = { ...chat.view, watermark: Math.max(chat.view.watermark, message.rev), seqHead: Math.max(chat.view.seqHead, message.seq) };
    extendWindow(chat);
  };
  const publishMessages = (chat: Current, notifyListeners = true) => {
    if (!active(chat)) return;
    chat.view = {
      ...chat.view,
      messages: [...chat.messages.values()]
        .filter(
          (message) =>
            chat.from !== null && chat.to !== null && message.seq >= chat.from && message.seq <= chat.to && inView(chat.view.view, message),
        )
        .sort((a, b) => a.seq - b.seq),
      hasOlder: chat.from !== null && chat.from > 1,
      hasNewer: chat.to !== null && chat.to < chat.view.seqHead,
    };
    if (notifyListeners) notify();
  };
  const refreshMetadata = async (chat: Current) => {
    const row = await api.conversation(chat.view.id);
    if (!active(chat)) return;
    if (row === null) noAccess(chat);
    else metadata(chat, row);
  };
  const replaceMessages = async (chat: Current, reconcileAccess = false) => {
    if (!reconcileAccess) return commitMessages(chat, false);
    chat.reconciling = (chat.reconciling ?? 0) + 1;
    try {
      await commitMessages(chat, true);
    } finally {
      chat.reconciling = (chat.reconciling ?? 1) - 1;
    }
  };
  const commitMessages = async (chat: Current, reconcileAccess: boolean) => {
    // Access reconciliation supersedes pending reads, including reads that began while it was in flight, and an
    // ordinary replacement never commits while a reconciliation runs, whichever finishes first. A delayed latest
    // response must not restore revoked content, nor cancel the reconciliation that removes it.
    if (reconcileAccess) chat.window++;
    const window = chat.window;
    const superseded = () => !active(chat) || (!reconcileAccess && (chat.reconciling ?? 0) > 0);
    const watermark = chat.view.watermark;
    if (superseded()) return;
    const page = await api.messages(chat.view.id, { thread: chat.view.view });
    if (superseded() || chat.window !== window) return;
    if (page === null) return noAccess(chat);
    const conversation = await api.conversation(chat.view.id);
    if (superseded() || chat.window !== window) return;
    if (conversation === null) return noAccess(chat);
    // Retain arrivals during this read, unless its lower revision proves a restore.
    const arrivals =
      !reconcileAccess && page.rev >= watermark ? [...chat.messages.values()].filter((message) => message.rev > page.rev) : [];
    const currentConversation = chat.view.conversation;
    const keepMetadata = page.rev >= watermark && currentConversation !== null && currentConversation.rev > conversation.rev;
    // A restored chat can move back in revisions, so the replacement wins over the guard.
    chat.snapshotRev = page.rev;
    chat.messages = new Map(page.items.map((message) => [message.id, pendingReactions(chat, MessageSchema.parse(message))]));
    chat.window++;
    // The page says which positions it covers for the open view, also between messages of other threads.
    chat.from = page.from;
    chat.to = page.to;
    chat.view = {
      ...chat.view,
      conversation: keepMetadata ? currentConversation : conversation,
      watermark: page.rev,
      seqHead: page.seqHead,
      historyRev: ++historyGeneration,
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
      const page = await api.messages(
        chat.view.id,
        direction === "older" ? { before: boundary, thread: chat.view.view } : { after: boundary, thread: chat.view.view },
      );
      if (!active(chat) || chat.window !== window) return false;
      if (page === null) {
        noAccess(chat);
        return false;
      }
      for (const row of page.items) {
        const message = MessageSchema.parse(row);
        const known = chat.messages.get(message.id);
        if (!known || message.rev > known.rev) chat.messages.set(message.id, pendingReactions(chat, message));
      }
      chat.view = { ...chat.view, seqHead: Math.max(chat.view.seqHead, page.seqHead, ...page.items.map((message) => message.seq)) };
      if (direction === "older" && chat.from !== null) chat.from = Math.min(chat.from, page.from);
      if (direction === "newer" && chat.to !== null) chat.to = Math.max(chat.to, page.to);
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
    // A filtered delta cannot describe removals from the authorized window.
    if (chat.view.conversation?.kind === "system") {
      await replaceMessages(chat, true);
      if (active(chat)) {
        chat.view = { ...chat.view, membershipRev: chat.view.membershipRev + 1 };
        await refreshThreads(chat);
      }
      return;
    }
    let count = 0;
    // Start at the watermark unless SSR details are still older than its messages.
    let after = Math.min(chat.view.watermark, chat.metadataRev);
    while (active(chat)) {
      const delta = await api.changes(chat.view.id, after);
      if (!active(chat)) return;
      if (delta === null) return noAccess(chat);
      if (
        delta === "RESYNC_REQUIRED" ||
        count + delta.messages.length > MAX_CATCHUP_ROWS ||
        (!delta.more && delta.rev < chat.view.watermark)
      ) {
        await replaceMessages(chat);
        break;
      }
      count += delta.messages.length;
      if (delta.conversation) metadata(chat, delta.conversation);
      for (const message of delta.messages) applyMessage(chat, MessageSchema.parse(message));
      chat.view = { ...chat.view, watermark: Math.max(chat.view.watermark, delta.rev) };
      chat.metadataRev = Math.max(chat.metadataRev, delta.rev);
      publishMessages(chat);
      if (!delta.more) break;
      if (delta.rev <= after) throw new Error("Chat changes did not advance the watermark");
      after = delta.rev;
    }
    if (active(chat)) {
      chat.view = { ...chat.view, membershipRev: chat.view.membershipRev + 1 };
      notify();
    }
    // Thread changes and reads missed while away are in no message delta.
    await refreshThreads(chat);
  };
  // The threads' counts, last messages, and order come from the server, after every change that may touch them. A
  // refresh asked for while one runs runs once more after it, so a burst of messages costs two requests.
  const refreshThreads = (chat: Current): Promise<void> => {
    if (chat.threadsWork) {
      chat.threadsAgain = true;
      return chat.threadsWork;
    }
    const work = (async () => {
      // The caller stores this work before it runs, and it is released in the same step as the last check, so a refresh
      // asked for at any moment either joins a loop that checks again or starts a new one.
      await null;
      try {
        do {
          chat.threadsAgain = false;
          if (!active(chat)) return;
          chat.threadsAbort?.abort();
          const controller = new AbortController();
          chat.threadsAbort = controller;
          const system = chat.view.conversation?.kind === "system";
          const list = await api
            .threads(
              chat.view.id,
              system
                ? {
                    short: "true",
                    ...(chat.view.view !== "all" && chat.view.view !== "general" ? { selected: chat.view.view } : {}),
                  }
                : {},
              controller.signal,
            )
            .catch(() => undefined);
          if (!active(chat)) return;
          if (list === null) return noAccess(chat);
          // A short system list is a selection, never an aggregate of the whole directory.
          const conversation =
            !system && list && chat.view.conversation ? { ...chat.view.conversation, threads: list.items.length } : chat.view.conversation;
          chat.view =
            list === undefined
              ? { ...chat.view, threadsStatus: "failed" }
              : { ...chat.view, conversation, threads: list, threadsStatus: "ready", threadsRevision: chat.view.threadsRevision + 1 };
          notify();
        } while (chat.threadsAgain);
      } finally {
        chat.threadsWork = null;
      }
    })();
    chat.threadsWork = work;
    return work;
  };
  const subscribeConversation = (chat: Current, cursor: string): LiveSubscription => {
    return connection.subscribe(
      "conversation",
      { conversation: chat.view.id },
      {
        cursor,
        parse: (data) => ChatLiveEventSchema.parse(data),
        apply: async (events) => {
          let system = false,
            membership = false,
            highestRev = 0;
          let threadsChanged = false;
          const reactionHints = new Map<string, number>();
          for (const { data } of events) {
            if (!active(chat)) return;
            if (data.type === "reactions" && data.conversationId === chat.view.id) {
              const known = chat.messages.get(data.messageId);
              if (known && data.rev > known.rev)
                reactionHints.set(data.messageId, Math.max(data.rev, reactionHints.get(data.messageId) ?? 0));
            }
            if (data.type === "threads" && data.conversationId === chat.view.id) threadsChanged = true;
            // A channel's subscriptions change its members without a timeline line; the members and counts follow.
            if (data.type === "membership" && data.conversationId === chat.view.id) membership = system = true;
            if (data.type !== "message" || data.message.conversationId !== chat.view.id) continue;
            if (data.message.kind === "text" && chatHasThreads(chat.view.conversation)) threadsChanged = true;
            applyMessage(chat, { ...data.message, reactions: [] });
            if (data.message.kind === "system") {
              system = true;
              if (data.message.system && membershipCodes.has(data.message.system.code)) membership = true;
            }
            highestRev = Math.max(highestRev, data.message.rev);
          }
          for (const [id, rev] of reactionHints) {
            const items = await api.reactions(chat.view.id, id);
            if (!active(chat)) return;
            const known = chat.messages.get(id);
            if (!known || known.rev >= rev) continue;
            chat.messages.set(
              id,
              pendingReactions(chat, { ...known, rev, reactions: items.items.map(({ emoji, count, own }) => ({ emoji, count, own })) }),
            );
            chat.view = { ...chat.view, watermark: Math.max(chat.view.watermark, rev) };
          }
          if (membership) chat.view = { ...chat.view, membershipRev: chat.view.membershipRev + 1 };
          // The messages show at once; the threads follow.
          if (threadsChanged) {
            if (chat.view.conversation?.kind === "system") {
              await refreshThreads(chat);
              const hint = events.find(({ data }) => data.type === "threads" && data.conversationId === chat.view.id);
              if (active(chat) && hint) {
                if (chat.view.threadsStatus === "failed") throw new Error("Chat thread discovery failed");
                chat.subscription?.close();
                chat.subscription = subscribeConversation(chat, hint.cursor);
              }
            } else void refreshThreads(chat);
          }
          if (system) await refreshMetadata(chat);
          if (active(chat)) chat.metadataRev = Math.max(chat.metadataRev, highestRev);
        },
        caughtUp: (caughtUp) => {
          if (!active(chat) || chat.view.caughtUp === caughtUp) return;
          // Publish live event replay once the subscription has no pending work; API history reads
          // and resync snapshots still publish normally.
          if (caughtUp) publishMessages(chat, false);
          chat.view = { ...chat.view, caughtUp };
          notify();
        },
        resync: () => resyncConversation(chat),
        revoked: () => noAccess(chat),
        unavailable: () => {
          if (!active(chat)) return;
          publishMessages(chat, false);
          chat.view = { ...chat.view, status: "stopped" };
          stopped();
        },
      },
    );
  };
  const open = (next: OpenChatSnapshot & { view: ThreadView }) => {
    opening++;
    if (disposed) return;
    current?.threadsAbort?.abort();
    current?.readsAbort.abort();
    current?.subscription?.close();
    const seqHead = Math.max(next.page.seqHead, ...next.page.items.map((message) => message.seq));
    const chat: Current = {
      view: {
        id: next.conversation.id,
        view: next.view,
        threads: next.threads,
        threadsStatus: "ready",
        threadsRevision: 0,
        status: "live",
        caughtUp: false,
        conversation: next.conversation,
        membershipRev: 0,
        historyRev: ++historyGeneration,
        watermark: next.page.rev,
        seqHead,
        hasOlder: next.page.from > 1,
        hasNewer: next.page.to < seqHead,
        messages: next.page.items.map((message) => MessageSchema.parse(message)),
      },
      from: next.page.from,
      to: next.page.to,
      window: 0,
      older: null,
      newer: null,
      latest: null,
      threadsWork: null,
      threadsAgain: false,
      readsAbort: new AbortController(),
      metadataRev: next.conversation.rev,
      snapshotRev: next.page.rev,
      messages: new Map(next.page.items.map((message) => [message.id, MessageSchema.parse(message)])),
      subscription: null,
    };
    current = chat;
    chat.subscription = subscribeConversation(chat, next.cursor);
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
  let subscriptionsVersion = 0;
  const reloadSidebar = async (nextArchived = archived, nextUnread = unread, retainedIds: readonly string[] = []) => {
    const same = nextArchived === archived && nextUnread === unread;
    const depth = same ? rows.filter((row) => row.kind !== "system").length : 0;
    let page = await api.conversations(undefined, nextArchived, nextUnread);
    const loaded = [...page.items];
    while (loaded.length < depth && page.nextCursor) {
      page = await api.conversations(page.nextCursor, nextArchived, nextUnread);
      loaded.push(...page.items);
    }
    // Read rows remain visible for this visit to Unread, also after a live resync.
    const retained: Conversation[] = [];
    if (nextUnread) {
      // The visible visit can outlive a superseded mode request; its owner supplies those retained IDs on recovery.
      const candidates = new Set([...retainedIds, ...(same ? rows.map((row) => row.id) : [])]);
      const loadedIds = new Set(loaded.map((row) => row.id));
      const missing = [...candidates].filter((id) => !loadedIds.has(id));
      for (let offset = 0; offset < missing.length; offset += CONVERSATION_PAGE_SIZE) {
        const page = await api.conversations(undefined, nextArchived, false, missing.slice(offset, offset + CONVERSATION_PAGE_SIZE));
        retained.push(...page.items);
      }
    }
    const chat = current;
    const openRow = chat && active(chat) ? await api.conversation(chat.view.id) : undefined;
    if (disposed) return;
    subscriptionsVersion++;
    const systemRows = rows.filter((row) => row.kind === "system");
    archived = nextArchived;
    unread = nextUnread;
    excludedRows.clear();
    rows = [...new Map([...systemRows, ...loaded, ...retained].map((row) => [row.id, row])).values()].sort(compareRows);
    unreadRev.clear();
    for (const row of rows) unreadRev.set(row.id, row.rev);
    nextCursor = page.nextCursor;
    complete = nextCursor === null;
    for (const row of systemRows) await refetchRow(row.id);
    if (chat && active(chat) && openRow !== undefined) {
      if (openRow === null) noAccess(chat);
      else {
        metadata(chat, openRow);
        unreadRev.set(openRow.id, Math.max(unreadRev.get(openRow.id) ?? 0, openRow.rev));
      }
    }
    notify();
  };
  // Server order is last activity, then ID, both descending. Only unknown rows past an incomplete prefix stay out.
  const place = (row: Conversation) => {
    if (row.kind !== "system" && (!row.member || row.archived !== archived)) {
      excludedRows.add(row.id);
      rows = rows.filter((other) => other.id !== row.id);
      return;
    }
    excludedRows.delete(row.id);
    const rest = rows.filter((other) => other.id !== row.id);
    const index = rest.findIndex((other) => compareRows(row, other) < 0);
    if (index >= 0) rest.splice(index, 0, row);
    else if (row.kind === "system" || complete || rest.length < rows.length) rest.push(row);
    rows = rest;
  };
  const refetchRow = async (id: string) => {
    const row = await api.conversation(id);
    if (disposed) return;
    if (row === null) {
      rows = rows.filter((other) => other.id !== id);
      unreadRev.delete(id);
      if (current?.view.id === id) noAccess(current);
    } else {
      unreadRev.set(id, row.rev);
      place(row);
      if (current?.view.id === id) metadata(current, row);
    }
    notify();
  };
  const applyRead = async (data: z.infer<typeof ReadUpdateSchema>) => {
    const id = data.conversationId;
    const known = rows.find((row) => row.id === id) ?? (current?.view.id === id ? current.view.conversation : null);
    if (!known) return;
    if (data.asOfRev < (unreadRev.get(known.id) ?? known.rev)) return refetchRow(known.id);
    const read = { lastReadSeq: data.lastReadSeq, unreadFromSeq: data.unreadFromSeq, joinedSeq: data.joinedSeq };
    rows = rows.map((row) => (row.id === known.id ? { ...row, read, unread: data.unread } : row));
    unreadRev.set(known.id, data.asOfRev);
    const chat = current;
    if (chat?.view.id === known.id && chat.view.conversation) {
      const list = chat.view.threads;
      const touched = new Map(data.threads.map((thread) => [thread.id, thread]));
      chat.view = {
        ...chat.view,
        conversation: { ...chat.view.conversation, read, unread: data.unread },
        threads: list && {
          ...list,
          items: list.items.map((thread) => {
            const next = touched.get(thread.id);
            return next
              ? { ...thread, unread: next.unread, read: { lastReadSeq: next.lastReadSeq, unreadFromSeq: next.unreadFromSeq } }
              : thread;
          }),
        },
      };
      // General's own count is not part of the event; the thread list says it exactly.
      if (list && list.items.length > 0) void refreshThreads(chat);
    }
    notify();
  };
  const applySummary = async (summary: Summary) => {
    // Collection events span both personal list modes; an excluded chat needs no read for each text message.
    if (summary.kind === "text" && excludedRows.has(summary.conversationId)) return;
    let known = rows.find((row) => row.id === summary.conversationId);
    if (known && summary.rev > (unreadRev.get(known.id) ?? known.rev)) {
      const start = readStart(known.read);
      if (summary.kind === "text" && summary.author.id !== snapshot.viewerId && start !== null && summary.seq > start) {
        const counted = { ...known, unread: Math.min(UNREAD_CAP, known.unread + 1) };
        rows = rows.map((row) => (row.id === counted.id ? counted : row));
        known = counted;
      }
      // Slice 2.3 adds the decrement/refetch path at the cap with deletes.
      unreadRev.set(known.id, summary.rev);
    }
    if (known && summary.rev <= known.rev) return;
    if (!known || summary.kind === "system" || summary.thread !== null) {
      const row = await api.conversation(summary.conversationId);
      if (disposed) return;
      if (row !== null) unreadRev.set(row.id, row.rev);
      if (row === null) {
        excludedRows.add(summary.conversationId);
        unreadRev.delete(summary.conversationId);
        rows = rows.filter((other) => other.id !== summary.conversationId);
        if (current?.view.id === summary.conversationId) noAccess(current);
      } else if (known && row.lastActivityAt === known.lastActivityAt) rows = rows.map((other) => (other.id === row.id ? row : other));
      else place(row);
    } else
      place({
        ...known,
        rev: summary.rev,
        lastActivityAt: summary.createdAt,
        lastMessage: { thread: null, id: summary.id, author: summary.author, preview: summary.preview ?? "", createdAt: summary.createdAt },
      });
    notify();
  };
  let listSubscription: LiveSubscription;
  const subscribeList = (cursor: string) =>
    connection.subscribe(
      "list",
      {},
      {
        cursor,
        parse: (data) => ChatLiveEventSchema.parse(data),
        apply: (events) =>
          sidebar(async () => {
            let discoveryCursor: string | undefined;
            const warmed = new Set<string>();
            for (const { data, cursor } of events) {
              if (data.type === "summary") await applySummary(data);
              else if ((data.type === "membership" || data.type === "threads") && rows.some((row) => row.id === data.conversationId)) {
                await refetchRow(data.conversationId);
                if (data.type === "threads" && rows.some((row) => row.id === data.conversationId && row.kind === "system")) {
                  discoveryCursor ??= cursor;
                  if (!warmed.has(data.conversationId)) {
                    // Summary pages are ordered by ID. Authorize recent items separately,
                    // including newly created keys beyond the summary's candidate page.
                    const list = await api.threads(data.conversationId, { short: "true" }, lifetime.signal);
                    if (list === null) throw new Error("Chat thread discovery failed");
                    warmed.add(data.conversationId);
                  }
                }
              }
            }
            if (!disposed && discoveryCursor !== undefined) {
              listSubscription.close();
              listSubscription = subscribeList(discoveryCursor);
            }
          }),
        resync: () => sidebar(reloadSidebar),
        unavailable: stopped,
      },
    );
  listSubscription = subscribeList(snapshot.cursor);
  subscriptions.push(
    connection.subscribe(
      "me",
      {},
      {
        cursor: snapshot.cursor,
        parse: (data) => ChatLiveEventSchema.parse(data),
        apply: (events) =>
          sidebar(async () => {
            if (events.some(({ data }) => data.type === "membership" || data.type === "personal")) await reloadSidebar();
            for (const { data } of events)
              if (data.type === "preferences") {
                collapsed = data.collapsed;
                notify();
              }
            for (const { data } of events) if (data.type === "read") await applyRead(data);
          }),
        resync: () =>
          sidebar(async () => {
            await reloadSidebar();
            const preferences = await api.preferences();
            collapsed = preferences.collapsed;
            notify();
          }),
        unavailable: stopped,
      },
    ),
  );
  if (snapshot.open) open({ ...snapshot.open, cursor: snapshot.cursor });
  return {
    get collapsed() {
      return collapsed;
    },
    preferences: () => api.preferences(),
    savePreferences: async (next: Parameters<ChatStoreApi["savePreferences"]>[0]) => {
      const saved = await api.savePreferences(next);
      collapsed = saved.collapsed;
      notify();
      return saved;
    },
    personal: async (id: string, patch: Parameters<ChatStoreApi["personal"]>[1]) => {
      let result: Conversation;
      try {
        result = await api.personal(id, patch);
      } catch (error) {
        // Another device may have unpinned the requested neighbor. Refresh before offering a new position.
        if (error instanceof ChatRequestError && error.status === 400) await sidebar(reloadSidebar).catch(() => {});
        throw error;
      }
      await sidebar(reloadSidebar);
      return result;
    },
    showArchive: (next: boolean, nextUnread = unread, retainedIds: readonly string[] = []) =>
      sidebar(() => reloadSidebar(next, nextUnread, retainedIds)),
    /** Browser-loaded system rows join the same live read-state and invalidation owner as ordinary chats. */
    includeSystemChats: (items: readonly Conversation[]) => {
      if (disposed) return;
      const merged = new Map(rows.map((row) => [row.id, row]));
      for (const row of items) {
        const known = merged.get(row.id);
        if (row.kind === "system" && (!known || row.rev >= known.rev)) merged.set(row.id, row);
      }
      rows = [...merged.values()];
      notify();
    },
    // A change the reader made shows at once: its chat's row is read again instead of waiting for the live event.
    // Refresh failures leave committed changes successful; live updates and resync repair the row.
    // A chat the reader left answers 404, which removes the row and ends an open view in "No access".
    create: async (input: Parameters<ChatStoreApi["create"]>[0]) => {
      const result = await api.create(input);
      if (result.outcome === "created") await sidebar(() => refetchRow(result.conversation.id)).catch(() => {});
      return result;
    },
    updateDetails: async (id: string, patch: Parameters<ChatStoreApi["updateDetails"]>[1]) => {
      const result = await api.updateDetails(id, patch);
      await sidebar(() => refetchRow(id)).catch(() => {});
      return result;
    },
    react: (id: string, messageId: string, emoji: string, on: boolean): Promise<void> => {
      const chat = current;
      const known = chat?.view.id === id && active(chat) ? chat.messages.get(messageId) : undefined;
      if (!chat || !known) return api.react(id, messageId, emoji, on);
      let messages = reactionWork.get(chat);
      if (!messages) {
        messages = new Map();
        reactionWork.set(chat, messages);
      }
      let work = messages.get(messageId);
      if (!work) {
        work = { base: known.reactions, pending: [], tail: Promise.resolve() };
        messages.set(messageId, work);
      }
      const state = work;
      const change = { emoji, on };
      state.pending.push(change);
      const publish = () => {
        if (!active(chat)) return;
        const message = chat.messages.get(messageId);
        if (!message) return;
        chat.messages.set(messageId, { ...message, reactions: state.pending.reduce(changeReaction, state.base) });
        publishMessages(chat);
      };
      publish();
      const request = state.tail.then(async () => {
        try {
          await api.react(id, messageId, emoji, on);
          state.base = changeReaction(state.base, change);
        } finally {
          state.pending = state.pending.filter((pending) => pending !== change);
          publish();
          if (!state.pending.length) {
            messages.delete(messageId);
            void reconcile();
          }
        }
      });
      // A write's answer can arrive after newer reactions from elsewhere, so once this message has no pending change,
      // its reactions are read again from the server instead of trusting the local sum.
      const reconcile = async () => {
        const fresh = await api.reactions(id, messageId).catch(() => null);
        if (!fresh || !active(chat) || messages.has(messageId)) return;
        const message = chat.messages.get(messageId);
        if (!message) return;
        chat.messages.set(messageId, { ...message, reactions: fresh.items.map(({ emoji, count, own }) => ({ emoji, count, own })) });
        publishMessages(chat);
      };
      state.tail = request.catch(() => {});
      return request;
    },
    members: (id: string, query: Parameters<ChatStoreApi["members"]>[1]) => api.members(id, query),
    shared: (id: string, query: Parameters<ChatStoreApi["shared"]>[1]) => api.shared(id, query),
    previewMembers: (id: string, members: MemberPrincipal[]) => api.previewMembers(id, members),
    addMembers: async (id: string, members: MemberPrincipal[]) => {
      const result = await api.addMembers(id, members);
      await sidebar(() => refetchRow(id)).catch(() => {});
      return result;
    },
    // The changed entry may be the reader's own, so the chat's effective permission is read again.
    updateMember: async (id: string, accessId: string, permission: z.infer<typeof PermissionSchema>) => {
      const result = await api.updateMember(id, accessId, permission);
      await sidebar(() => refetchRow(id)).catch(() => {});
      return result;
    },
    removeMember: async (id: string, accessId: string) => {
      const result = await api.removeMember(id, accessId);
      await sidebar(() => refetchRow(id)).catch(() => {});
      return result;
    },
    leave: async (id: string, successor?: string) => {
      const result = await api.leave(id, successor);
      // A chat stays readable after leaving when another grant allows it, but it is no longer the reader's chat:
      // only the membership-filtered list says whether it belongs in the sidebar.
      await sidebar(reloadSidebar).catch(() => {});
      return result;
    },
    refreshSidebar: () => sidebar(reloadSidebar),
    people: (search: string, signal?: AbortSignal) => api.people(search, undefined, signal),
    // System receipts have no personal-channel event: their authorized HTTP response owns the update.
    markRead: async (id: string, seq: number, thread?: ThreadView) => {
      const chat = current?.view.id === id ? current : null;
      const system = (chat?.view.conversation ?? rows.find((row) => row.id === id))?.kind === "system";
      const signal = chat?.readsAbort.signal ?? lifetime.signal;
      let cursor: string | undefined;
      const seen = new Set<string>();
      let result: z.infer<typeof ReadUpdateSchema>;
      do {
        signal.throwIfAborted();
        result = await api.read(id, seq, thread, cursor, signal);
        signal.throwIfAborted();
        if (system) await applyRead(result);
        cursor = system && thread === "all" ? (result.summaryCursor ?? undefined) : undefined;
        if (cursor !== undefined) {
          if (seen.has(cursor)) throw new Error("Repeated chat read cursor");
          seen.add(cursor);
        }
      } while (cursor !== undefined);
      if (system && (thread !== "all" || result.summaryCursor !== undefined)) await sidebar(() => refetchRow(id));
      return result;
    },
    markUnread: async (id: string, message?: string) => {
      const system = (current?.view.id === id ? current.view.conversation : rows.find((row) => row.id === id))?.kind === "system";
      const result = await api.markUnread(id, message);
      if (system && !disposed) {
        await applyRead(result);
        if (result.summaryCursor !== undefined) await sidebar(() => refetchRow(id));
      }
      return result;
    },
    /** The ID of the chat's message at `seq`, read from the server, or null when it is gone. */
    messageAt: async (id: string, seq: number) =>
      (await api.messages(id, { before: seq + 1 }))?.items.find((message) => message.seq === seq)?.id ?? null,
    readAll: (confirmed: boolean, cursor?: string) => api.readAll(confirmed, cursor),
    get sidebar(): readonly Conversation[] {
      return rows;
    },
    get hasMoreSidebar() {
      return nextCursor !== null;
    },
    get subscriptionsVersion() {
      return subscriptionsVersion;
    },
    loadMoreSidebar: (): Promise<void> => {
      if (moreSidebar) return moreSidebar;
      if (disposed || nextCursor === null) return Promise.resolve();
      const work = sidebar(async () => {
        if (nextCursor === null) return;
        const page = await api.conversations(nextCursor, archived, unread);
        if (disposed) return;
        const present = new Set(rows.map((row) => row.id));
        const appended = [...rows];
        for (const row of page.items)
          if (!present.has(row.id)) {
            appended.push(row);
            unreadRev.set(row.id, row.rev);
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
      view: ThreadView = "all",
    ): Promise<{ status: "opened"; focus: string | null } | { status: "no-access" } | { status: "superseded" }> => {
      const request = ++opening;
      if (disposed) return { status: "superseded" };
      const next = await api.snapshot(id, message, view);
      if (disposed || request !== opening) return { status: "superseded" };
      if (next) {
        open({ ...next, view });
        return { status: "opened", focus: next.focus };
      }
      current?.threadsAbort?.abort();
      current?.readsAbort.abort();
      current?.subscription?.close();
      const chat: Current = {
        view: {
          id,
          view,
          threads: null,
          threadsStatus: "ready",
          threadsRevision: 0,
          status: "live",
          caughtUp: false,
          conversation: null,
          messages: [],
          membershipRev: 0,
          historyRev: ++historyGeneration,
          watermark: 0,
          seqHead: 0,
          hasOlder: false,
          hasNewer: false,
        },
        metadataRev: 0,
        snapshotRev: 0,
        messages: new Map(),
        subscription: null,
        from: null,
        to: null,
        window: 0,
        older: null,
        newer: null,
        latest: null,
        threadsWork: null,
        threadsAgain: false,
        readsAbort: new AbortController(),
      };
      current = chat;
      noAccess(chat);
      return { status: "no-access" };
    },
    /** Reads the open chat's threads again, for example after the list failed to load. */
    refreshThreads: () => (current ? refreshThreads(current) : Promise.resolve()),
    // A created or changed thread shows at once; the live event brings the same list to the reader's other tabs.
    createThread: async (id: string, input: Parameters<ChatStoreApi["createThread"]>[1]) => {
      const thread = await api.createThread(id, input);
      if (current?.view.id === id) await refreshThreads(current);
      await sidebar(() => refetchRow(id)).catch(() => {});
      return thread;
    },
    updateThread: async (id: string, thread: string, patch: Parameters<ChatStoreApi["updateThread"]>[2]) => {
      const result = await api.updateThread(id, thread, patch);
      if (current?.view.id === id) await refreshThreads(current);
      await sidebar(() => refetchRow(id)).catch(() => {});
      return result;
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
      current?.threadsAbort?.abort();
      current?.readsAbort.abort();
      current?.subscription?.close();
      current = null;
      notify();
    },
    dispose: () => {
      opening++;
      disposed = true;
      lifetime.abort();
      current?.threadsAbort?.abort();
      current?.readsAbort.abort();
      current?.subscription?.close();
      listSubscription.close();
      for (const subscription of subscriptions) subscription.close();
      listeners.clear();
    },
  };
};
