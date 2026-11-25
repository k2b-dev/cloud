import { defineListQuery, field, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import type { BrowseOptions } from "../contracts";
import type { browserMessages } from "./browser-messages";
import type { ViewPreference } from "./browser-preferences";
import {
  SEARCH_KINDS,
  SEARCH_MODIFIED,
  SEARCH_SIZES,
  type SearchKind,
  type SearchModified,
  type SearchSize,
  type SearchState,
} from "./search-state";

type Words = ReturnType<typeof browserMessages.resolve>["t"];

/** Parameters of a folder address that the list query does not own: where it stands, what is open, which page. */
export const FOLDER_PAGE_PARAMS = ["base", "path", "file", "after", "pages", "refreshed", "scope", "in"] as const;

const KINDS = Object.keys(SEARCH_KINDS) as SearchKind[];
const SIZES = Object.keys(SEARCH_SIZES) as SearchSize[];
const MODIFIED = Object.keys(SEARCH_MODIFIED) as SearchModified[];

const kindLabel = (t: Words, kind: SearchKind) =>
  ({
    folder: t.searchKindFolder,
    document: t.searchKindDocument,
    pdf: t.searchKindPdf,
    sheet: t.searchKindSheet,
    slides: t.searchKindSlides,
    image: t.searchKindImage,
    video: t.searchKindVideo,
    audio: t.searchKindAudio,
    archive: t.searchKindArchive,
  })[kind];
const sizeLabel = (t: Words, size: SearchSize) =>
  ({ small: t.searchSizeSmall, medium: t.searchSizeMedium, large: t.searchSizeLarge, huge: t.searchSizeHuge })[size];
const modifiedLabel = (t: Words, modified: SearchModified) =>
  ({ day: t.searchModifiedDay, week: t.searchModifiedWeek, month: t.searchModifiedMonth, year: t.searchModifiedYear })[modified];

/**
 * The fields of a folder and of a search below it. `type` narrows the listing; kind, size and modified search the
 * whole tree below the folder, as the search field does, and `match` narrows a search to exact names.
 */
const fields = (t: Words) => ({
  type: field.choice({
    label: t.filterType,
    multiple: false,
    common: true,
    options: [
      { value: "directories", label: t.filterFolders },
      { value: "files", label: t.filterFiles },
    ],
  }),
  kind: field.choice({
    label: t.v2Kind,
    multiple: false,
    common: true,
    options: KINDS.map((kind) => ({ value: kind, label: kindLabel(t, kind) })),
  }),
  size: field.choice({ label: t.filterSize, multiple: false, options: SIZES.map((size) => ({ value: size, label: sizeLabel(t, size) })) }),
  modified: field.choice({
    label: t.filterModified,
    multiple: false,
    options: MODIFIED.map((modified) => ({ value: modified, label: modifiedLabel(t, modified) })),
  }),
  match: field.choice({ label: t.match, multiple: false, options: [{ value: "exact", label: t.matchExact }] }),
});

const sorts = (t: Words) => ({
  name: { label: t.sortName, directions: ["asc", "desc"] as const },
  modified: { label: t.sortModified, directions: ["desc", "asc"] as const },
  size: { label: t.sortSize, directions: ["desc", "asc"] as const },
});

/**
 * The list query of a folder and the one of a search. Both hold the same filters; a search adds its best matches as
 * the first order. The address decides which applies: a search word makes it a search.
 */
export const folderQueries = (t: Words) => ({
  folder: defineListQuery({
    key: "filesv2-folder",
    fields: fields(t),
    search: { label: t.search },
    sort: { options: sorts(t), default: { field: "name", direction: "asc" } },
    group: { kind: { label: t.v2Kind } },
    pageParams: FOLDER_PAGE_PARAMS,
  }),
  search: defineListQuery({
    key: "filesv2-search",
    fields: fields(t),
    search: { label: t.search },
    sort: {
      options: { relevance: { label: t.sortRelevance, directions: ["desc"] as const }, ...sorts(t) },
      default: { field: "relevance", direction: "desc" },
    },
    pageParams: FOLDER_PAGE_PARAMS,
  }),
});
export type FolderQueries = ReturnType<typeof folderQueries>;
export type FolderState = ListQueryStateOf<FolderQueries["folder"]>;
export type SearchListState = ListQueryStateOf<FolderQueries["search"]>;

/** A folder or a search, read from its address. */
export type FolderAddress = { mode: "folder"; state: FolderState } | { mode: "search"; state: SearchListState };

/** A search word makes the address a search; filters alone keep the folder's order, since nothing ranks them. */
export const isSearchAddress = (params: URLSearchParams) => !!params.get("q")?.trim();

/**
 * The state of an address. The preference of the storage supplies what the address leaves out: its order, whether
 * folders come first and what it shows, as the folder view did since it remembered them per storage.
 */
export function readFolderAddress(queries: FolderQueries, params: URLSearchParams, preference: ViewPreference): FolderAddress {
  if (isSearchAddress(params)) return { mode: "search", state: queries.search.parse(params).state };
  let state = queries.folder.parse(params).state;
  if (!params.has("sort")) state = queries.folder.set(state, "sort", { field: preference.sort, direction: preference.direction }) ?? state;
  if (!params.has("group") && preference.groupFolders) state = queries.folder.set(state, "group", "kind") ?? state;
  if (!params.has("type") && preference.type !== "all") state = queries.folder.set(state, "type", preference.type) ?? state;
  return { mode: "folder", state };
}

/** The browse options the API takes for a folder state. */
export const browseOf = (state: FolderState): BrowseOptions => ({
  sort: state.sort.field,
  order: state.sort.direction,
  type: state.filters.type ?? "all",
  groupFolders: state.group === "kind",
});

/** The preference a folder state leaves for its storage. */
export const preferenceOf = (state: FolderState, view: ViewPreference): ViewPreference => ({
  ...view,
  sort: state.sort.field,
  direction: state.sort.direction,
  type: state.filters.type ?? "all",
  groupFolders: state.group === "kind",
});

/** The search an address asks for: a search word, or filters that look below the folder without one. */
export function searchOf(address: FolderAddress, params: URLSearchParams): SearchState | null {
  const { filters, search } = address.state;
  if (!search && !filters.kind && !filters.size && !filters.modified) return null;
  const sort = address.state.sort.field;
  return {
    q: search ?? "",
    scope: params.get("scope") === "folder" ? "folder" : "tree",
    exact: filters.match === "exact",
    sort: sort === "relevance" && !search ? undefined : sort,
    order: address.state.sort.direction,
    kind: filters.kind,
    size: filters.size,
    modified: filters.modified,
    type: filters.type,
  };
}

/**
 * An address from before v2, when the order stood in `sort` and `order` and folders first in `groupFolders`, written
 * the way the list query reads it; null when the address is current. Every other parameter stays as it was.
 */
export function legacyFolderHref(params: URLSearchParams): string | null {
  const sort = params.get("sort");
  const old =
    params.has("order") ||
    params.has("groupFolders") ||
    params.get("type") === "all" ||
    (params.has("match") && params.get("match") !== "exact") ||
    (!!sort && !sort.includes("."));
  if (!old) return null;
  const next = new URLSearchParams();
  for (const [key, value] of params) if (!["sort", "order", "groupFolders", "type", "match", "in"].includes(key)) next.append(key, value);
  const search = isSearchAddress(params);
  const order = params.get("order") === "desc" ? "desc" : "asc";
  if (sort && !sort.includes(".") && !(search && sort === "relevance")) next.set("sort", `${sort}.${order}`);
  else if (sort?.includes(".")) next.set("sort", sort);
  else if (!search && params.get("order") === "desc") next.set("sort", "name.desc");
  if (!search) {
    const grouped = params.get("groupFolders");
    if (grouped === "true") next.set("group", "kind");
    else if (grouped === null && params.has("group")) next.set("group", params.get("group")!);
  }
  const type = params.get("type");
  if (type === "files" || type === "directories") next.set("type", type);
  if (params.get("match") === "exact") next.set("match", "exact");
  return `/app/filesv2${next.size ? `?${next}` : ""}`;
}
