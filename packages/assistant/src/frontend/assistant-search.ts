import type { AiConversation, AiProject } from "@k2b/cloud/ai";
import type { GlobalSearchOptions } from "@k2b/cloud/browser/search";
import { artifactMessages } from "../artifacts/messages";
import { assistantCommandMessages } from "../commands";
import { assistantMessages } from "./messages";

export const assistantSearchOptions = (locale: string, chat?: Pick<AiConversation, "id" | "title">): GlobalSearchOptions => ({
  query: "",
  scope: chat
    ? { ref: { type: "assistant.chat", id: chat.id }, label: chat.title, icon: "ti ti-message" }
    : { appId: "assistant", tag: "chat", label: assistantCommandMessages.resolve([locale]).t.chats, icon: "ti ti-messages" },
});

export const assistantProjectSearchOptions = (project: Pick<AiProject, "id" | "name" | "icon">): GlobalSearchOptions => ({
  query: "",
  scope: { ref: { type: "assistant.project", id: project.id }, label: project.name, icon: project.icon || "ti ti-folders" },
});

/** Find projects themselves; the singular helper searches chats inside one project. */
export const assistantProjectsSearchOptions = (locale: string): GlobalSearchOptions => ({
  query: "",
  scope: { appId: "assistant", tag: "assistant-project", label: assistantMessages.resolve([locale]).t.projects, icon: "ti ti-folders" },
});

export const assistantAppsSearchOptions = (locale: string): GlobalSearchOptions => ({
  query: "",
  scope: { appId: "assistant", tag: "studio-app", label: artifactMessages.resolve([locale]).t.apps, icon: "ti ti-app-window" },
});
