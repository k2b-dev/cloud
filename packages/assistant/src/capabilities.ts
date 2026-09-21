import { defineCapabilities, UniversalSearchDataSchema, UniversalSearchInputSchema } from "@k2b/cloud/contracts";
import { ChatComposeInputSchema } from "./commands";
import { searchAssistant, searchAssistantApps, searchAssistantProjects } from "./search";
export const assistantCapabilities = defineCapabilities({
  protocolVersion: 2,
  types: {
    app: { title: "Studio app", description: "An accessible reusable Studio app.", icon: "ti ti-app-window" },
    project: { title: "Project", description: "An accessible Assistant project with shared context and chats.", icon: "ti ti-folders" },
    chat: { title: "Chat", description: "An Assistant conversation owned by the current user.", icon: "ti ti-messages" },
    message: { title: "Chat message", description: "A message in an accessible Assistant chat.", icon: "ti ti-message" },
  },
  queries: {
    "app.search": {
      title: "Search Studio apps",
      description: "Find accessible Studio apps by title or description.",
      input: UniversalSearchInputSchema,
      data: UniversalSearchDataSchema,
      openWorld: false,
      universalSearch: {
        tags: [
          { tag: "studio-app", title: "Studio apps", description: "Find accessible Studio apps.", aliases: ["studio-apps", "studio"] },
        ],
      },
      run: async (input, context) => {
        const { artifacts } = await import("./artifacts/service");
        return searchAssistantApps(input, context, artifacts);
      },
    },
    "project.search": {
      title: "Search projects",
      description: "Find accessible Assistant projects by name or description. Returns projects, not their chats.",
      input: UniversalSearchInputSchema,
      data: UniversalSearchDataSchema,
      openWorld: false,
      universalSearch: {
        tags: [
          {
            tag: "assistant-project",
            title: "Assistant projects",
            description: "Find accessible Assistant projects.",
            aliases: ["assistant-projects"],
          },
        ],
      },
      run: async (input, context) => {
        const { aiProjects } = await import("@k2b/cloud/ai");
        return searchAssistantProjects(input, context, aiProjects);
      },
    },
    "chat.search": {
      title: "Search chats",
      description: "Find your Assistant chats by title or message content. With an assistant.chat scope, find messages in that chat.",
      input: UniversalSearchInputSchema,
      data: UniversalSearchDataSchema,
      openWorld: false,
      universalSearch: {
        tags: [{ tag: "chat", title: "Chats", description: "Search Assistant chat titles and messages.", aliases: ["chats", "assistant"] }],
        scopeTypes: ["chat", "project"],
      },
      run: async (input, context) => {
        const { aiConversations, aiProjects } = await import("@k2b/cloud/ai");
        return searchAssistant(input, context, aiConversations, aiProjects);
      },
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
          "app.search": {
            title: "Studio-Apps durchsuchen",
            description: "Zugängliche Studio-Apps nach Titel oder Beschreibung finden.",
            searchTags: { "studio-app": { title: "Studio-Apps", description: "Zugängliche Studio-Apps finden." } },
          },
          "project.search": {
            title: "Projekte durchsuchen",
            description: "Zugängliche Assistant-Projekte nach Name oder Beschreibung finden. Liefert Projekte, nicht deren Chats.",
            searchTags: { "assistant-project": { title: "Assistant-Projekte", description: "Zugängliche Assistant-Projekte finden." } },
          },
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
