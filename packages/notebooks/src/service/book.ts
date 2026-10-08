import { type BookReferences, renderNotebookBook } from "../lib/book-renderer";
import { bookRendererMessages } from "../lib/book-renderer-messages";
import { parseNotebookQueryBlocks, parseNotebookTocBlocks } from "../lib/query-blocks";
import * as attachments from "./attachments";
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
  const { document } = await renderBookDocument({ ...params, noteId: note.id, markdown: note.contentMd ?? "" });
  // Do not return a collaboration snapshot or raw notebook data to the Book surface.
  return { note, document };
};

/** Query results for the reading subject, keyed by the query's one-based source line. */
export const resolveBookQueries = async (params: {
  notebookId: string;
  noteId: string;
  userId: string | null;
  serviceAccountId?: string | null;
  boundNotebookId?: string | null;
  markdown: string;
  bypassAccess?: boolean;
}): Promise<Map<number, NoteQueryResult>> => {
  const queryResults = new Map<number, NoteQueryResult>();
  // The parser bounds blocks and each resolver bounds rows. Avoid database fan-out.
  for (const query of parseNotebookQueryBlocks(params.markdown).blocks) {
    queryResults.set(
      query.line,
      await resolveNoteQuery({
        notebookId: params.notebookId,
        noteId: params.noteId,
        userId: params.userId,
        serviceAccountId: params.serviceAccountId,
        boundNotebookId: params.boundNotebookId,
        bypassAccess: params.bypassAccess,
        query,
      }),
    );
  }
  return queryResults;
};

/**
 * Titles of the notes whose headings this note links to, and the attachments it links to, both in the same
 * notebook. One query each, bounded by the distinct links in the note; the reader can already read the notebook.
 */
export const resolveBookReferences = async (params: { notebookId: string; markdown: string }): Promise<BookReferences> => {
  const headingNoteIds = [...params.markdown.matchAll(/note:\/\/([0-9a-zA-Z]{6})#/g)].map((match) => match[1]!);
  const attachmentIds = attachments.extractIds(params.markdown);
  const [titles, files] = await Promise.all([
    notes.titlesByShortIds({ notebookId: params.notebookId, shortIds: headingNoteIds }),
    attachments.listByShortIds({ shortIds: attachmentIds, notebookId: params.notebookId }),
  ]);
  return {
    notes: titles,
    attachments: new Map(files.map((file) => [file.shortId, { filename: file.filename, sizeBytes: file.sizeBytes }])),
  };
};

const renderBookDocument = async (params: {
  notebookId: string;
  notebookShortId: string;
  noteId: string;
  noteShortId: string;
  userId: string;
  locale: string;
  markdown: string;
  linkMode?: "write" | "readonly";
  bypassAccess?: boolean;
}) => {
  const { markdown } = params;
  const [queryResults, references] = await Promise.all([resolveBookQueries(params), resolveBookReferences(params)]);
  const document = renderNotebookBook({
    markdown,
    notebookId: params.notebookShortId,
    noteId: params.noteShortId,
    locale: params.locale,
    queryResults,
    references,
    linkMode: params.linkMode,
  });
  const t = bookRendererMessages.resolve([params.locale]).t;
  const diagnostics = [...queryResults].flatMap(([line, result]) =>
    result.diagnostics.map(({ code }) => ({ line, message: code === "unavailable" ? t.unavailableQuery : t.invalidBlock({ line }) })),
  );
  return { document, diagnostics };
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
  const { document, diagnostics: queryDiagnostics } = await renderBookDocument({
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
      diagnostics: [...diagnostics, ...queryDiagnostics],
    },
  };
};
