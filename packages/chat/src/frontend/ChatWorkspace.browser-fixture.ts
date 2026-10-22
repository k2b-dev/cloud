import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerWebSocket } from "bun";
import { z } from "zod";
import {
  AddMembersSchema,
  ChangeSchema,
  ConversationSchema,
  CreateConversationSchema,
  CreateOutcomeSchema,
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
  PersonalConversationSchema,
  READ_ALL_BATCH,
  READ_ALL_CONFIRM_FROM,
  ReadAllSchema,
  ReadSchema,
  readStart,
  SendMessageSchema,
  SidebarPreferencesSchema,
  SuccessSchema,
  type SystemMessage,
  UNREAD_CAP,
  UpdateConversationSchema,
  UpdateMemberSchema,
} from "../service/contracts";
import type { ChatWorkspaceProps } from "./ChatWorkspace.island";

type Conversation = z.infer<typeof ConversationSchema>;
type Message = z.infer<typeof MessageViewSchema>;
type Person = { id: string; name: string };
type Group = { id: string; name: string; size: number };
type Member = z.infer<typeof MemberSchema>;
type Permission = z.infer<typeof PermissionSchema>;
type Chat = { conversation: Conversation; messages: Message[]; members: Member[]; archived: boolean };
type Subscription = { socket: ServerWebSocket<unknown>; id: string; channel: string; scope: { conversation?: string } };

/** Midday in Berlin keeps even the longest seeded history on one fixed calendar day. */
export const chatTestNow = new Date("2026-10-14T10:00:00.000Z");

export const viewer: Person = { id: "11111111-1111-4111-8111-111111111111", name: "Robin Example" };
export const nora: Person = { id: "22222222-2222-4222-8222-222222222222", name: "Nora Weber" };
export const tobias: Person = { id: "33333333-3333-4333-8333-333333333333", name: "Tobias Brandt" };

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
export const startChatHarness = async (options: { autoMount?: boolean } = {}) => {
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
  const reads: { chat: string; seq: number }[] = [];
  const posted: { chat: string; clientId: string; body: string }[] = [];

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
  const project = (chat: Chat) => {
    const start = readStart(chat.conversation.read);
    chat.conversation = {
      ...chat.conversation,
      unread:
        start === null
          ? 0
          : Math.min(
              UNREAD_CAP,
              chat.messages.filter((message) => message.seq > start && message.kind === "text" && message.author.id !== viewer.id).length,
            ),
    };
    return chat.conversation;
  };
  const update = (id: string, changed: boolean) => {
    const conversation = project(chats.get(id)!);
    if (!conversation.read) throw new Error("Read update has no participant");
    const data = { conversationId: id, ...conversation.read, unread: conversation.unread, asOfRev: conversation.rev };
    if (changed) deliver("me", id, { type: "read", ...data });
    return data;
  };
  const read = (id: string, seq: number) => {
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
    const previous = chat.conversation.read;
    const state = previous ?? { lastReadSeq: null, unreadFromSeq: null, joinedSeq: chat.messages.length };
    const from = target?.seq ?? chat.messages.length;
    const base = Math.max(state.lastReadSeq ?? 0, state.joinedSeq);
    const changed = from >= 1 && from <= base && from !== state.unreadFromSeq;
    chat.conversation = { ...chat.conversation, read: { ...state, unreadFromSeq: changed ? from : state.unreadFromSeq } };
    return update(id, previous === null || changed);
  };
  const append = (chat: string, author: Person, body: string, at: Date, kind: "text" | "system" = "text") => {
    const entry = chats.get(chat)!;
    const seq = entry.messages.length + 1;
    const rev = entry.conversation.rev + 1;
    const message: Message = {
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
    entry.conversation = {
      ...entry.conversation,
      rev,
      ...(kind === "text"
        ? {
            lastActivityAt: message.createdAt,
            lastMessage: { id: message.id, author: message.author, preview: body, createdAt: message.createdAt },
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
        id,
        name: options.name ?? null,
        icon: null,
        purpose: null,
        title,
        memberCount: members.length,
        unread: 0,
        read: { lastReadSeq: null, unreadFromSeq: null, joinedSeq: 0 },
        archived: false,
        pinnedRank: null,
        member: true,
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
    const all = chat.messages;
    const items = after
      ? all.filter((message) => message.seq > Number(after)).slice(0, 50)
      : all.filter((message) => (before ? message.seq < Number(before) : true)).slice(-50);
    return { items, seqHead: all.length, rev: chat.conversation.rev };
  };
  let collapsed: string[] = [];
  const list = (archived = false, unread = false, ids?: string[]) => ({
    items: [...chats.values()]
      .map((chat) => chat.conversation)
      .filter((row) => row.member && row.archived === archived && (!ids || ids.includes(row.id)) && (!unread || row.unread > 0 || row.read?.unreadFromSeq != null))
      .sort((a,b) => (a.pinnedRank ?? 2147483647) - (b.pinnedRank ?? 2147483647) || b.lastActivityAt.localeCompare(a.lastActivityAt) || b.id.localeCompare(a.id)),
    nextCursor: null,
  });
  const snapshot = (id: string, focus: string | null) => {
    const chat = chats.get(id);
    if (!chat) return null;
    const target = focus ? chat.messages.find((message) => message.id === focus) : undefined;
    const start = readStart(chat.conversation.read);
    const position = target ? target.seq : !focus && chat.conversation.unread > 0 && start !== null ? start + 1 : null;
    const items = position === null ? chat.messages.slice(-50) : chat.messages.filter((message) => message.seq < position + 25).slice(-50);
    return {
      cursor: `c.${cursor}`,
      conversation: chat.conversation,
      page: { items, seqHead: chat.messages.length, rev: chat.conversation.rev },
      focus: target?.id ?? null,
    };
  };

  const viewProps = (
    address: { chat?: string; message?: string; panel?: string; archived?: boolean; filter?: "all" | "unread" },
    options: { guest?: boolean } = {},
  ): ChatWorkspaceProps => {
    const open = address.chat ? snapshot(address.chat, address.message ?? null) : null;
    return {
      cursor: `c.${cursor}`,
      sidebar: list(address.archived, address.filter === "unread"),
      archived: address.archived,
      filter: address.filter,
      collapsed: SidebarPreferencesSchema.parse({ collapsed }).collapsed,
      open: open && { conversation: open.conversation, page: open.page, focus: open.focus },
      chatId: address.chat ?? null,
      guest: options.guest ?? false,
      panel: open && address.panel === "info" ? "info" : null,
      viewerId: viewer.id,
      dateConfig: { locale: "en", timeZone: "Europe/Berlin", firstDayOfWeek: 1 },
      now: now().toISOString(),
    };
  };

  const server = Bun.serve<unknown, never>({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request, bun) {
      const url = new URL(request.url);
      if (url.pathname === "/api/chat/live")
        return bun.upgrade(request, { data: undefined }) ? undefined : new Response("upgrade failed", { status: 400 });
      if (url.pathname === "/__props") {
        const target = new URL(url.searchParams.get("path") ?? "/app/chat", "https://chat.test");
        const match = /^\/app\/chat\/c\/([^/]+)(?:\/m\/([^/]+))?/.exec(target.pathname);
        return Response.json(
          viewProps({
            chat: match?.[1],
            message: match?.[2],
            panel: target.searchParams.get("panel") ?? undefined,
            archived: target.pathname === "/app/chat/archive" || target.searchParams.get("list") === "archive",
            filter: target.searchParams.get("filter") === "unread" ? "unread" : "all",
          }),
        );
      }
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
      if (url.pathname === "/api/chat/preferences") {
        if (request.method === "PUT") collapsed = SidebarPreferencesSchema.parse(await request.json()).collapsed;
        return Response.json({ collapsed });
      }
      const personalMatch = /^\/api\/chat\/conversations\/([^/]+)\/personal$/.exec(url.pathname);
      if (personalMatch && request.method === "PUT") {
        const chat = chats.get(personalMatch[1]!);
        if (!chat) return Response.json({ message: "Not found" }, { status: 404 });
        const patch = PersonalConversationSchema.parse(await request.json());
        if (patch.archived !== undefined) chat.conversation.archived = patch.archived;
        if (patch.pinned === false) chat.conversation.pinnedRank = null;
        if (patch.pinned === true) {
          const pins = [...chats.values()]
            .filter((entry) => entry.conversation.pinnedRank !== null)
            .sort((a, b) => a.conversation.pinnedRank! - b.conversation.pinnedRank!);
          const old = pins.indexOf(chat);
          const remaining = pins.filter((entry) => entry !== chat);
          const index = patch.after
              ? remaining.findIndex((entry) => entry.conversation.id === patch.after) + 1
              : patch.before
                ? remaining.findIndex((entry) => entry.conversation.id === patch.before)
                : patch.before === undefined && old >= 0
                  ? old
                  : remaining.length;
          remaining.splice(index, 0, chat);
          remaining.forEach((entry, rank) => {
            entry.conversation.pinnedRank = rank;
          });
        }
        return Response.json(chat.conversation);
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
      if (url.pathname === "/api/chat/conversations" && request.method === "GET")
        return Response.json(list(url.searchParams.get("archived") === "true", url.searchParams.get("unread") === "true", url.searchParams.get("ids")?.split(",")));
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
        for (const chat of batch) read(chat.conversation.id, chat.messages.length);
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
          const { seq } = ReadSchema.parse(await request.json());
          reads.push({ chat: id!, seq });
          return Response.json(read(id!, seq));
        }
        if (part === "unread" && request.method === "POST") {
          const { message } = MarkUnreadSchema.parse(await request.json());
          const data = markUnread(id!, message);
          return data ? Response.json(data) : Response.json({ code: "NOT_FOUND", message: "Message not found." }, { status: 404 });
        }
        if (!part) return Response.json(chat.conversation);
        if (part === "snapshot") return Response.json(snapshot(id!, url.searchParams.get("message")));
        if (part === "changes") return Response.json({ rev: chat.conversation.rev, more: false, conversation: null, messages: [] });
        if (part === "messages" && request.method === "GET") return Response.json(page(chat, url.searchParams));
        if (part === "messages" && request.method === "POST") {
          const input = SendMessageSchema.parse(await request.json());
          posted.push({ chat: id!, ...input });
          if (failing > 0) {
            failing -= 1;
            return Response.json({ message: "Unavailable" }, { status: 503 });
          }
          const message = append(id!, viewer, input.body, now());
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
          '<script src="/harness.js"></script>' +
          (options.autoMount
            ? `<script>window.addEventListener('load',async()=>{const props=await(await fetch('/__props?path='+encodeURIComponent(location.pathname+location.search))).json();window.mountChat(props,new URLSearchParams(location.search).get('locale')||'en')})</script>`
            : "") +
          "</body></html>",
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
      chats.get(chat)!.conversation.archived = archived;
    },
    /** Returns the current member entries for assertions. */
    members: (chat: string): Member[] => chats.get(chat)?.members ?? [],
    posted,
    reads,
    chatCount: () => chats.size,
    /** Advances the viewer's read state on another device, without recording a page report. */
    readElsewhere: read,
    /** Isolates scenarios; IDs stay unique so a closing page cannot report against a later chat. */
    reset: () => {
      collapsed = [];
      chats.clear();
      createIntents.clear();
      people.clear();
      for (const person of [viewer, nora, tobias]) people.set(person.id, person);
      groups.clear();
      nextAccess = 0;
      nextPerson = 0;
      events.length = 0;
      reads.length = 0;
      posted.length = 0;
      failing = 0;
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
    props: viewProps,
    stop: () => server.stop(true),
  };
};
