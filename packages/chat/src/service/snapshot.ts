import type { ChatRequestContext } from "../request-context";
import { ShortIdSchema } from "./contracts";
import { conversations } from "./conversations";
import { chatLive } from "./live";
import { messages } from "./messages";
import { INITIAL_MESSAGE_PAGE_SIZE } from "./snapshot-budget";

export const loadChatView = async (
  context: ChatRequestContext,
  input: { conversationId?: string; messageId?: string; thread?: string; archived?: boolean; unread?: boolean },
) => {
  const cursor = await chatLive.cursor();
  const sidebar = await conversations.list({
    ...context,
    query: { archived: input.archived ? "true" : "false", unread: input.unread ? "true" : "false" },
  });
  if (!sidebar.ok) throw new Error(sidebar.error.message);
  const base = { cursor, sidebar: sidebar.data };
  if (input.conversationId === undefined) return { ...base, open: null, noAccess: false };
  if (!ShortIdSchema.safeParse(input.conversationId).success) return { ...base, open: null, noAccess: true };
  // "All threads" is the whole chat; an unknown thread shows like a chat the reader may not see.
  const thread = input.thread === undefined || input.thread === "all" ? undefined : input.thread;
  const snapshot = await messages.snapshot({
    ...context,
    conversationId: input.conversationId,
    messageId: input.messageId,
    thread,
    initialPageSize: INITIAL_MESSAGE_PAGE_SIZE,
  });
  if (snapshot.ok) {
    // The island re-renders structured system events in its request locale. Sending the
    // API's localized copy as well repeats text that neither first render consumes.
    const page = { ...snapshot.data.page, items: snapshot.data.page.items.map(({ systemText: _, ...message }) => message) };
    return { ...base, open: { ...snapshot.data, page }, noAccess: false };
  }
  if (snapshot.error.code === "NOT_FOUND" || snapshot.error.code === "FORBIDDEN") return { ...base, open: null, noAccess: true };
  throw new Error(snapshot.error.message);
};
