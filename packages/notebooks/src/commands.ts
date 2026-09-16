import { i18n } from "@k2b/stdlib";
import { z } from "zod";
export const NoteComposeInputSchema = z
  .object({
    notebookId: z.string().min(1).max(100).optional().describe("Notebook to create the note in; otherwise choose a writable notebook."),
  })
  .strict();
export const notebookCommandMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      markdownDescription: ({ title }: { title: string }) => `Download “${title}” as an editable Markdown file.`,
      pdfDescription: ({ title }: { title: string }) => `Choose PDF export settings for “${title}”.`,
      aiDescription: ({ title }: { title: string }) => `Open Assistant with “${title}” as context for your changes.`,
      newNote: "New note",
      choose: "Choose a notebook",
      search: "Find a writable notebook…",
      empty: "No writable notebooks",
      failed: "The note could not be created.",
    },
    de: {
      markdownDescription: ({ title }) => `„${title}“ als bearbeitbare Markdown-Datei herunterladen.`,
      pdfDescription: ({ title }) => `Den PDF-Export für „${title}“ vorbereiten.`,
      aiDescription: ({ title }) => `Den Assistenten mit „${title}“ als Kontext für deine Änderungen öffnen.`,
      newNote: "Neue Notiz",
      choose: "Notizbuch auswählen",
      search: "Beschreibbares Notizbuch finden…",
      empty: "Keine beschreibbaren Notizbücher",
      failed: "Die Notiz konnte nicht erstellt werden.",
    },
  },
});
