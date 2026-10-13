import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerWebSocket } from "bun";
import type { z } from "zod";
import {
  type ConversationSchema,
  type MessageViewSchema,
  MarkUnreadSchema,
  ReadSchema,
  ReadAllSchema,
  READ_ALL_BATCH,
  READ_ALL_CONFIRM_FROM,
  readStart,
  UNREAD_CAP,
  SendMessageSchema,
} from "../service/contracts";
import type { ChatWorkspaceProps } from "./ChatWorkspace.island";

type Conversation = z.infer<typeof ConversationSchema>;
type Message = z.infer<typeof MessageViewSchema>;
type Person = { id: string; name: string };
type Chat = { conversation: Conversation; messages: Message[] };
type Subscription = { socket: ServerWebSocket<unknown>; id: string; channel: string; scope: { conversation?: string } };

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
export const startChatHarness = async () => {
  const [harness, css, fontAssets] = await Promise.all([
    buildHarness(),
    Promise.all([
      buildCss(resolve(import.meta.dir, "../../../../styles.css")),
      buildCss(resolve(import.meta.dir, "../styles/app.css")),
    ]).then((parts) => parts.join("\n")),
    fonts(),
  ]);
  const chats = new Map<string, Chat>();
  const subscriptions: Subscription[] = [];
  const events: { cursor: number; channel: string; chat: string; data: unknown }[] = [];
  let cursor = 0;
  let nextChat = 0;
  let failing = 0;
  const reads: { chat: string; seq: number }[] = [];
  const posted: { chat: string; clientId: string; body: string }[] = [];

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

  /** A chat with `count` messages, alternating between the viewer and the others, one every `spacing` minutes. */
  const addChat = (options: {
    members: Person[];
    name?: string;
    count: number;
    end: Date;
    spacing?: number;
    permission?: "read" | "write";
    unread?: number;
  }) => {
    const id = chatId(++nextChat);
    const others = options.members.filter((member) => member.id !== viewer.id);
    const title = options.name ?? (others.length === 1 ? others[0]!.name : others.map((member) => member.name.split(" ")[0]).join(", "));
    const spacing = (options.spacing ?? 3) * 60_000;
    const start = new Date(options.end.getTime() - options.count * spacing);
    chats.set(id, {
      conversation: {
        id,
        name: options.name ?? null,
        icon: null,
        purpose: null,
        title,
        memberCount: options.members.length,
        unread: 0,
        read: { lastReadSeq: null, unreadFromSeq: null, joinedSeq: 0 },
        withGuests: false,
        peerDeactivated: false,
        rev: 0,
        permission: options.permission ?? "write",
        createdAt: start.toISOString(),
        lastActivityAt: start.toISOString(),
        lastMessage: null,
      },
      messages: [],
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
  const list = () => ({
    items: [...chats.values()].map((chat) => chat.conversation).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)),
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
      if (url.pathname === "/api/chat/conversations") return Response.json(list());
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
      const match = /^\/api\/chat\/conversations\/([^/]+)(?:\/([a-z]+))?$/.exec(url.pathname);
      if (match) {
        const [, id, part] = match;
        const chat = chats.get(id!);
        if (!chat) return Response.json({ code: "NOT_FOUND", message: "Chat not found." }, { status: 404 });
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
          const message = append(id!, viewer, input.body, new Date());
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
        const frame = JSON.parse(String(raw)) as {
          t: string;
          id: string;
          channel: string;
          scope: { conversation?: string };
          after?: string;
        };
        if (frame.t === "sub") {
          subscriptions.push({ socket, id: frame.id, channel: frame.channel, scope: frame.scope ?? {} });
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
    addChat,
    posted,
    reads,
    /** Advances the viewer's read state on another device, without recording a page report. */
    readElsewhere: read,
    /** Isolates scenarios; IDs stay unique so a closing page cannot report against a later chat. */
    reset: () => {
      chats.clear();
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
    receive: (chat: string, author: Person, body: string) => publish(append(chat, author, body, new Date())),
    /** Renames a chat and announces it live with a system message, as a details change does. */
    rename: (chat: string, title: string) => {
      const entry = chats.get(chat)!;
      entry.conversation = { ...entry.conversation, name: title, title };
      publish(append(chat, viewer, "", new Date(), "system"));
    },
    /** Announces a system message and then answers 404 for the chat, as removing the reader does. */
    revoke: (chat: string) => {
      publish(append(chat, nora, "", new Date(), "system"));
      chats.delete(chat);
    },
    messageId,
    /** The island's props for an address, as the server renders them. */
    props: (address: { chat?: string; message?: string }, now: Date): ChatWorkspaceProps => {
      const open = address.chat ? snapshot(address.chat, address.message ?? null) : null;
      return {
        cursor: `c.${cursor}`,
        sidebar: list(),
        open: open && { conversation: open.conversation, page: open.page, focus: open.focus },
        chatId: address.chat ?? null,
        viewerId: viewer.id,
        dateConfig: { locale: "en", timeZone: "Europe/Berlin", firstDayOfWeek: 1 },
        now: now.toISOString(),
      };
    },
    stop: () => server.stop(true),
  };
};
