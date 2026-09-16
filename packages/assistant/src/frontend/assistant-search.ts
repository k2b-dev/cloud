import type { GlobalSearchOptions } from "@k2b/cloud/browser/search";
import type { AiConversation } from "@k2b/cloud/ai";
import { assistantCommandMessages } from "../commands";

export const assistantSearchOptions = (locale: string, chat?: Pick<AiConversation, "id" | "title">): GlobalSearchOptions => ({
  query: "",
  scope: chat
    ? { ref: { type: "assistant.chat", id: chat.id }, label: chat.title, icon: "ti ti-message" }
    : { appId: "assistant", label: assistantCommandMessages.resolve([locale]).t.chats, icon: "ti ti-sparkles" },
});
