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
export const spaceCommandMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      task: "New task",
      taskDescription: "Create a task in Spaces.",
      event: "New event",
      eventDescription: "Create an event in Spaces.",
      chooseSpace: "Where should it go?",
      findSpace: "Find a writable Space…",
      noSpaces: "No writable Spaces found.",
      linkedSource: "Linked source",
      removeSource: ({ title }: { title: string }) => `Remove link to ${title}`,
      sourceUnavailable: "The linked source is unavailable. Please open it again and retry.",
      failed: "Could not open the form. Try again.",
      edit: ({ title }: { title: string }) => `Edit “${title}”`,
      complete: ({ title }: { title: string }) => `Mark “${title}” as done`,
      currentItem: "The item currently open in Spaces.",
    },
    de: {
      task: "Neue Aufgabe",
      taskDescription: "Eine Aufgabe in Spaces erstellen.",
      event: "Neuer Termin",
      eventDescription: "Einen Termin in Spaces erstellen.",
      chooseSpace: "In welchem Space?",
      findSpace: "Beschreibbaren Space finden…",
      noSpaces: "Keine beschreibbaren Spaces gefunden.",
      linkedSource: "Verknüpfte Quelle",
      removeSource: ({ title }) => `Verknüpfung zu ${title} entfernen`,
      sourceUnavailable: "Die verknüpfte Quelle ist nicht verfügbar. Öffne sie erneut und versuche es noch einmal.",
      failed: "Das Formular konnte nicht geöffnet werden. Versuche es erneut.",
      edit: ({ title }) => `„${title}“ bearbeiten`,
      complete: ({ title }) => `„${title}“ als erledigt markieren`,
      currentItem: "Das gerade geöffnete Element in Spaces.",
    },
  },
});
