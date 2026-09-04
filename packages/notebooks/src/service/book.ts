import { renderNotebookBook } from "../lib/book-renderer";
import { bookRendererMessages } from "../lib/book-renderer-messages";
import { parseNotebookQueryBlocks, parseNotebookTocBlocks } from "../lib/query-blocks";
import { type NoteQueryResult, resolveNoteQuery } from "./note-query";
import * as notebooks from "./notebooks";
import * as notes from "./notes";

/** The same authorized server document is used for direct Book loads and future previews. */
export const loadBookNote = async (params: {
  notebookId: string;
  notebookShortId: string;
  noteShortId: string;
  userId: string;
  locale: string;
  bypassAccess?: boolean;
}) => {
  if (!params.bypassAccess && !(await notebooks.canAccess({ notebookId: params.notebookId, userId: params.userId, requiredLevel: "read" })))
    return null;
  const note = await notes.getWithContentByShortId({ shortId: params.noteShortId });
  if (!note || note.notebookId !== params.notebookId) return null;
  const document = await renderBookDocument({ ...params, noteId: note.id, markdown: note.contentMd ?? "" });
  // Do not return a collaboration snapshot or raw notebook data to the Book surface.
  return { note, document };
};

const renderBookDocument = async (params: {
  notebookId: string;
  notebookShortId: string;
  noteId: string;
  userId: string;
  locale: string;
  markdown: string;
  linkMode?: "write" | "readonly";
  bypassAccess?: boolean;
}) => {
  const { markdown } = params;
  const queries = parseNotebookQueryBlocks(markdown).blocks;
  const queryResults = new Map<number, NoteQueryResult>();
  // The parser bounds blocks and each resolver bounds rows. Avoid database fan-out.
  for (const query of queries) {
    queryResults.set(
      query.line,
      await resolveNoteQuery({
        notebookId: params.notebookId,
        noteId: params.noteId,
        userId: params.userId,
        bypassAccess: params.bypassAccess,
        query,
      }),
    );
  }
  return renderNotebookBook({
    markdown,
    notebookId: params.notebookShortId,
    locale: params.locale,
    queryResults,
    linkMode: params.linkMode,
  });
};

/** Drafts are never persisted. Read-only callers can preview only the saved document. */
export const loadBookBlockPreview = async (params: {
  notebookId: string;
  notebookShortId: string;
  noteShortId: string;
  userId: string;
  locale: string;
  markdown?: string;
  bypassAccess?: boolean;
}) => {
  const requiredLevel = params.markdown === undefined ? "read" : "write";
  if (!params.bypassAccess && !(await notebooks.canAccess({ notebookId: params.notebookId, userId: params.userId, requiredLevel }))) {
    return { kind: "denied" as const };
  }
  const note = await notes.getWithContentByShortId({ shortId: params.noteShortId });
  if (!note || note.notebookId !== params.notebookId) return { kind: "not_found" as const };
  if (params.markdown !== undefined && note.lockedAt) return { kind: "denied" as const };
  const markdown = (params.markdown ?? note.contentMd ?? "").replace(/\r\n?/g, "\n");
  const document = await renderBookDocument({
    ...params,
    noteId: note.id,
    markdown,
    linkMode: params.markdown === undefined ? "readonly" : "write",
  });
  const t = bookRendererMessages.resolve([params.locale]).t;
  const diagnostics = [...parseNotebookQueryBlocks(markdown).diagnostics, ...parseNotebookTocBlocks(markdown).diagnostics].map(
    ({ line, code, path }) => ({ line, message: `${t.invalidBlock({ line })} ${path}: ${t[code]}` }),
  );
  return {
    kind: "ok" as const,
    preview: {
      markdown,
      blocks: document.blocks,
      headings: document.headings.flatMap(({ id, line }) => (line === undefined ? [] : [{ id, line }])),
      diagnostics,
    },
  };
};
