import { createNoteCommands } from "../../note-commands";

/**
 * Owns "New note" while a notebook is read as a book, where NotebookCommands is not mounted. Notebooks opens the
 * notebook used last, so a "New note" link from another app arrives on whatever that notebook shows. Reading takes no
 * notebook for granted: without a named one it asks, so a book that others read gets no empty note unasked.
 */
export default function NoteComposeCommand() {
  createNoteCommands();
  return null;
}
