import { artifactMessages } from "../artifacts/messages";
import type { GlobalSearchOptions } from "@k2b/cloud/browser/search";
import type { AiConversation } from "@k2b/cloud/ai";
import { assistantCommandMessages } from "../commands";
import { assistantMessages } from "./messages";

export const assistantSearchOptions = (locale: string, chat?: Pick<AiConversation, "id" | "title">): GlobalSearchOptions => ({
  query: "",
  scope: chat
    ? { ref: { type: "assistant.chat", id: chat.id }, label: chat.title, icon: "ti ti-message" }
    : { appId: "assistant", tag: "chat", label: assistantCommandMessages.resolve([locale]).t.chats, icon: "ti ti-messages" },
});

/** Find accessible projects by name and description. */
export const assistantProjectsSearchOptions = (locale: string): GlobalSearchOptions => ({
  query: "",
  scope: { appId: "assistant", tag: "assistant-project", label: assistantMessages.resolve([locale]).t.projects, icon: "ti ti-folders" },
});

export const assistantAppsSearchOptions = (locale: string): GlobalSearchOptions => ({
  query: "",
  scope: { appId: "assistant", tag: "studio-app", label: artifactMessages.resolve([locale]).t.apps, icon: "ti ti-app-window" },
});
