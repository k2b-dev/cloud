import { i18n } from "@k2b/stdlib";
import { z } from "zod";
export const ChatComposeInputSchema = z
  .object({ projectId: z.string().min(1).max(100).optional().describe("Project for the new chat; omit for a chat without a project.") })
  .strict();
export const assistantCommandMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      chats: "Chats",
      chat: "Chat",
      message: "Message",
      newChatDescription: "Start a conversation with the Assistant.",
      newProjectChatDescription: ({ name }: { name: string }) => `Start a conversation in “${name}” using its project context.`,
      searchChatsDescription: "Find titles and messages in your Assistant chats.",
      searchChatDescription: ({ title }: { title: string }) => `Find messages in “${title}”.`,
      userRequired: "Chat search requires a user account.",
      invalidSearchScope: "This search context is not supported.",
      messageUnavailable: "This message is no longer available in the chat.",
      doneDescription: ({ title }: { title: string }) => `Move “${title}” out of your active chats.`,
      reopenDescription: ({ title }: { title: string }) => `Return “${title}” to your active chats.`,
      done: "Mark chat as done",
      reopen: "Reopen chat",
      unavailable: "This project is no longer available.",
      failed: "The chat could not be created.",
    },
    de: {
      chats: "Chats",
      chat: "Chat",
      message: "Nachricht",
      newChatDescription: "Eine Unterhaltung mit dem Assistenten beginnen.",
      newProjectChatDescription: ({ name }) => `Eine Unterhaltung in „${name}“ mit dessen Projektkontext beginnen.`,
      searchChatsDescription: "Titel und Nachrichten in deinen Assistant-Chats finden.",
      searchChatDescription: ({ title }) => `Nachrichten in „${title}“ finden.`,
      userRequired: "Die Chatsuche benötigt ein Benutzerkonto.",
      invalidSearchScope: "Dieser Suchkontext wird nicht unterstützt.",
      messageUnavailable: "Diese Nachricht ist im Chat nicht mehr verfügbar.",
      doneDescription: ({ title }) => `„${title}“ aus den aktiven Chats entfernen.`,
      reopenDescription: ({ title }) => `„${title}“ wieder in den aktiven Chats anzeigen.`,
      done: "Chat als erledigt markieren",
      reopen: "Chat wieder öffnen",
      unavailable: "Dieses Projekt ist nicht mehr verfügbar.",
      failed: "Der Chat konnte nicht erstellt werden.",
    },
  },
});
