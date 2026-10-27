import { type BookReferences, renderNotebookBook } from "../lib/book-renderer";
import { bookRendererMessages, notebookBlockDiagnosticMessage } from "../lib/book-renderer-messages";
import { parseNotebookQueryBlocks, queryPageSize } from "../lib/query-blocks";
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
  /** The page each query shows, by its source line; queries without one show their first page. */
  pages?: ReadonlyMap<number, number>;
}) => {
  if (!params.bypassAccess && !(await notebooks.canAccess({ notebookId: params.notebookId, userId: params.userId, requiredLevel: "read" })))
    return null;
  const note = await notes.getWithContentByShortId({ shortId: params.noteShortId });
  if (!note || note.notebookId !== params.notebookId) return null;
  const { document } = await renderBookDocument({
    ...params,
    noteId: note.id,
    markdown: note.contentMd ?? "",
    pages: params.pages ?? new Map(),
  });
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
  /** Stops before the next query; a query without a result prints as unavailable. */
  signal?: AbortSignal;
  /**
   * Pages each query on screen, by its source line, a page at most `QUERY_PAGE_SIZE` rows. Without it, as for a PDF,
   * each query returns its first `limit` rows.
   */
  pages?: ReadonlyMap<number, number>;
}): Promise<Map<number, NoteQueryResult>> => {
  const queryResults = new Map<number, NoteQueryResult>();
  // The parser bounds blocks and each resolver bounds rows. Avoid database fan-out.
  for (const query of parseNotebookQueryBlocks(params.markdown).blocks) {
    if (params.signal?.aborted) break;
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
        ...(params.pages
          ? { page: { offset: ((params.pages.get(query.line) ?? 1) - 1) * queryPageSize(query), size: queryPageSize(query) } }
          : {}),
      }),
    );
  }
  return queryResults;
};

/**
 * Titles of the notes whose headings this note links to, and the attachments it links to, both in the same
 * notebook. One query each, bounded by the distinct links in the note; the reader can already read the notebook.
 */
export const resolveBookReferences = async (
  params: { notebookId: string; markdown: string },
  attachmentMetadata?: readonly attachments.Attachment[],
): Promise<BookReferences> => {
  const headingNoteIds = [...params.markdown.matchAll(/note:\/\/([0-9a-zA-Z]{6})#/g)].map((match) => match[1]!);
  const attachmentIds = attachments.extractIds(params.markdown);
  const [titles, files] = await Promise.all([
    notes.titlesByShortIds({ notebookId: params.notebookId, shortIds: headingNoteIds }),
    attachmentMetadata ?? attachments.listByShortIds({ shortIds: attachmentIds, notebookId: params.notebookId }),
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
  pages?: ReadonlyMap<number, number>;
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
  /** Pages the queries as Book and the editor show them; without it, as for an agent, each query returns its `limit`. */
  pages?: ReadonlyMap<number, number>;
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
  const diagnostics = document.diagnostics.map((diagnostic) => ({
    line: diagnostic.line,
    message: `${t.invalidBlock({ line: diagnostic.line })} ${diagnostic.path}: ${notebookBlockDiagnosticMessage(diagnostic, params.locale)}`,
  }));
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
