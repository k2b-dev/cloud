import type { ChatRequestContext } from "../request-context";
import { ShortIdSchema } from "./contracts";
import { conversations } from "./conversations";
import { chatLive } from "./live";
import { messages } from "./messages";

export const loadChatView = async (
  context: ChatRequestContext,
  input: { conversationId?: string; messageId?: string; thread?: string },
) => {
  const cursor = await chatLive.cursor();
  const sidebar = await conversations.list(context);
  if (!sidebar.ok) throw new Error(sidebar.error.message);
  const base = { cursor, sidebar: sidebar.data };
  if (input.conversationId === undefined) return { ...base, open: null, noAccess: false };
  if (!ShortIdSchema.safeParse(input.conversationId).success) return { ...base, open: null, noAccess: true };
  // "All threads" is the whole chat; an unknown thread shows like a chat the reader may not see.
  const thread = input.thread === undefined || input.thread === "all" ? undefined : input.thread;
  const snapshot = await messages.snapshot({ ...context, conversationId: input.conversationId, messageId: input.messageId, thread });
  if (snapshot.ok) return { ...base, open: snapshot.data, noAccess: false };
  if (snapshot.error.code === "NOT_FOUND" || snapshot.error.code === "FORBIDDEN") return { ...base, open: null, noAccess: true };
  throw new Error(snapshot.error.message);
};
