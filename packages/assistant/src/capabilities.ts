import { searchAssistant } from "./search";
import { defineCapabilities, UniversalSearchInputSchema, UniversalSearchDataSchema } from "@k2b/cloud/contracts";
import { ChatComposeInputSchema } from "./commands";
export const assistantCapabilities = defineCapabilities({
  protocolVersion: 2,
  types: {
    chat: { title: "Chat", description: "An Assistant conversation owned by the current user.", icon: "ti ti-messages" },
    message: { title: "Chat message", description: "A message in an accessible Assistant chat.", icon: "ti ti-message" },
  },
  queries: {
    "chat.search": {
      title: "Search chats",
      description: "Find your Assistant chats by title or message content. With an assistant.chat scope, find messages in that chat.",
      input: UniversalSearchInputSchema,
      data: UniversalSearchDataSchema,
      openWorld: false,
      universalSearch: {
        tags: [{ tag: "chat", title: "Chats", description: "Search Assistant chat titles and messages.", aliases: ["chats", "assistant"] }],
        scopeTypes: ["chat"],
      },
      run: async (input, context) => searchAssistant(input, context, (await import("@k2b/cloud/ai")).aiConversations),
    },
  },
  commands: {
    "chat.compose": {
      title: "New chat",
      description: "Start a conversation with the Assistant.",
      icon: "ti ti-sparkles",
      input: ChatComposeInputSchema,
      path: "/app/assistant",
    },
  },
  presentation: {
    baseLocale: "en",
    translations: {
      de: {
        queries: {
          "chat.search": {
            title: "Chats durchsuchen",
            description:
              "Eigene Assistant-Chats anhand von Titel und Nachrichteninhalt finden. Im Chat-Kontext werden dessen Nachrichten durchsucht.",
            searchTags: { chat: { title: "Chats", description: "Titel und Nachrichten in Assistant-Chats durchsuchen." } },
          },
        },
        commands: { "chat.compose": { title: "Neuer Chat", description: "Eine Unterhaltung mit dem Assistenten beginnen." } },
      },
    },
  },
});
