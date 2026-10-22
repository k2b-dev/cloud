import type { ChatContext } from "./access";
import { ShortIdSchema } from "./contracts";
import { conversations } from "./conversations";
import { chatLive } from "./live";
import { messages } from "./messages";

export const loadChatView = async (context: ChatContext, input: { conversationId?: string; messageId?: string; archived?: boolean }) => {
  const cursor = await chatLive.cursor();
  const sidebar = await conversations.list(input.archived ? { ...context, query: { archived: "true" } } : context);
  if (!sidebar.ok) throw new Error(sidebar.error.message);
  const base = { cursor, sidebar: sidebar.data };
  if (input.conversationId === undefined) return { ...base, open: null, noAccess: false };
  if (!ShortIdSchema.safeParse(input.conversationId).success) return { ...base, open: null, noAccess: true };
  const snapshot = await messages.snapshot({ ...context, conversationId: input.conversationId, messageId: input.messageId });
  if (snapshot.ok) return { ...base, open: snapshot.data, noAccess: false };
  if (snapshot.error.code === "NOT_FOUND" || snapshot.error.code === "FORBIDDEN") return { ...base, open: null, noAccess: true };
  throw new Error(snapshot.error.message);
};
