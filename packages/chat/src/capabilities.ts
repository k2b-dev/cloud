import { defineCapabilities } from "@k2b/cloud";
import { ChatComposeInputSchema } from "./commands";

export const chatCapabilities = defineCapabilities({
  protocolVersion: 2,
  commands: {
    "conversation.compose": {
      title: "Message a person",
      description: "Select a person in New chat. Choose an existing chat or start another; opening this form creates and sends nothing.",
      icon: "ti ti-message-plus",
      input: ChatComposeInputSchema,
      path: "/app/chat",
    },
  },
  presentation: {
    baseLocale: "en",
    translations: {
      de: {
        commands: {
          "conversation.compose": {
            title: "Nachricht an eine Person",
            description:
              "Wählt eine Person in Neuer Chat aus. Wähle einen vorhandenen Chat oder starte einen weiteren; das Öffnen erstellt und sendet nichts.",
            input: { userId: "Benutzer-UUID der auszuwählenden Person; Chat prüft aktuelle Verfügbarkeit und Gastbeschränkungen." },
          },
        },
      },
    },
  },
});
