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
      replyDescription: ({ subject }: { subject: string }) => `Reply to the sender of “${subject}”.`,
      replyAllDescription: ({ subject }: { subject: string }) => `Reply to everyone in “${subject}”.`,
      forwardDescription: ({ subject }: { subject: string }) => `Forward “${subject}” to another recipient.`,
      assignTitle: "Change assignee",
      assignDescription: ({ subject }: { subject: string }) => `Choose who handles “${subject}”.`,
      reminderTitle: "Remind me about this conversation",
      reminderDescription: ({ subject }: { subject: string }) => `Choose when to be reminded about “${subject}”.`,
      composeTitle: "New email",
      composeDescription: ({ name }: { name: string }) => `Write an email from “${name}”. Nothing is sent yet.`,
      searchTitle: "Search this mailbox",
      searchDescription: ({ name }: { name: string }) => `Find messages and attachments in “${name}”.`,
      mail: "Mail",
      recipient: "Which email address?",
      unavailable: "This contact is unavailable or has no email address.",
      sourceTask: "Create a task from this conversation",
      sourceEvent: "Create an event from this conversation",
      sourceDescription: "Opens Spaces with this email conversation linked.",
    },
    de: {
      replyDescription: ({ subject }) => `Dem Absender von „${subject}“ antworten.`,
      replyAllDescription: ({ subject }) => `Allen Beteiligten von „${subject}“ antworten.`,
      forwardDescription: ({ subject }) => `„${subject}“ an einen anderen Empfänger weiterleiten.`,
      assignTitle: "Zuständigkeit ändern",
      assignDescription: ({ subject }) => `Auswählen, wer „${subject}“ bearbeitet.`,
      reminderTitle: "An diese Konversation erinnern",
      reminderDescription: ({ subject }) => `Eine persönliche Erinnerung für „${subject}“ setzen.`,
      composeTitle: "Neue E-Mail",
      composeDescription: ({ name }) => `Eine E-Mail von „${name}“ verfassen. Es wird noch nichts gesendet.`,
      searchTitle: "Dieses Postfach durchsuchen",
      searchDescription: ({ name }) => `Nachrichten und Anhänge in „${name}“ finden.`,
      mail: "Mail",
      recipient: "Welche E-Mail-Adresse?",
      unavailable: "Dieser Kontakt ist nicht verfügbar oder hat keine E-Mail-Adresse.",
      sourceTask: "Aufgabe aus dieser Konversation erstellen",
      sourceEvent: "Termin aus dieser Konversation erstellen",
      sourceDescription: "Öffnet Spaces mit dieser E-Mail-Konversation als Verknüpfung.",
    },
  },
});
