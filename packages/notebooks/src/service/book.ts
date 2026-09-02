import { renderNotebookBook } from "../lib/book-renderer";
import { parseNotebookQueryBlocks } from "../lib/query-blocks";
import { resolveNoteQuery, type NoteQueryResult } from "./note-query";
import * as notebooks from "./notebooks";
import * as notes from "./notes";

/** The same authorized server document is used for direct Book loads and future previews. */
export const loadBookNote = async (params: {
  notebookId: string;
  notebookShortId: string;
  noteShortId: string;
  userId: string;
  locale: string;
}) => {
  if (!(await notebooks.canAccess({ notebookId: params.notebookId, userId: params.userId, requiredLevel: "read" }))) return null;
  const note = await notes.getWithContentByShortId({ shortId: params.noteShortId });
  if (!note || note.notebookId !== params.notebookId) return null;
  const markdown = note.contentMd ?? "";
  const queries = parseNotebookQueryBlocks(markdown).blocks;
  const queryResults = new Map<number, NoteQueryResult>();
  // The parser bounds blocks and each resolver bounds rows. Avoid database fan-out.
  for (const query of queries) {
    queryResults.set(
      query.line,
      await resolveNoteQuery({
        notebookId: params.notebookId,
        noteId: note.id,
        userId: params.userId,
        query,
      }),
    );
  }
  const document = await renderNotebookBook({ markdown, notebookId: params.notebookShortId, locale: params.locale, queryResults });
  // Do not return a collaboration snapshot or raw notebook data to the Book surface.
  return { note, document };
};
