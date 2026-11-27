import type { AiConversation } from "@k2b/cloud/ai";

import { lazyAction } from "./lazy-action";

/**
 * The Assistant's rare dialogs load when someone opens them, so they stay out of the chat's first frame: the chat's
 * settings, the list of every chat and Personalize. Every caller opens them through here; a static import of their
 * modules would pull them back into the island.
 */
const editor = lazyAction(() => import("./AssistantConversationEditor"));
const allChats = lazyAction(() => import("./AssistantAllChatsDialog"));
const prefs = lazyAction(() => import("./AssistantPrefsModals"));

const pageLocale = () => (typeof document === "undefined" ? "en" : document.documentElement.lang || "en");

type EditorModule = typeof import("./AssistantConversationEditor");
type AllChatsModule = typeof import("./AssistantAllChatsDialog");
type PrefsModule = typeof import("./AssistantPrefsModals");

export const openAssistantConversationEditor = (
  conversation: AiConversation,
  options?: Parameters<EditorModule["openAssistantConversationEditor"]>[1],
) => editor(pageLocale(), (module) => module.openAssistantConversationEditor(conversation, options));

export const openAssistantAllChatsDialog = (
  ...args: Parameters<AllChatsModule["openAssistantAllChatsDialog"]>
): Promise<void | undefined> => allChats(pageLocale(), (module) => module.openAssistantAllChatsDialog(...args));

export const openAssistantPrefsModal = (...args: Parameters<PrefsModule["openAssistantPrefsModal"]>) =>
  prefs(pageLocale(), (module) => module.openAssistantPrefsModal(...args));
