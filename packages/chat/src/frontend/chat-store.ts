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
  MemberPageSchema,
  MemberPreviewSchema,
  type MemberPrincipal,
  MemberRemovalSchema,
  MessagePageSchema,
  MessageSchema,
  PeoplePageSchema,
  type PermissionSchema,
  type PersonalConversationSchema,
  ReadAllOutcomeSchema,
  ReadUpdateSchema,
  readStart,
  SidebarPreferencesSchema,
  SuccessSchema,
  UNREAD_CAP,
} from "../service/contracts";

type Conversation = z.infer<typeof ConversationSchema>;
type Message = z.infer<typeof MessageSchema>;
type ConversationPage = z.infer<typeof ConversationPageSchema>;
type MessagePage = z.infer<typeof MessagePageSchema>;
type ChangesPage = z.infer<typeof ChangesPageSchema>;
type Summary = Extract<z.infer<typeof ChatLiveEventSchema>, { type: "summary" }>;
export type ChatStoreApi = {
  personal(id: string, patch: z.infer<typeof PersonalConversationSchema>): Promise<Conversation>;
  preferences(): Promise<z.infer<typeof SidebarPreferencesSchema>>;
  savePreferences(collapsed: z.infer<typeof SidebarPreferencesSchema>["collapsed"]): Promise<z.infer<typeof SidebarPreferencesSchema>>;
  create(input: z.input<typeof CreateConversationSchema>): Promise<z.infer<typeof CreateOutcomeSchema>>;
  updateDetails(id: string, patch: { name?: string | null; icon?: string | null; purpose?: string | null }): Promise<Conversation>;
  members(id: string, query: { q?: string; cursor?: string }): Promise<z.infer<typeof MemberPageSchema>>;
  previewMembers(id: string, members: MemberPrincipal[]): Promise<z.infer<typeof MemberPreviewSchema>>;
  addMembers(id: string, members: MemberPrincipal[]): Promise<z.infer<typeof ChangeSchema>>;
  updateMember(id: string, accessId: string, permission: z.infer<typeof PermissionSchema>): Promise<z.infer<typeof SuccessSchema>>;
  removeMember(id: string, accessId: string): Promise<z.infer<typeof MemberRemovalSchema>>;
  leave(id: string, successor?: string): Promise<z.infer<typeof MemberRemovalSchema>>;
  people(search: string, cursor?: string, signal?: AbortSignal): Promise<z.infer<typeof PeoplePageSchema>>;
  read(id: string, seq: number): Promise<z.infer<typeof ReadUpdateSchema>>;
  markUnread(id: string, message?: string): Promise<z.infer<typeof ReadUpdateSchema>>;
  readAll(confirmed: boolean): Promise<z.infer<typeof ReadAllOutcomeSchema>>;
  conversations(cursor?: string, archived?: boolean, unread?: boolean, ids?: string[]): Promise<ConversationPage>;
  conversation(id: string): Promise<Conversation | null>;
  messages(id: string, query?: { before?: number; after?: number }): Promise<MessagePage | null>;
  snapshot(id: string, message?: string): Promise<(OpenChatSnapshot & { focus: string | null }) | null>;
  changes(id: string, afterRev: number): Promise<ChangesPage | "RESYNC_REQUIRED" | null>;
};
export type OpenChatSnapshot = { cursor: string; conversation: Conversation; page: MessagePage };
export type ChatStoreSnapshot = {
  collapsed?: z.infer<typeof SidebarPreferencesSchema>["collapsed"];
  archived?: boolean;
  unread?: boolean;
  viewerId: string;
  cursor: string;
  sidebar: ConversationPage;
  open?: { conversation: Conversation; page: MessagePage };
};
export type OpenChat = {
  id: string;
  status: "live" | "no-access" | "stopped";
  conversation: Conversation | null;
  messages: readonly Message[];
  membershipRev: number;
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
    create: async (input) => requiredResponse(await client.conversations.$post({ json: input }), CreateOutcomeSchema),
    updateDetails: async (id, patch) =>
      requiredResponse(
        await client.conversations[":conversation"].$patch({ param: { conversation: id }, json: patch }),
        ConversationSchema,
      ),
    members: async (id, query) =>
      requiredResponse(await client.conversations[":conversation"].members.$get({ param: { conversation: id }, query }), MemberPageSchema),
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
        MemberRemovalSchema,
      ),
    people: async (search, cursor, signal) =>
      requiredResponse(await client.people.$get({ query: { search, cursor } }, { init: { signal } }), PeoplePageSchema),

    read: async (id, seq) =>
      requiredResponse(
        await client.conversations[":conversation"].read.$post({ param: { conversation: id }, json: { seq } }),
        ReadUpdateSchema,
      ),
    markUnread: async (id, message) =>
      requiredResponse(
        await client.conversations[":conversation"].unread.$post({ param: { conversation: id }, json: { message } }),
        ReadUpdateSchema,
      ),
    readAll: async (confirmed) =>
      requiredResponse(await client.conversations["read-all"].$post({ json: { confirmed } }), ReadAllOutcomeSchema),
    conversations: async (cursor, archived, unread, ids) =>
      requiredResponse(
        await client.conversations.$get({
          query: { cursor, archived: archived ? "true" : "false", unread: unread ? "true" : "false", ids: ids?.join(",") },
        }),
        CONVERSATION_PAGE_SIZE,
  ConversationPageSchema,
      ),
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
  const unreadRev = new Map(rows.map((row) => [row.id, row.rev]));
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
        membershipRev: 0,
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
            membership = false,
            highestRev = 0;
          for (const { data } of events) {
            if (!active(chat)) return;
            if (data.type !== "message" || data.message.conversationId !== chat.view.id) continue;
            applyMessage(chat, data.message);
            if (data.message.kind === "system") {
              system = true;
              if (data.message.system && membershipCodes.has(data.message.system.code)) membership = true;
            }
            highestRev = Math.max(highestRev, data.message.rev);
          }
          if (membership) chat.view = { ...chat.view, membershipRev: chat.view.membershipRev + 1 };
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
  const reloadSidebar = async (nextArchived = archived, nextUnread = unread) => {
    const same = nextArchived === archived && nextUnread === unread;
    const depth = same ? rows.length : 0;
    let page = await api.conversations(undefined, nextArchived, nextUnread);
    const loaded = [...page.items];
    while (loaded.length < depth && page.nextCursor) {
      page = await api.conversations(page.nextCursor, nextArchived, nextUnread);
      loaded.push(...page.items);
    }
    // Read rows remain visible for this visit to Unread, also after a live resync.
    const retained: Conversation[] = [];
    if (same && unread) {
      const missing = rows.filter((previous) => !loaded.some((row) => row.id === previous.id)).map((row) => row.id);
      for (let offset = 0; offset < missing.length; offset += CONVERSATION_PAGE_SIZE) {
        const page = await api.conversations(undefined, nextArchived, false, missing.slice(offset, offset + CONVERSATION_PAGE_SIZE));
        retained.push(...page.items);
      }
    }
    if (disposed) return;
    archived = nextArchived;
    unread = nextUnread;
    rows = [...loaded, ...retained];
    unreadRev.clear();
    for (const row of rows) unreadRev.set(row.id, row.rev);
    nextCursor = page.nextCursor;
    complete = nextCursor === null;
    notify();
    // The open chat may lie outside the first sidebar page, so its read state is refreshed on its own.
    const chat = current;
    if (chat && active(chat)) {
      const row = await api.conversation(chat.view.id);
      if (active(chat)) {
        if (row === null) noAccess(chat);
        else {
          metadata(chat, row);
          unreadRev.set(row.id, Math.max(unreadRev.get(row.id) ?? 0, row.rev));
        }
      }
    }
    notify();
  };
  // Server order is last activity, then ID, both descending. Only unknown rows past an incomplete prefix stay out.
  const place = (row: Conversation) => {
    if (!row.member || row.archived !== archived) {
      rows = rows.filter((other) => other.id !== row.id);
      return;
    }
    const rest = rows.filter((other) => other.id !== row.id);
    const index = rest.findIndex(
      (other) =>
        (row.pinnedRank ?? 2147483647) < (other.pinnedRank ?? 2147483647) ||
        ((row.pinnedRank ?? 2147483647) === (other.pinnedRank ?? 2147483647) &&
          (row.lastActivityAt > other.lastActivityAt || (row.lastActivityAt === other.lastActivityAt && row.id > other.id))),
    );
    if (index >= 0) rest.splice(index, 0, row);
    else if (complete || rest.length < rows.length) rest.push(row);
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
    if (current?.view.id === known.id && current.view.conversation)
      current.view = { ...current.view, conversation: { ...current.view.conversation, read, unread: data.unread } };
    notify();
  };
  const applySummary = async (summary: Summary) => {
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
    if (!known || summary.kind === "system") {
      const row = await api.conversation(summary.conversationId);
      if (disposed) return;
      if (row !== null) unreadRev.set(row.id, row.rev);
      if (row === null) {
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
      const result = await api.personal(id, patch);
      await sidebar(reloadSidebar).catch(() => {});
      return result;
    },
    showArchive: (next: boolean, nextUnread = unread) => sidebar(() => reloadSidebar(next, nextUnread)),
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
    members: (id: string, query: Parameters<ChatStoreApi["members"]>[1]) => api.members(id, query),
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
    people: (search: string, signal?: AbortSignal) => api.people(search, undefined, signal),
    // Only the FIFO personal live channel applies write results; HTTP responses never change local state.
    markRead: (id: string, seq: number) => api.read(id, seq),
    markUnread: (id: string, message?: string) => api.markUnread(id, message),
    readAll: (confirmed: boolean) => api.readAll(confirmed),
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
        view: {
          id,
          status: "live",
          conversation: null,
          messages: [],
          membershipRev: 0,
          watermark: 0,
          seqHead: 0,
          hasOlder: false,
          hasNewer: false,
        },
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
