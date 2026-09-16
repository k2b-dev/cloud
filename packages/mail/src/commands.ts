import { i18n } from "@k2b/stdlib";
import { z } from "zod";

export const MailComposeCommandInputSchema = z
  .object({
    contact: z
      .object({
        type: z.literal("contacts.contact").describe("Contact resource type."),
        id: z.string().min(1).max(100).describe("Public contact ID."),
      })
      .strict()
      .optional()
      .describe("Optional contact to read and choose a recipient from."),
  })
  .strict();
export const mailCommandMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      recipient: "Which email address?",
      unavailable: "This contact is unavailable or has no email address.",
      sourceTask: "Create a task from this conversation",
      sourceEvent: "Create an event from this conversation",
      sourceDescription: "Opens Spaces with this email conversation linked.",
    },
    de: {
      recipient: "Welche E-Mail-Adresse?",
      unavailable: "Dieser Kontakt ist nicht verfügbar oder hat keine E-Mail-Adresse.",
      sourceTask: "Aufgabe aus dieser Konversation erstellen",
      sourceEvent: "Termin aus dieser Konversation erstellen",
      sourceDescription: "Öffnet Spaces mit dieser E-Mail-Konversation als Verknüpfung.",
    },
  },
});
