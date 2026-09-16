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
      newNote: "New note",
      choose: "Choose a notebook",
      search: "Find a writable notebook…",
      empty: "No writable notebooks",
      failed: "The note could not be created.",
    },
    de: {
      newNote: "Neue Notiz",
      choose: "Notizbuch auswählen",
      search: "Beschreibbares Notizbuch finden…",
      empty: "Keine beschreibbaren Notizbücher",
      failed: "Die Notiz konnte nicht erstellt werden.",
    },
  },
});
