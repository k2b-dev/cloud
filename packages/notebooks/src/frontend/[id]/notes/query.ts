/**
 * The notes list's one declaration: favorites, a tag, the search and the order. The SSR page reads and the browser
 * writes the address only through it, so reload, back and a shared link show the same notes. Notebooks filters on the
 * server (`notebooksService.pages.list`) with the person's access. It replaces the tag page: `/tags/:tag` leads here
 * with the tag set (maintainer GO 25.11.).
 */
import { defineListQuery, field, type ListQueryIssue, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import { notesListMessages } from "./messages";

/** Notes per page, as the tag page had. */
export const NOTES_PER_PAGE = 50;
/** Longest free search. A longer text is dropped and reported, never cut silently. */
export const NOTES_SEARCH_MAX = 200;
/** Last page the list opens. */
export const NOTES_PAGE_MAX = 1000;

export const notesListPath = (notebookShortId: string) => `/app/notebooks/${notebookShortId}/notes`;

/** Builds the declaration in the request's language with the notebook's tags (`tag` and its note count). */
export const notesQuery = (locale: string, tags: readonly { tag: string; count: number }[]) => {
  const { t } = notesListMessages.resolve([locale]);
  return defineListQuery({
    key: "notebooks.notes",
    fields: {
      favorite: field.bool({ label: t.favorite, common: true, labels: { yes: t.favoritesOnly, no: t.noFavorites } }),
      tag: field.choice({
        label: t.tag,
        common: true,
        multiple: false,
        options: tags.map((entry) => ({ value: entry.tag, label: `#${entry.tag}` })),
      }),
    },
    search: { label: t.searchNotes },
    sort: {
      options: {
        updated: { label: t.lastChanged, directions: ["desc"] },
        created: { label: t.created, directions: ["desc"] },
        title: { label: t.title, directions: ["asc"] },
      },
      default: { field: "updated", direction: "desc" },
    },
    pageParams: ["page", "mode"],
  });
};

export type NotesQuery = ReturnType<typeof notesQuery>;
export type NotesState = ListQueryStateOf<NotesQuery>;

/** The views in code beside "All": their key in the address and their state. */
export const notesViews = (query: NotesQuery) => ({
  favorites: { ...query.reset(), filters: { favorite: true }, view: "favorites" } satisfies NotesState,
});

/** What the page reads from an address: the list state, the page and what was dropped. */
export type NotesAddress = { state: NotesState; page: number; issues: readonly ListQueryIssue[] };

/** Reads an address with the declaration and holds every value to the list's bounds. Never throws. */
export const parseNotesAddress = (query: NotesQuery, params: URLSearchParams): NotesAddress => {
  const parsed = query.parse(params);
  const issues: ListQueryIssue[] = [...parsed.issues];
  let state = parsed.state;
  if (state.search && state.search.length > NOTES_SEARCH_MAX) {
    issues.push({ code: "invalid", param: "q", value: state.search });
    state = { ...state, search: undefined };
  }
  if (state.view !== undefined && state.view !== "favorites") {
    issues.push({ code: "invalid", param: "view", value: state.view });
    state = { ...state, view: undefined };
  }
  const pageRaw = params.get("page");
  const page = pageRaw === null ? 1 : Number(pageRaw);
  const valid = Number.isSafeInteger(page) && page >= 1 && page <= NOTES_PAGE_MAX;
  if (!valid) issues.push({ code: "invalid", param: "page", value: pageRaw ?? "" });
  return { state, page: valid ? page : 1, issues };
};

/** The address of a state with its page; `mode` keeps the presentation the list was opened in (Book for readers). */
export const notesHref = (notebookShortId: string, query: NotesQuery, state: NotesState, page = 1, mode?: string): string => {
  const params = query.serialize(state);
  if (page > 1) params.set("page", String(page));
  if (mode) params.set("mode", mode);
  const text = params.toString();
  return text ? `${notesListPath(notebookShortId)}?${text}` : notesListPath(notebookShortId);
};

/** The list address an old tag page (`/tags/:tag?search=&page=&mode=`) leads to: the same notes, the tag as a filter. */
export const legacyTagHref = (notebookShortId: string, tag: string, params: URLSearchParams): string => {
  const next = new URLSearchParams({ tag: tag.toLowerCase() });
  const search = params.get("search")?.trim();
  if (search) next.set("q", search);
  for (const key of ["page", "mode"]) {
    const value = params.get(key);
    if (value) next.set(key, value);
  }
  return `${notesListPath(notebookShortId)}?${next}`;
};
