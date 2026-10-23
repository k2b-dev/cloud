import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CloudResourceRef } from "@k2b/cloud/contracts";
import type { ServerWebSocket } from "bun";
import { z } from "zod";
import {
  AddMembersSchema,
  ChangeSchema,
  ConversationSchema,
  CreateConversationSchema,
  CreateOutcomeSchema,
  CreateThreadSchema,
  ExistingMatchSchema,
  LeaveSchema,
  MAX_EXISTING_MATCHES,
  MarkUnreadSchema,
  MEMBER_PAGE_SIZE,
  MemberPageSchema,
  MemberPreviewSchema,
  type MemberPrincipal,
  MemberQuerySchema,
  MemberRemovalSchema,
  MemberSchema,
  type MessageViewSchema,
  PEOPLE_PAGE_SIZE,
  PeoplePageSchema,
  PeopleQuerySchema,
  PermissionSchema,
  READ_ALL_BATCH,
  READ_ALL_CONFIRM_FROM,
  ReadAllSchema,
  ReadSchema,
  readStart,
  SendMessageSchema,
  SuccessSchema,
  type SystemMessage,
  type ThreadListSchema,
  type ThreadSchema,
  UNREAD_CAP,
  UpdateConversationSchema,
  UpdateMemberSchema,
  UpdateThreadSchema,
} from "../service/contracts";
import type { ChatWorkspaceProps } from "./ChatWorkspace.island";

type Conversation = z.infer<typeof ConversationSchema>;
type Message = z.infer<typeof MessageViewSchema>;
type Person = { id: string; name: string };
type Group = { id: string; name: string; size: number };
type Member = z.infer<typeof MemberSchema>;
type Permission = z.infer<typeof PermissionSchema>;
/** A thread as the in-memory server keeps it: the viewer's read state lives on the thread. */
type ThreadEntry = {
  id: string;
  name: string;
  description: string | null;
  archived: boolean;
  read: { lastReadSeq: number | null; unreadFromSeq: number | null } | null;
  createdAt: string;
  lastActivityAt: string;
};
type Chat = { conversation: Conversation; messages: Message[]; members: Member[]; archived: boolean; threads: ThreadEntry[] };
type Subscription = { socket: ServerWebSocket<unknown>; id: string; channel: string; scope: { conversation?: string } };

/** Midday in Berlin keeps even the longest seeded history on one fixed calendar day. */
export const chatTestNow = new Date("2026-10-14T10:00:00.000Z");

export const viewer: Person = { id: "11111111-1111-4111-8111-111111111111", name: "Robin Example" };
export const nora: Person = { id: "22222222-2222-4222-8222-222222222222", name: "Nora Weber" };
export const tobias: Person = { id: "33333333-3333-4333-8333-333333333333", name: "Tobias Brandt" };

const threadId = (chat: string, index: number) => `T${chat.slice(-3)}${index.toString(36).padStart(2, "0")}`;

const ui = new URL("../../../ui/", import.meta.url).pathname;
const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./ChatWorkspace.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-chat-workspace-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Chat workspace harness build failed");
  return build.outputs[0]!.text();
};
const buildCss = async (entry: string): Promise<string> => {
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../cloud/", import.meta.url).pathname))).default;
  const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
  return build.outputs[0]!.text();
};

// The fonts Core serves, so rows have their real heights and icons show.
const uiDist = dirname(fileURLToPath(import.meta.resolve("@k2b/ui/fonts/plex.css")));
const fonts = async () => {
  const icons = await Bun.file(resolve(uiDist, "tabler.css")).text();
  return {
    css:
      (await Bun.file(resolve(uiDist, "plex.css")).text()).replaceAll("./fonts/", "/fonts/") +
      icons.replace(/\.\/tabler-icons-[\w-]+\.woff2(\?[^)]*)?/, "/tabler-icons.woff2"),
    icons: resolve(uiDist, /tabler-icons-[\w-]+\.woff2/.exec(icons)![0]),
  };
};

const chatId = (index: number) => `Chat${index.toString(36).padStart(2, "0")}`;
const messageId = (chat: string, seq: number) => `${chat}${String(seq).padStart(4, "0")}`;

/**
 * A browser page with the real chat workspace against an in-memory chat server: the REST routes the island uses and
 * the live socket. Tests add messages from others with `receive`, which the server stores and delivers live like
 * the chat app does, and make the next sends fail with `failSends`.
 */
export const startChatHarness = async () => {
  const started = performance.now();
  const now = () => new Date(chatTestNow.getTime() + (performance.now() - started));
  const [harness, css, fontAssets] = await Promise.all([
    buildHarness(),
    Promise.all([
      buildCss(resolve(import.meta.dir, "../../../../styles.css")),
      buildCss(resolve(import.meta.dir, "../styles/app.css")),
    ]).then((parts) => parts.join("\n")),
    fonts(),
  ]);
  const chats = new Map<string, Chat>();
  const createIntents = new Map<string, string>();
  const people = new Map([viewer, nora, tobias].map((person) => [person.id, person]));
  const groups = new Map<string, Group>();
  const subscriptions: Subscription[] = [];
  const events: { cursor: number; channel: string; chat: string; data: unknown }[] = [];
  let cursor = 0;
  let nextChat = 0;
  let nextAccess = 0;
  let nextPerson = 0;
  let failing = 0;
  let failingUnread = 0;
  let failingThreads = 0;
  let failingShared = 0;
  // Elements of a made-up "spaces" app that messages can share; a card reads them with the viewer's access.
  const elements = new Map<string, { id: string; title: string; preview: string; readable: boolean }>();
  let readerCalls = 0;
  const query = (localId: string) => ({
    localId,
    title: "Read a task",
    description: "Reads one task.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    dataSchema: { type: "object", properties: {}, additionalProperties: true },
    schemaHash: "0".repeat(64),
    openWorld: false,
  });
  const catalog = {
    protocolVersion: 2,
    apps: [
      {
        appId: "spaces",
        appName: "Spaces",
        appIcon: "ti ti-layout-kanban",
        appDescription: "",
        manifest: {
          protocolVersion: 2,
          appId: "spaces",
          manifestHash: "0".repeat(64),
          types: [{ localId: "task", title: "Task", description: "A task.", icon: "ti ti-circle", reader: "task.read" }],
          queries: [query("task.read")],
          actions: [],
          commands: [],
        },
      },
    ],
    page: { hasMore: false },
  };
  const reads: { chat: string; seq: number }[] = [];
  // Which part of the chat each read named: "general", "all", or a thread.
  const readViews: { chat: string; seq: number; thread: string }[] = [];
  const posted: { chat: string; clientId: string; body: string; thread?: string; replyTo?: string; refs?: CloudResourceRef[] }[] = [];

  const principalId = (principal: MemberPrincipal) => (principal.type === "user" ? principal.userId : principal.groupId);
  const makeMember = (principal: MemberPrincipal, permission: Permission, addedAt: string): Member => {
    const id = principalId(principal);
    const group = principal.type === "group" ? groups.get(id) : undefined;
    return MemberSchema.parse({
      accessId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(++nextAccess).padStart(12, "0")}`,
      principal,
      displayName: principal.type === "user" ? people.get(id)!.name : group!.name,
      guest: false,
      deactivated: false,
      groupSize: group?.size ?? null,
      permission,
      addedAt,
    });
  };
  const managers = (chat: Chat) =>
    chat.members.filter((member) => member.principal.type === "user" && !member.deactivated && member.permission === "admin").length;
  const refreshMembers = (chat: Chat) => {
    const others = chat.members.filter((member) => member.principal.type !== "user" || member.principal.userId !== viewer.id);
    const derived =
      others.length === 0
        ? "You"
        : others.length === 1
          ? others[0]!.displayName
          : // Like the server's titles: three names, then an ellipsis.
            [
              ...others
                .slice(0, 3)
                .map((member) => (member.principal.type === "group" ? member.displayName : member.displayName.split(" ")[0])),
              ...(others.length > 3 ? ["…"] : []),
            ].join(", ");
    chat.conversation = {
      ...chat.conversation,
      title: chat.conversation.name ?? derived,
      memberCount: chat.members.reduce((count, member) => count + (member.groupSize ?? 1), 0),
    };
  };
  const joiningMembers = (chat: Chat, members: MemberPrincipal[]) =>
    members.filter(
      (principal) =>
        !chat.members.some(
          (member) => member.principal.type === principal.type && principalId(member.principal) === principalId(principal),
        ),
    );

  const deliver = (channel: string, chat: string, data: unknown) => {
    cursor += 1;
    events.push({ cursor, channel, chat, data });
    for (const subscription of subscriptions) {
      if (subscription.channel !== channel || (channel === "conversation" && subscription.scope.conversation !== chat)) continue;
      subscription.socket.send(JSON.stringify({ t: "event", id: subscription.id, cursor: `c.${cursor}`, data }));
    }
  };
  // Each thread reads from its own position, falling back to where the viewer joined; General from the chat's.
  const startOf = (chat: Chat, thread: string | null) => {
    const read = chat.conversation.read;
    if (read === null) return null;
    if (thread === null) return readStart(read);
    const own = chat.threads.find((entry) => entry.id === thread)?.read ?? null;
    return readStart({ lastReadSeq: own?.lastReadSeq ?? null, unreadFromSeq: own?.unreadFromSeq ?? null, joinedSeq: read.joinedSeq });
  };
  const unreadIn = (chat: Chat, thread: string | null) => {
    const start = startOf(chat, thread);
    return start === null
      ? 0
      : Math.min(
          UNREAD_CAP,
          chat.messages.filter(
            (message) => message.thread === thread && message.seq > start && message.kind === "text" && message.author.id !== viewer.id,
          ).length,
        );
  };
  const lastIn = (chat: Chat, thread: string | null) => {
    const message = chat.messages.findLast((entry) => entry.thread === thread && entry.kind === "text");
    return message ? { id: message.id, author: message.author, preview: message.body ?? "", createdAt: message.createdAt } : null;
  };
  const threadList = (chat: Chat): z.infer<typeof ThreadListSchema> => ({
    general: { unread: unreadIn(chat, null), lastMessage: lastIn(chat, null) },
    items: [...chat.threads]
      .sort(
        (a, b) =>
          Number(a.archived) - Number(b.archived) ||
          (a.archived ? a.name.localeCompare(b.name) : b.lastActivityAt.localeCompare(a.lastActivityAt)),
      )
      .map(
        (thread): z.infer<typeof ThreadSchema> => ({
          id: thread.id,
          name: thread.name,
          description: thread.description,
          archived: thread.archived,
          unread: unreadIn(chat, thread.id),
          read: thread.read,
          lastMessage: lastIn(chat, thread.id),
          lastActivityAt: thread.lastActivityAt,
          createdAt: thread.createdAt,
        }),
      ),
  });
  const project = (chat: Chat) => {
    const unread = [null, ...chat.threads.map((thread) => thread.id)].reduce((sum, thread) => sum + unreadIn(chat, thread), 0);
    chat.conversation = {
      ...chat.conversation,
      threads: chat.threads.filter((thread) => !thread.archived).length,
      unread: Math.min(UNREAD_CAP, unread),
    };
    return chat.conversation;
  };
  const update = (id: string, changed: boolean, touched: readonly string[] = []) => {
    const chat = chats.get(id)!;
    const conversation = project(chat);
    if (!conversation.read) throw new Error("Read update has no participant");
    const threads = touched.map((thread) => {
      const entry = chat.threads.find((candidate) => candidate.id === thread)!;
      return {
        id: thread,
        lastReadSeq: entry.read?.lastReadSeq ?? null,
        unreadFromSeq: entry.read?.unreadFromSeq ?? null,
        unread: unreadIn(chat, thread),
      };
    });
    const data = { threads, conversationId: id, ...conversation.read, unread: conversation.unread, asOfRev: conversation.rev };
    if (changed) deliver("me", id, { type: "read", ...data });
    return data;
  };
  // The same monotonic rule as General, on a thread's own read state.
  const readThread = (chat: Chat, thread: ThreadEntry, seq: number) => {
    const s = Math.min(seq, chat.messages.length);
    const state = thread.read ?? { lastReadSeq: null, unreadFromSeq: null };
    const last = Math.max(state.lastReadSeq ?? s, s);
    const from = state.unreadFromSeq;
    const next = from !== null && s >= from ? (s + 1 <= last ? s + 1 : null) : from;
    const changed = thread.read === null || state.lastReadSeq !== last || from !== next;
    thread.read = { lastReadSeq: last, unreadFromSeq: next };
    return changed;
  };
  const read = (id: string, seq: number, view = "general") => {
    const chat = chats.get(id)!;
    if (view !== "general") {
      const targets = view === "all" ? chat.threads : chat.threads.filter((thread) => thread.id === view);
      const touched = targets.filter((thread) => readThread(chat, thread, seq)).map((thread) => thread.id);
      if (view !== "all") return update(id, touched.length > 0, touched);
      const general = readGeneral(id, seq);
      return touched.length ? update(id, true, touched) : general;
    }
    return readGeneral(id, seq);
  };
  const readGeneral = (id: string, seq: number) => {
    const chat = chats.get(id)!;
    const previous = chat.conversation.read;
    const s = Math.min(seq, chat.messages.length);
    const state = previous ?? { lastReadSeq: s, unreadFromSeq: null, joinedSeq: s };
    const last = Math.max(state.lastReadSeq ?? s, s);
    const from = state.unreadFromSeq;
    const next = from !== null && s >= from ? (s + 1 <= last ? s + 1 : null) : from;
    chat.conversation = { ...chat.conversation, read: { ...state, lastReadSeq: last, unreadFromSeq: next } };
    return update(id, previous === null || state.lastReadSeq !== last || from !== next);
  };
  const markUnread = (id: string, message?: string) => {
    const chat = chats.get(id)!;
    const target = message
      ? chat.messages.find((item) => item.id === message)
      : chat.messages.findLast((item) => item.kind === "text" && item.author.id !== viewer.id);
    if (message && !target) return null;
    const thread = target?.thread ? chat.threads.find((entry) => entry.id === target.thread) : undefined;
    if (thread && target) {
      const base = Math.max(thread.read?.lastReadSeq ?? 0, chat.conversation.read?.joinedSeq ?? 0);
      const changed = target.seq <= base && target.seq !== thread.read?.unreadFromSeq;
      if (changed) thread.read = { lastReadSeq: thread.read?.lastReadSeq ?? null, unreadFromSeq: target.seq };
      return update(id, changed, [thread.id]);
    }
    const previous = chat.conversation.read;
    const state = previous ?? { lastReadSeq: null, unreadFromSeq: null, joinedSeq: chat.messages.length };
    const from = target?.seq ?? chat.messages.length;
    const base = Math.max(state.lastReadSeq ?? 0, state.joinedSeq);
    const changed = from >= 1 && from <= base && from !== state.unreadFromSeq;
    chat.conversation = { ...chat.conversation, read: { ...state, unreadFromSeq: changed ? from : state.unreadFromSeq } };
    return update(id, previous === null || changed);
  };
  const append = (
    chat: string,
    author: Person,
    body: string,
    at: Date,
    kind: "text" | "system" = "text",
    target: { thread?: string | null; replyTo?: string; refs?: CloudResourceRef[] } = {},
  ) => {
    const entry = chats.get(chat)!;
    const seq = entry.messages.length + 1;
    const rev = entry.conversation.rev + 1;
    const original = target.replyTo ? entry.messages.find((message) => message.id === target.replyTo) : undefined;
    const thread = original ? original.thread : (target.thread ?? null);
    const message: Message = {
      refs: target.refs ?? [],
      thread,
      replyTo: original ? { id: original.id, author: original.author, preview: original.body ?? "" } : null,
      id: messageId(chat, seq),
      conversationId: chat,
      seq,
      rev,
      kind,
      author: { type: "user", ...author },
      body: kind === "text" ? body : null,
      system: kind === "system" ? { code: "conversation_created", params: {} } : null,
      systemText: kind === "system" ? `${author.name} created the chat.` : null,
      createdAt: at.toISOString(),
    };
    entry.messages.push(message);
    const owner = thread ? entry.threads.find((candidate) => candidate.id === thread) : undefined;
    if (owner && kind === "text") owner.lastActivityAt = message.createdAt;
    entry.conversation = {
      ...entry.conversation,
      rev,
      ...(kind === "text"
        ? {
            lastActivityAt: message.createdAt,
            lastMessage: {
              thread: thread ? { id: thread, name: entry.threads.find((candidate) => candidate.id === thread)!.name } : null,
              id: message.id,
              author: message.author,
              preview: body,
              createdAt: message.createdAt,
            },
          }
        : {}),
    };
    project(entry);
    return message;
  };
  const publish = (message: Message) => {
    const { systemText: _, ...live } = message;
    deliver("conversation", message.conversationId, { type: "message", message: live });
    const { conversationId, id, seq, rev, kind, author, createdAt } = message;
    deliver("list", conversationId, {
      type: "summary",
      thread: message.thread,
      conversationId,
      id,
      seq,
      rev,
      kind,
      author,
      createdAt,
      preview: message.body,
      mention: false,
    });
  };
  const announce = (chat: string, system: SystemMessage, text: string) => {
    const message = append(chat, viewer, "", new Date(chats.get(chat)!.conversation.lastActivityAt), "system");
    message.system = system;
    message.systemText = text;
    publish(message);
  };
  const revoke = (chat: string) => {
    publish(append(chat, nora, "", now(), "system"));
    chats.delete(chat);
    deliver("me", chat, { type: "membership", conversationId: chat });
  };

  /** A chat with `count` messages, alternating between the viewer and the others, one every `spacing` minutes. */
  const addChat = (options: {
    members: Person[];
    name?: string;
    count: number;
    end: Date;
    spacing?: number;
    permission?: Permission;
    unread?: number;
  }) => {
    const id = chatId(++nextChat);
    for (const person of options.members) people.set(person.id, person);
    const members = [...new Map([viewer, ...options.members].map((person) => [person.id, person])).values()];
    const others = options.members.filter((member) => member.id !== viewer.id);
    const title =
      options.name ??
      (others.length === 0 ? "You" : others.length === 1 ? others[0]!.name : others.map((member) => member.name.split(" ")[0]).join(", "));
    const spacing = (options.spacing ?? 3) * 60_000;
    const start = new Date(options.end.getTime() - options.count * spacing);
    chats.set(id, {
      conversation: {
        threads: 0,
        id,
        name: options.name ?? null,
        icon: null,
        purpose: null,
        title,
        memberCount: members.length,
        unread: 0,
        read: { lastReadSeq: null, unreadFromSeq: null, joinedSeq: 0 },
        withGuests: false,
        peerDeactivated: false,
        rev: 0,
        permission: options.permission ?? "admin",
        createdAt: start.toISOString(),
        lastActivityAt: start.toISOString(),
        lastMessage: null,
      },
      messages: [],
      members: members.map((person) =>
        makeMember(
          { type: "user", userId: person.id },
          person.id === viewer.id ? (options.permission ?? "admin") : "write",
          start.toISOString(),
        ),
      ),
      archived: false,
      threads: [],
    });
    append(id, viewer, "", start, "system");
    const lines = [
      "Morning! Did the delivery arrive?",
      "Yes, at 7. Two boxes are damaged.",
      "Can you send photos to the supplier?",
      "Already done. They answer **today**.",
      "Great, thanks. Then we keep the plan for Thursday.",
      "One more thing: the invoice lists 12 chairs, we ordered 10. I will ask them to correct it before we pay anything.",
    ];
    for (let index = 1; index < options.count; index += 1) {
      const author = index % 3 === 0 ? viewer : (others[index % others.length] ?? viewer);
      append(id, author, lines[index % lines.length]!, new Date(start.getTime() + index * spacing));
    }
    const chat = chats.get(id)!;
    const incoming = chat.messages.filter((message) => message.kind === "text" && message.author.id !== viewer.id);
    const firstUnread = options.unread ? incoming.slice(-options.unread)[0] : undefined;
    chat.conversation.read = { lastReadSeq: firstUnread ? firstUnread.seq - 1 : chat.messages.length, unreadFromSeq: null, joinedSeq: 0 };
    project(chat);
    return id;
  };

  const page = (chat: Chat, query: URLSearchParams) => {
    const before = query.get("before");
    const after = query.get("after");
    const view = query.get("thread");
    const all = chat.messages;
    const selected = view ? all.filter((message) => (view === "general" ? message.thread === null : message.thread === view)) : all;
    const items = after
      ? selected.filter((message) => message.seq > Number(after)).slice(0, 50)
      : selected.filter((message) => (before ? message.seq < Number(before) : true)).slice(-50);
    return {
      items,
      seqHead: all.length,
      rev: chat.conversation.rev,
      from: after ? Number(after) + 1 : items.length === 50 ? items[0]!.seq : 1,
      to: before ? Number(before) - 1 : after && items.length === 50 ? items.at(-1)!.seq : all.length,
    };
  };
  const list = () => ({
    items: [...chats.values()].map((chat) => chat.conversation).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)),
    nextCursor: null,
  });
  const snapshot = (id: string, focus: string | null, view = "all") => {
    const chat = chats.get(id);
    if (!chat) return null;
    if (view !== "all" && view !== "general" && !chat.threads.some((thread) => thread.id === view)) return null;
    const selected =
      view === "all" ? chat.messages : chat.messages.filter((message) => message.thread === (view === "general" ? null : view));
    const target = focus ? selected.find((message) => message.id === focus) : undefined;
    // The first unread position among the threads the view shows.
    const views = view === "all" ? [null, ...chat.threads.map((thread) => thread.id)] : [view === "general" ? null : view];
    const firstUnread = selected.find(
      (message) =>
        message.kind === "text" &&
        message.author.id !== viewer.id &&
        views.includes(message.thread) &&
        message.seq > (startOf(chat, message.thread) ?? Number.POSITIVE_INFINITY),
    );
    const position = target ? target.seq : !focus && firstUnread ? firstUnread.seq : null;
    const items = position === null ? selected.slice(-50) : selected.filter((message) => message.seq < position + 25).slice(-50);
    return {
      cursor: `c.${cursor}`,
      conversation: chat.conversation,
      threads: threadList(chat),
      page: {
        items,
        seqHead: chat.messages.length,
        rev: chat.conversation.rev,
        from: items.length === 50 ? items[0]!.seq : 1,
        to: position === null ? chat.messages.length : Math.min(position + 24, chat.messages.length),
      },
      focus: target?.id ?? null,
    };
  };

  const server = Bun.serve<unknown, never>({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request, bun) {
      const url = new URL(request.url);
      if (url.pathname === "/api/chat/live")
        return bun.upgrade(request, { data: undefined }) ? undefined : new Response("upgrade failed", { status: 400 });
      if (url.pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
      if (url.pathname === "/styles.css") return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
      if (url.pathname === "/fonts.css") return new Response(fontAssets.css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
      if (url.pathname === "/tabler-icons.woff2") return new Response(Bun.file(fontAssets.icons));
      if (url.pathname.startsWith("/fonts/")) return new Response(Bun.file(resolve(uiDist, `.${url.pathname}`)));
      if (url.pathname === "/api/accounts/entities" && request.method === "GET") {
        const search = (url.searchParams.get("search") ?? "").toLowerCase();
        const kinds = (url.searchParams.get("kinds") ?? "user,group").split(",");
        const excludedUsers = (url.searchParams.get("exclude_user_ids") ?? "").split(",");
        const excludedGroups = (url.searchParams.get("exclude_group_ids") ?? "").split(",");
        const items = [
          ...[...people.values()]
            .filter((person) => kinds.includes("user") && !excludedUsers.includes(person.id) && person.name.toLowerCase().includes(search))
            .map((person) => ({
              kind: "user",
              user: { id: person.id, displayName: person.name, uid: person.name.toLowerCase().replaceAll(" ", "."), mail: null },
            })),
          ...[...groups.values()]
            .filter((group) => kinds.includes("group") && !excludedGroups.includes(group.id) && group.name.toLowerCase().includes(search))
            .map((group) => ({ kind: "group", group: { id: group.id, name: group.name, description: null } })),
        ];
        return Response.json({ items: items.slice(0, 10), pagination: { total: items.length, page: 1, per_page: 10, has_next: false } });
      }
      if (url.pathname === "/api/chat/people" && request.method === "GET") {
        const { search, cursor } = PeopleQuerySchema.parse(Object.fromEntries(url.searchParams));
        const coMembers = new Set(
          [...chats.values()].flatMap((chat) =>
            chat.members.flatMap((member) => (member.principal.type === "user" ? [member.principal.userId] : [])),
          ),
        );
        const matches = [...people.values()]
          .filter(
            (person) =>
              person.id !== viewer.id && coMembers.has(person.id) && person.name.toLowerCase().includes(search?.toLowerCase() ?? ""),
          )
          .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id))
          .filter(
            (person) =>
              !cursor ||
              person.name.toLowerCase().localeCompare(cursor.name) > 0 ||
              (person.name.toLowerCase() === cursor.name && person.id > cursor.id),
          );
        const items = matches.slice(0, PEOPLE_PAGE_SIZE).map((person) => ({ id: person.id, displayName: person.name }));
        const last = items.at(-1);
        return Response.json(
          PeoplePageSchema.parse({
            items,
            nextCursor:
              matches.length > PEOPLE_PAGE_SIZE && last ? JSON.stringify({ name: last.displayName.toLowerCase(), id: last.id }) : null,
          }),
        );
      }
      // The Cloud element picker's search and the reader behind a card, for elements of a made-up "spaces" app.
      if (url.pathname === "/api/search") {
        const query = (url.searchParams.get("q") ?? "").toLowerCase();
        const results = [...elements.values()]
          .filter((element) => element.readable && element.title.toLowerCase().includes(query))
          .map((element) => ({
            appId: "spaces",
            appName: "Spaces",
            appIcon: "ti ti-layout-kanban",
            readable: true,
            ref: { type: "spaces.task", id: element.id },
            title: element.title,
            preview: element.preview,
            href: `/app/spaces/task/${element.id}`,
          }));
        const lines = [
          { type: "start", query, apps: [{ id: "spaces", name: "Spaces", icon: "ti ti-layout-kanban" }], providers: ["spaces"] },
          { type: "provider", provider: "spaces", status: "ok", results, ms: 1 },
          { type: "done", status: "complete", count: results.length },
        ];
        return new Response(lines.map((line) => `${JSON.stringify(line)}\n`).join(""), {
          headers: { "content-type": "application/x-ndjson; charset=utf-8" },
        });
      }
      if (url.pathname === "/api/capabilities/v1/catalog") return Response.json(catalog);
      if (url.pathname === "/api/capabilities/v1/queries/spaces/task.read" && request.method === "POST") {
        readerCalls += 1;
        const { input } = z.object({ input: z.object({ id: z.string() }) }).parse(await request.json());
        const element = elements.get(input.id);
        if (!element?.readable) return Response.json({ code: "FORBIDDEN", message: "No access" }, { status: 403 });
        return Response.json({
          data: { id: element.id },
          refs: [{ type: "spaces.task", id: element.id, title: element.title, preview: element.preview, icon: "ti ti-circle" }],
          links: [{ rel: "open", href: `/app/spaces/task/${element.id}` }],
        });
      }
      if (url.pathname === "/api/chat/conversations" && request.method === "GET") return Response.json(list());
      if (url.pathname === "/api/chat/conversations" && request.method === "POST") {
        const input = CreateConversationSchema.parse(await request.json());
        const replay = input.createKey && createIntents.get(input.createKey);
        if (replay)
          return Response.json(CreateOutcomeSchema.parse({ outcome: "created", conversation: chats.get(replay)!.conversation }), {
            status: 201,
          });
        const direct = new Set([viewer.id, ...input.members.flatMap((principal) => (principal.type === "user" ? [principal.userId] : []))]);
        if (!input.allowDuplicate && input.members.every((principal) => principal.type === "user")) {
          const matches = [...chats.values()]
            .filter(
              (chat) =>
                chat.members.length === direct.size &&
                chat.members.every((member) => member.principal.type === "user" && direct.has(member.principal.userId)),
            )
            .sort(
              (a, b) =>
                b.conversation.lastActivityAt.localeCompare(a.conversation.lastActivityAt) ||
                b.conversation.id.localeCompare(a.conversation.id),
            )
            .slice(0, MAX_EXISTING_MATCHES)
            .map((chat) => ExistingMatchSchema.parse({ ...chat.conversation, archived: chat.archived }));
          if (matches.length) return Response.json(CreateOutcomeSchema.parse({ outcome: "existing", matches }));
        }
        // A new chat is the newest one, also within the same millisecond as the latest activity.
        const latest = [...chats.values()].reduce((at, chat) => Math.max(at, Date.parse(chat.conversation.lastActivityAt)), 0);
        const id = addChat({
          members: [...direct].map((id) => people.get(id)!),
          name: input.name ?? undefined,
          count: 1,
          end: new Date(Math.max(latest + 1, now().getTime())),
          spacing: 0,
        });
        if (input.createKey) createIntents.set(input.createKey, id);
        const chat = chats.get(id)!;
        chat.conversation = { ...chat.conversation, icon: input.icon ?? null, purpose: input.purpose ?? null };
        for (const principal of input.members.filter((principal) => principal.type === "group"))
          chat.members.push(makeMember(principal, "write", chat.conversation.createdAt));
        refreshMembers(chat);
        publish(chat.messages[0]!);
        deliver("me", id, { type: "membership", conversationId: id });
        return Response.json(CreateOutcomeSchema.parse({ outcome: "created", conversation: chat.conversation }), { status: 201 });
      }
      if (url.pathname === "/api/chat/conversations/read-all" && request.method === "POST") {
        const { confirmed } = ReadAllSchema.parse(await request.json());
        const candidates = () =>
          [...chats.values()]
            .filter((chat) => project(chat).unread > 0 || chat.conversation.read?.unreadFromSeq != null)
            .sort(
              (a, b) =>
                b.conversation.lastActivityAt.localeCompare(a.conversation.lastActivityAt) ||
                b.conversation.id.localeCompare(a.conversation.id),
            );
        const batch = candidates().slice(0, confirmed ? READ_ALL_BATCH : READ_ALL_CONFIRM_FROM);
        if (!confirmed && batch.length >= READ_ALL_CONFIRM_FROM) return Response.json({ outcome: "confirm" });
        for (const chat of batch) read(chat.conversation.id, chat.messages.length, "all");
        return Response.json({ outcome: "done", marked: batch.length, more: candidates().length > 0 });
      }
      const match = /^\/api\/chat\/conversations\/([^/]+)(?:\/([a-z]+)(?:\/([^/]+))?)?$/.exec(url.pathname);
      if (match) {
        const [, id, part, accessId] = match;
        const chat = chats.get(id!);
        if (!chat) return Response.json({ code: "NOT_FOUND", message: "Chat not found." }, { status: 404 });
        if ((request.method === "PATCH" && !part) || (part === "members" && request.method !== "GET")) {
          if (chat.conversation.permission !== "admin")
            return Response.json({ code: "FORBIDDEN", message: "Manage permission is required." }, { status: 403 });
        }
        if (part === "threads") {
          const thread = accessId ? chat.threads.find((entry) => entry.id === accessId) : undefined;
          if (request.method === "GET" && !accessId) return Response.json(threadList(chat));
          if (chat.conversation.permission !== "admin")
            return Response.json({ code: "FORBIDDEN", message: "Manage permission is required." }, { status: 403 });
          if (failingThreads > 0) {
            failingThreads -= 1;
            return Response.json({ message: "Unavailable" }, { status: 503 });
          }
          const taken = (name: string, except?: string) =>
            chat.threads.some((entry) => entry.id !== except && entry.name.toLowerCase() === name.toLowerCase());
          if (request.method === "POST" && !accessId) {
            const input = CreateThreadSchema.parse(await request.json());
            if (taken(input.name))
              return Response.json({ code: "THREAD_NAME_TAKEN", message: "A thread with this name already exists." }, { status: 409 });
            const created: ThreadEntry = {
              id: threadId(id!, chat.threads.length + 1),
              name: input.name,
              description: input.description ?? null,
              archived: false,
              read: null,
              createdAt: now().toISOString(),
              lastActivityAt: now().toISOString(),
            };
            chat.threads.push(created);
            announce(
              id!,
              { code: "thread_created", params: { thread: { id: created.id, name: created.name } } },
              `${viewer.name} created the thread “${created.name}”`,
            );
            project(chat);
            deliver("conversation", id!, { type: "threads", conversationId: id });
            return Response.json(
              threadList(chat).items.find((entry) => entry.id === created.id),
              { status: 201 },
            );
          }
          if (request.method === "PATCH" && thread) {
            const input = UpdateThreadSchema.parse(await request.json());
            if (input.name !== undefined && taken(input.name, thread.id))
              return Response.json({ code: "THREAD_NAME_TAKEN", message: "A thread with this name already exists." }, { status: 409 });
            const from = thread.name;
            if (input.name !== undefined) thread.name = input.name;
            if (input.description !== undefined) thread.description = input.description;
            if (input.archived !== undefined) thread.archived = input.archived;
            project(chat);
            if (input.name !== undefined && input.name !== from) {
              const line = append(id!, viewer, "", now(), "system", { thread: thread.id });
              line.system = { code: "thread_renamed", params: { from, to: thread.name } };
              line.systemText = `${viewer.name} renamed “${from}” to “${thread.name}”`;
              publish(line);
            }
            deliver("conversation", id!, { type: "threads", conversationId: id });
            return Response.json(threadList(chat).items.find((entry) => entry.id === thread.id));
          }
          return Response.json({ code: "NOT_FOUND", message: "Thread not found." }, { status: 404 });
        }
        if (!part && request.method === "PATCH") {
          const input = UpdateConversationSchema.parse(await request.json());
          chat.conversation = {
            ...chat.conversation,
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.icon !== undefined ? { icon: input.icon } : {}),
            ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
          };
          refreshMembers(chat);
          announce(id!, { code: "details_changed", params: input }, `${viewer.name} changed the chat details.`);
          return Response.json(ConversationSchema.parse(chat.conversation));
        }
        if (part === "members" && !accessId && request.method === "GET") {
          const { q, cursor } = MemberQuerySchema.parse(Object.fromEntries(url.searchParams));
          const matches = chat.members
            .filter((member) => member.displayName.toLowerCase().includes(q?.toLowerCase() ?? ""))
            .sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()) || a.accessId.localeCompare(b.accessId))
            .filter(
              (member) =>
                !cursor ||
                member.displayName.toLowerCase().localeCompare(cursor.name) > 0 ||
                (member.displayName.toLowerCase() === cursor.name && member.accessId > cursor.id),
            );
          const own = chat.members.find((member) => member.principal.type === "user" && member.principal.userId === viewer.id);
          const items = matches.slice(0, MEMBER_PAGE_SIZE);
          const last = items.at(-1);
          return Response.json(
            MemberPageSchema.parse({
              items,
              nextCursor:
                matches.length > MEMBER_PAGE_SIZE && last
                  ? JSON.stringify({ name: last.displayName.toLowerCase(), id: last.accessId })
                  : null,
              managers: managers(chat),
              self: own ? { accessId: own.accessId, permission: own.permission, active: !own.deactivated } : null,
            }),
          );
        }
        if (part === "members" && request.method === "POST" && (!accessId || accessId === "preview")) {
          const { members } = AddMembersSchema.parse(await request.json());
          const additions = joiningMembers(chat, members);
          const throughGroups = additions.reduce(
            (count, principal) => count + (principal.type === "group" ? groups.get(principal.groupId)!.size : 0),
            0,
          );
          const joining = additions.filter((principal) => principal.type === "user").length + throughGroups;
          if (accessId === "preview")
            return Response.json(
              MemberPreviewSchema.parse({ joining, throughGroups, memberCount: chat.conversation.memberCount + joining }),
            );
          const added = additions.map((principal) => makeMember(principal, "write", chat.conversation.lastActivityAt));
          chat.members.push(...added);
          refreshMembers(chat);
          const users = added
            .filter((member) => member.principal.type === "user")
            .map((member) => ({ id: principalId(member.principal), name: member.displayName }));
          const addedGroups = added
            .filter((member) => member.principal.type === "group")
            .map((member) => ({ id: principalId(member.principal), name: member.displayName }));
          if (users.length)
            announce(
              id!,
              { code: "members_added", params: { members: users } },
              `${viewer.name} added ${users.map((person) => person.name).join(", ")}.`,
            );
          if (addedGroups.length)
            announce(
              id!,
              { code: "groups_added", params: { groups: addedGroups } },
              `${viewer.name} added ${addedGroups.map((group) => group.name).join(", ")}.`,
            );
          return Response.json(ChangeSchema.parse({ added: added.length }));
        }
        if (part === "members" && accessId && (request.method === "PATCH" || request.method === "DELETE")) {
          const member = chat.members.find((entry) => entry.accessId === accessId);
          if (!member) return Response.json({ code: "NOT_FOUND", message: "Member not found." }, { status: 404 });
          const permission = request.method === "PATCH" ? UpdateMemberSchema.parse(await request.json()).permission : null;
          if (
            member.principal.type === "user" &&
            !member.deactivated &&
            member.permission === "admin" &&
            permission !== "admin" &&
            managers(chat) === 1
          )
            return Response.json(
              { code: "LAST_MANAGER", message: "The chat must keep at least one member with Manage permission." },
              { status: 409 },
            );
          const person = { id: principalId(member.principal), name: member.displayName };
          if (permission) {
            member.permission = permission;
            if (member.principal.type === "user" && member.principal.userId === viewer.id)
              chat.conversation = { ...chat.conversation, permission };
            announce(id!, { code: "permission_changed", params: { member: person, permission } }, `${person.name}'s permission changed.`);
          } else {
            chat.members = chat.members.filter((entry) => entry !== member);
            refreshMembers(chat);
            if (member.principal.type === "user" && member.principal.userId === viewer.id) revoke(id!);
            else
              announce(
                id!,
                member.principal.type === "group"
                  ? { code: "group_removed", params: { group: person } }
                  : { code: "member_removed", params: { member: person } },
                `${viewer.name} removed ${person.name}.`,
              );
          }
          return Response.json(
            permission ? SuccessSchema.parse({ success: true }) : MemberRemovalSchema.parse({ success: true, keptThroughGroup: false }),
          );
        }
        if (part === "leave" && request.method === "POST") {
          const { successor } = LeaveSchema.parse(await request.json());
          const own = chat.members.find((member) => member.principal.type === "user" && member.principal.userId === viewer.id)!;
          const lastManager = own.permission === "admin" && !own.deactivated && managers(chat) === 1;
          if (lastManager && !successor)
            return Response.json(
              { code: "CONFLICT", message: "Choose another direct member as successor before leaving as the last manager." },
              { status: 409 },
            );
          const next = successor
            ? chat.members.find(
                (member) => member.accessId === successor && member !== own && member.principal.type === "user" && !member.deactivated,
              )
            : undefined;
          if (successor && !next)
            return Response.json({ code: "BAD_INPUT", message: "Choose another direct member as successor." }, { status: 400 });
          if (lastManager && next) next.permission = "admin";
          chat.members = chat.members.filter((member) => member !== own);
          refreshMembers(chat);
          revoke(id!);
          return Response.json(MemberRemovalSchema.parse({ success: true, keptThroughGroup: false }));
        }
        if (part === "read" && request.method === "POST") {
          const { seq, thread } = ReadSchema.parse(await request.json());
          reads.push({ chat: id!, seq });
          readViews.push({ chat: id!, seq, thread });
          return Response.json(read(id!, seq, thread));
        }
        if (part === "unread" && request.method === "POST") {
          if (failingUnread > 0) {
            failingUnread -= 1;
            return Response.json({ message: "Unavailable" }, { status: 503 });
          }
          const { message } = MarkUnreadSchema.parse(await request.json());
          const data = markUnread(id!, message);
          return data ? Response.json(data) : Response.json({ code: "NOT_FOUND", message: "Message not found." }, { status: 404 });
        }
        if (!part) return Response.json(chat.conversation);
        if (part === "snapshot") {
          const open = snapshot(id!, url.searchParams.get("message"), url.searchParams.get("thread") ?? "all");
          return open ? Response.json(open) : Response.json({ code: "NOT_FOUND", message: "Thread not found." }, { status: 404 });
        }
        if (part === "shared" && request.method === "GET") {
          if (failingShared > 0) {
            failingShared -= 1;
            return Response.json({ message: "Unavailable" }, { status: 503 });
          }
          const kind = url.searchParams.get("kind") ?? "all";
          const thread = url.searchParams.get("thread");
          const items = chat.messages
            .filter((message) => message.kind === "text" && (!thread || (message.thread ?? "general") === thread))
            .toReversed()
            .flatMap((message) => {
              const meta = {
                messageId: message.id,
                seq: message.seq,
                thread: message.thread,
                author: message.author,
                createdAt: message.createdAt,
              };
              const links = [...(message.body ?? "").matchAll(/https?:\/\/[^\s)]+/g)].map((found) => ({
                kind: "link" as const,
                url: found[0],
                ...meta,
              }));
              const elements = message.refs.map((ref) => ({ kind: "element" as const, ref, ...meta }));
              return [...(kind === "all" || kind === "elements" ? elements : []), ...(kind === "all" || kind === "links" ? links : [])];
            });
          return Response.json({ items: items.slice(0, 30), nextCursor: null });
        }
        if (part === "changes") return Response.json({ rev: chat.conversation.rev, more: false, conversation: null, messages: [] });
        if (part === "messages" && request.method === "GET") return Response.json(page(chat, url.searchParams));
        if (part === "messages" && request.method === "POST") {
          const input = SendMessageSchema.parse(await request.json());
          posted.push({ chat: id!, ...input });
          if (failing > 0) {
            failing -= 1;
            return Response.json({ message: "Unavailable" }, { status: 503 });
          }
          const thread = input.thread ? chat.threads.find((entry) => entry.id === input.thread) : undefined;
          if (input.thread && !thread) return Response.json({ code: "NOT_FOUND", message: "Thread not found." }, { status: 404 });
          if (thread?.archived)
            return Response.json({ code: "THREAD_ARCHIVED", message: "Restore this thread before sending a message." }, { status: 409 });
          const message = append(id!, viewer, input.body, now(), "text", {
            thread: input.thread ?? null,
            replyTo: input.replyTo,
            refs: input.refs ?? [],
          });
          publish(message);
          return Response.json(message, { status: 201 });
        }
      }
      if (url.pathname.startsWith("/api/")) return Response.json({ message: "Not part of this harness" }, { status: 404 });
      const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
      return new Response(
        `<!doctype html><html class="${theme}" style="--app-accent:#7c3aed"><head><meta charset="utf-8">` +
          '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
          '<link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/styles.css"></head><body class="k2b-ui" style="margin:0">' +
          '<div id="root" style="position:fixed;inset:0;display:flex;flex-direction:column"></div>' +
          // Every weight and the icon font load with the page, so a font swap never moves rows during a test.
          '<div aria-hidden="true" style="position:absolute;visibility:hidden"><b>a</b><b style="font-weight:600">a</b><span style="font-weight:500">a</span><em>a</em>' +
          '<span>a</span><i class="ti ti-check"></i></div>' +
          '<script src="/harness.js"></script></body></html>',
        { headers: { "Content-Type": "text/html" } },
      );
    },
    websocket: {
      message(socket, raw) {
        const frame = z
          .object({
            t: z.string(),
            id: z.string(),
            channel: z.string().optional(),
            scope: z.object({ conversation: z.string().optional() }).optional(),
            after: z.string().optional(),
          })
          .parse(JSON.parse(String(raw)));
        if (frame.t === "sub") {
          subscriptions.push({ socket, id: frame.id, channel: frame.channel!, scope: frame.scope ?? {} });
          const after = Number(frame.after?.slice(2) ?? cursor);
          socket.send(JSON.stringify({ t: "ready", id: frame.id, cursor: `c.${after}` }));
          for (const event of events) {
            if (
              event.cursor <= after ||
              event.channel !== frame.channel ||
              (event.channel === "conversation" && event.chat !== frame.scope?.conversation)
            )
              continue;
            socket.send(JSON.stringify({ t: "event", id: frame.id, cursor: `c.${event.cursor}`, data: event.data }));
          }
        }
        if (frame.t === "unsub") {
          const index = subscriptions.findIndex((subscription) => subscription.socket === socket && subscription.id === frame.id);
          if (index >= 0) subscriptions.splice(index, 1);
        }
      },
      close(socket) {
        for (let index = subscriptions.length - 1; index >= 0; index -= 1)
          if (subscriptions[index]!.socket === socket) subscriptions.splice(index, 1);
      },
    },
  });

  return {
    url: server.url.href,
    now,
    addChat,
    /** Adds a person to the directory available to the member pickers. */
    addPerson: (person: Person) => {
      people.set(person.id, person);
    },
    /** Adds a group with a deterministic size to the directory. */
    addGroup: (group: Group) => {
      groups.set(group.id, group);
    },
    /** Adds `count` deterministic direct members with Write permission. */
    seedMembers: (chat: string, count: number) => {
      const entry = chats.get(chat)!;
      const existing = entry.members.filter((member) => member.displayName.startsWith("Member ")).length;
      for (let index = 1; index <= count; index += 1) {
        const person = {
          id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(++nextPerson).padStart(12, "0")}`,
          name: `Member ${String(existing + index).padStart(3, "0")}`,
        };
        people.set(person.id, person);
        entry.members.push(makeMember({ type: "user", userId: person.id }, "write", entry.conversation.createdAt));
      }
      refreshMembers(entry);
    },
    /** Sets the viewer's direct permission and the conversation's projected permission. */
    setPermission: (chat: string, permission: Permission) => {
      const entry = chats.get(chat)!;
      const own = entry.members.find((member) => member.principal.type === "user" && member.principal.userId === viewer.id)!;
      own.permission = PermissionSchema.parse(permission);
      entry.conversation = { ...entry.conversation, permission: own.permission };
    },
    /** Sets the viewer's archived flag reported by duplicate-chat matches. */
    archive: (chat: string, archived: boolean) => {
      chats.get(chat)!.archived = archived;
    },
    /** Returns the current member entries for assertions. */
    members: (chat: string): Member[] => chats.get(chat)?.members ?? [],
    posted,
    /** An element of the made-up "spaces" app; `readable: false` makes its card "not available". */
    addElement: (element: { id: string; title: string; preview?: string; readable?: boolean }) => {
      elements.set(element.id, { preview: "", readable: true, ...element });
      return { type: "spaces.task", id: element.id } satisfies CloudResourceRef;
    },
    /** A message from someone else that shares elements, delivered live. */
    receiveShared: (chat: string, author: Person, body: string, refs: CloudResourceRef[]) =>
      publish(append(chat, author, body, now(), "text", { refs })),
    /** The next shared lists fail. */
    failShared: (times = 1) => {
      failingShared = times;
    },
    readerCalls: () => readerCalls,
    reads,
    readViews,
    chatCount: () => chats.size,
    /** Advances the viewer's read state on another device, without recording a page report. */
    readElsewhere: read,
    /** Isolates scenarios; IDs stay unique so a closing page cannot report against a later chat. */
    reset: () => {
      chats.clear();
      createIntents.clear();
      people.clear();
      for (const person of [viewer, nora, tobias]) people.set(person.id, person);
      groups.clear();
      nextAccess = 0;
      nextPerson = 0;
      events.length = 0;
      reads.length = 0;
      readViews.length = 0;
      posted.length = 0;
      failing = 0;
      failingUnread = 0;
      failingThreads = 0;
      failingShared = 0;
      elements.clear();
      readerCalls = 0;
    },
    /** Lets tests await the live connection before publishing. */
    subscribed: (chat?: string) =>
      ["list", "me", ...(chat ? ["conversation"] : [])].every((channel) =>
        subscriptions.some(
          (subscription) => subscription.channel === channel && (channel !== "conversation" || subscription.scope.conversation === chat),
        ),
      ),
    /** Makes the next `count` sends fail with 503. */
    failSends: (count = 1) => {
      failing = count;
    },
    /** Makes the next `count` thread creations or changes fail with 503. */
    failThreads: (count = 1) => {
      failingThreads = count;
    },
    /**
     * Adds a thread with `count` messages from others, the last `unread` of them unread, one every three minutes up to
     * `end`. Returns the thread's ID.
     */
    addThread: (
      chat: string,
      options: { name: string; description?: string; count?: number; unread?: number; archived?: boolean; end?: Date },
    ) => {
      const entry = chats.get(chat)!;
      const id = threadId(chat, entry.threads.length + 1);
      const end = options.end ?? now();
      const count = options.count ?? 0;
      entry.threads.push({
        id,
        name: options.name,
        description: options.description ?? null,
        archived: options.archived ?? false,
        read: null,
        createdAt: new Date(end.getTime() - (count + 1) * 180_000).toISOString(),
        lastActivityAt: new Date(end.getTime() - (count + 1) * 180_000).toISOString(),
      });
      const authors = [nora, tobias];
      for (let index = 0; index < count; index += 1)
        append(
          chat,
          authors[index % 2]!,
          `${options.name}: update ${index + 1}`,
          new Date(end.getTime() - (count - index) * 180_000),
          "text",
          {
            thread: id,
          },
        );
      const thread = entry.threads.find((candidate) => candidate.id === id)!;
      const incoming = entry.messages.filter((message) => message.thread === id && message.author.id !== viewer.id);
      const first = options.unread ? incoming.slice(-options.unread)[0] : undefined;
      thread.read = { lastReadSeq: first ? first.seq - 1 : entry.messages.length, unreadFromSeq: null };
      // General keeps its own read state: everything in it stays read.
      if (entry.conversation.read && !first) entry.conversation.read = { ...entry.conversation.read };
      project(entry);
      return id;
    },
    /** Stores a message from another person in a thread, or as a reply, and delivers it live. */
    receiveIn: (chat: string, author: Person, body: string, target: { thread?: string; replyTo?: string }) =>
      publish(append(chat, author, body, now(), "text", target)),
    /** The viewer's state of a thread for assertions. */
    thread: (chat: string, id: string) => chats.get(chat)?.threads.find((entry) => entry.id === id),
    /** Makes the next `count` "mark unread" requests fail with 503. */
    failUnread: (count = 1) => {
      failingUnread = count;
    },
    /** Stores a message from another person and delivers it live. */
    receive: (chat: string, author: Person, body: string) => publish(append(chat, author, body, now())),
    /** Renames a chat and announces it live with a system message, as a details change does. */
    rename: (chat: string, title: string) => {
      const entry = chats.get(chat)!;
      entry.conversation = { ...entry.conversation, name: title, title };
      announce(chat, { code: "details_changed", params: { name: title } }, `${viewer.name} changed the chat details.`);
    },
    /** Announces a system message and then answers 404 for the chat, as removing the reader does. */
    revoke,
    messageId,
    /** The island's props for an address, as the server renders them. */
    props: (
      address: { chat?: string; message?: string; panel?: string; thread?: string; threadsPage?: boolean },
      options: { guest?: boolean } = {},
    ): ChatWorkspaceProps => {
      const view = address.thread ?? "all";
      const open = address.chat ? snapshot(address.chat, address.message ?? null, view) : null;
      return {
        cursor: `c.${cursor}`,
        sidebar: list(),
        view,
        threadsPage: address.threadsPage ?? false,
        open: open && { threads: open.threads, conversation: open.conversation, page: open.page, focus: open.focus },
        chatId: address.chat ?? null,
        guest: options.guest ?? false,
        panel: open && address.panel === "info" ? "info" : null,
        viewerId: viewer.id,
        dateConfig: { locale: "en", timeZone: "Europe/Berlin", firstDayOfWeek: 1 },
        now: now().toISOString(),
      };
    },
    stop: () => server.stop(true),
  };
};
