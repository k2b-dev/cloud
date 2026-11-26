import { createNoteCommands } from "../../note-commands";

/**
 * Owns "New note" while a notebook is read as a book, where NotebookCommands is not mounted. Notebooks opens the
 * notebook used last, so a "New note" link from another app arrives on whatever that notebook shows.
 */
export default function NoteComposeCommand(props: { notebookId: string; canWrite: boolean }) {
  createNoteCommands(() => (props.canWrite ? props.notebookId : undefined));
  return null;
}
