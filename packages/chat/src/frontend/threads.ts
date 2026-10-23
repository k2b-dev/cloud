import type { z } from "zod";
import type { chatMessages } from "../messages";
import {
  type ConversationSchema,
  type MessageSchema,
  type ReadStateSchema,
  readStart,
  type ThreadListSchema,
  type ThreadSchema,
} from "../service/contracts";

type Conversation = z.infer<typeof ConversationSchema>;
type Message = z.infer<typeof MessageSchema>;
type Messages = ReturnType<typeof chatMessages.resolve>["t"];
export type ThreadList = z.infer<typeof ThreadListSchema>;
export type Thread = z.infer<typeof ThreadSchema>;

/**
 * Which part of a chat is open: "all" is the mixed timeline of every thread, "general" the fixed strand "General", and
 * any other value a thread's ID. A chat without threads only has its history, which is "all" and "general" at once.
 */
export type ThreadView = "all" | "general" | (string & {});

export const chatHasThreads = (conversation: (Pick<Conversation, "threads"> & Partial<Pick<Conversation, "channel">>) | null | undefined) =>
  !conversation?.channel && (conversation?.threads ?? 0) > 0;

/** The address of a view; the chat's own address is "All threads". */
export const threadHref = (chatId: string, view: ThreadView, message?: string | null, basePath = "/app/chat") =>
  `${basePath}/c/${encodeURIComponent(chatId)}${view === "all" ? "" : `/t/${encodeURIComponent(view)}`}${message ? `/m/${encodeURIComponent(message)}` : ""}`;

/** The thread a message belongs to, as a view: its ID, or "general". */
export const messageThread = (message: Pick<Message, "thread">): ThreadView => message.thread ?? "general";

export const inView = (view: ThreadView, message: Pick<Message, "thread">) => view === "all" || messageThread(message) === view;

export const threadOf = (list: ThreadList | null, id: string | null | undefined) =>
  id ? (list?.items.find((thread) => thread.id === id) ?? null) : null;

export const viewName = (view: ThreadView, list: ThreadList | null, t: Messages) =>
  view === "all" ? t.allThreads : view === "general" ? t.general : (threadOf(list, view)?.name ?? "");

/** Active threads by last activity, as the server orders them, and the archived ones apart. */
export const activeThreads = (list: ThreadList | null) => list?.items.filter((thread) => !thread.archived) ?? [];
export const archivedThreads = (list: ThreadList | null) => list?.items.filter((thread) => thread.archived) ?? [];

/**
 * Where reading starts in a thread: the chat's read state for "General", the thread's own read state for a thread, with
 * the reader's join position when they never read it. Null without a read state: then nothing counts as unread.
 */
export const threadReadStart = (
  read: z.infer<typeof ReadStateSchema> | null,
  list: ThreadList | null,
  thread: string | null,
): number | null => {
  if (read === null) return null;
  if (thread === null) return readStart(read);
  const own = threadOf(list, thread)?.read ?? null;
  return readStart({ lastReadSeq: own?.lastReadSeq ?? null, unreadFromSeq: own?.unreadFromSeq ?? null, joinedSeq: read.joinedSeq });
};

/** Whether a message from someone else lies after where the reader stopped in its own thread. */
export const isUnread = (
  message: Pick<Message, "seq" | "kind" | "thread" | "author">,
  viewerId: string,
  read: z.infer<typeof ReadStateSchema> | null,
  list: ThreadList | null,
) => {
  if (message.kind !== "text" || message.author.id === viewerId) return false;
  const start = threadReadStart(read, list, message.thread);
  return start !== null && message.seq > start;
};

/** Unread count of a view: "all" sums General and every thread, as the chat's own count does. */
export const viewUnread = (view: ThreadView, conversation: Pick<Conversation, "unread"> | null, list: ThreadList | null) =>
  view === "all" ? (conversation?.unread ?? 0) : view === "general" ? (list?.general.unread ?? 0) : (threadOf(list, view)?.unread ?? 0);

/** Where the read reporter starts for a view: the earliest position among the threads it shows. */
export const viewReadStart = (view: ThreadView, read: z.infer<typeof ReadStateSchema> | null, list: ThreadList | null) => {
  if (read === null) return null;
  if (view === "general") return threadReadStart(read, list, null);
  if (view !== "all") return threadReadStart(read, list, view);
  const starts = [threadReadStart(read, list, null), ...(list?.items ?? []).map((thread) => threadReadStart(read, list, thread.id))];
  return Math.min(...starts.filter((start): start is number => start !== null));
};
