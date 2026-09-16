import type { AiConversationService, AiStoredMessage } from "@k2b/cloud/ai";
import type { CapabilityExecutionContext, CloudResourceView, UniversalSearchInput } from "@k2b/cloud/contracts";
import { err, fail, ok } from "@k2b/stdlib";
import { assistantCommandMessages } from "./commands";

type SearchStore = Pick<AiConversationService, "listConversations" | "getConversationByShortId" | "searchConversationMessages">;
const textOf = (message: AiStoredMessage): string =>
  message.message.role === "tool_result"
    ? ""
    : message.message.content
        .flatMap((part) => (typeof part === "string" ? [part] : part.type === "text" ? [part.text] : []))
        .join(" ")
        .replace(/\s+/gu, " ")
        .trim();

/** Both projections reuse the existing owner-scoped Assistant search service. */
export const searchAssistant = async (
  input: UniversalSearchInput,
  context: Pick<CapabilityExecutionContext, "accessSubject" | "locale">,
  store: SearchStore,
) => {
  const t = assistantCommandMessages.resolve([context.locale]).t;
  if (context.accessSubject.type !== "user") return fail(err.forbidden(t.userRequired));
  const ownerUserId = context.accessSubject.userId;
  if (input.scope) {
    if (input.scope.type !== "assistant.chat") return fail(err.badInput(t.invalidSearchScope));
    const chat = await store.getConversationByShortId({ shortId: input.scope.id, ownerUserId });
    if (!chat || chat.createdByUserId !== ownerUserId) return fail(err.notFound(t.chat));
    const page = await store.searchConversationMessages({ conversationId: chat.id, query: input.query, limit: input.limit });
    const data: CloudResourceView[] = page.messages.slice(0, input.limit).map((message) => ({
      ref: { type: "assistant.message", id: message.shortId },
      title: (textOf(message) || t.message).slice(0, 500),
      preview: textOf(message).slice(0, 2000),
      icon: message.message.role === "user" ? "ti ti-user" : "ti ti-sparkles",
      priority: 8,
      metadata: [{ label: t.chat, value: chat.title }],
      links: [{ rel: "open", href: `/app/assistant?conversation=${encodeURIComponent(chat.shortId)}&message=${message.seq}` }],
    }));
    return ok({ data });
  }
  const chats = await store.listConversations({ ownerUserId, search: input.query, limit: input.limit });
  const data: CloudResourceView[] = chats.map((chat) => ({
    ref: { type: "assistant.chat", id: chat.shortId },
    title: chat.title.slice(0, 500),
    preview: (chat.description || "").slice(0, 2000),
    icon: "ti ti-messages",
    priority: 7,
    links: [{ rel: "open", href: `/app/assistant?conversation=${encodeURIComponent(chat.shortId)}` }],
  }));
  return ok({ data });
};
