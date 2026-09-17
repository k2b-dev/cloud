import { CloudResourceRefSchema } from "@k2b/cloud/contracts";
import { i18n } from "@k2b/stdlib";
import { z } from "zod";
import { ResourceShortIdSchema } from "./contracts";

export const SpaceComposeInputSchema = z
  .object({
    spaceId: ResourceShortIdSchema.optional().describe("Optional destination Space; otherwise the user chooses."),
    source: CloudResourceRefSchema.optional().describe("Optional source resource to link visibly in the form."),
  })
  .strict();
export const SpaceInvitationInputSchema = z
  .object({
    itemId: ResourceShortIdSchema.describe("Public ID of the event whose invitation to prepare."),
    method: z
      .enum(["request", "cancel"])
      .default("request")
      .describe("Prepare an invitation/update or a cancellation; never send automatically."),
  })
  .strict();
export const spaceCommandMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      inviteDescription: ({ title }: { title: string }) => `Choose sender and recipients for “${title}”, then review the email in Mail.`,
      cancelDescription: ({ title }: { title: string }) => `Prepare a cancellation for “${title}”. Nothing is sent yet.`,
      invitationUnavailable: "This event or invitation is no longer available.",
      searchDescription: ({ name }: { name: string }) => `Find tasks and events in “${name}”.`,
      createDescription: ({ name }: { name: string }) => `Open the creation form in “${name}”.`,
      editDescription: "Change the title, description and other details.",
      completeDescription: "Remove this item from outstanding work. You can reopen it later.",
      reopenDescription: "Return this item to outstanding work.",
      assignDescription: ({ title }: { title: string }) => `Add yourself to the assignees of “${title}”.`,
      deadlineTitle: "Change due date",
      deadlineDescription: ({ title }: { title: string }) => `Set or remove the due date for “${title}”.`,
      task: "New task",
      taskDescription: "Create a task in Spaces.",
      event: "New event",
      eventDescription: "Create an event in Spaces.",
      chooseSpace: "Where should it go?",
      findSpace: "Find a writable Space…",
      noSpaces: "No writable Spaces found.",
      cannotCreate: "You cannot create items in this Space.",
      linkedSource: "Linked source",
      removeSource: ({ title }: { title: string }) => `Remove link to ${title}`,
      sourceUnavailable: "The linked source is unavailable. Please open it again and retry.",
      failed: "Could not open the form. Try again.",
      edit: ({ title }: { title: string }) => `Edit “${title}”`,
      complete: ({ title }: { title: string }) => `Mark “${title}” as done`,
    },
    de: {
      inviteDescription: ({ title }) => `Absender und Empfänger für „${title}“ wählen, dann die E-Mail in Mail prüfen.`,
      cancelDescription: ({ title }) => `Eine Absage für „${title}“ vorbereiten. Es wird noch nichts gesendet.`,
      invitationUnavailable: "Dieser Termin oder diese Einladung ist nicht mehr verfügbar.",
      searchDescription: ({ name }) => `Aufgaben und Termine in „${name}“ finden.`,
      createDescription: ({ name }) => `Das Formular zum Anlegen in „${name}“ öffnen.`,
      editDescription: "Titel, Beschreibung und weitere Details ändern.",
      completeDescription: "Diesen Eintrag abschließen. Du kannst ihn später wieder öffnen.",
      reopenDescription: "Diesen Eintrag wieder als offen anzeigen.",
      assignDescription: ({ title }) => `Dich bei „${title}“ als zuständig hinzufügen.`,
      deadlineTitle: "Fälligkeit ändern",
      deadlineDescription: ({ title }) => `Die Fälligkeit von „${title}“ setzen oder entfernen.`,
      task: "Neue Aufgabe",
      taskDescription: "Eine Aufgabe in Spaces erstellen.",
      event: "Neuer Termin",
      eventDescription: "Einen Termin in Spaces erstellen.",
      chooseSpace: "In welchem Space?",
      findSpace: "Beschreibbaren Space finden…",
      noSpaces: "Keine beschreibbaren Spaces gefunden.",
      cannotCreate: "In diesem Space kannst du keine Einträge anlegen.",
      linkedSource: "Verknüpfte Quelle",
      removeSource: ({ title }) => `Verknüpfung zu ${title} entfernen`,
      sourceUnavailable: "Die verknüpfte Quelle ist nicht verfügbar. Öffne sie erneut und versuche es noch einmal.",
      failed: "Das Formular konnte nicht geöffnet werden. Versuche es erneut.",
      edit: ({ title }) => `„${title}“ bearbeiten`,
      complete: ({ title }) => `„${title}“ als erledigt markieren`,
    },
  },
});
