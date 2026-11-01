import { SEARCH_SORTS, type SearchSort } from "../contracts";

/** Type choices of the search filter; every one except folders is a list of extensions. */
export const SEARCH_KINDS = {
  folder: [],
  document: ["doc", "docx", "odt", "rtf", "txt", "md", "pages"],
  pdf: ["pdf"],
  sheet: ["xls", "xlsx", "ods", "csv", "numbers"],
  slides: ["ppt", "pptx", "odp", "key"],
  image: ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "avif", "svg", "bmp", "tif", "tiff"],
  video: ["mp4", "mov", "m4v", "mkv", "webm", "avi"],
  audio: ["mp3", "m4a", "wav", "flac", "ogg", "opus", "aac"],
  archive: ["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"],
} as const satisfies Record<string, readonly string[]>;
export type SearchKind = keyof typeof SEARCH_KINDS;

const MIB = 1024 * 1024;
/** Inclusive byte bounds; any size filter excludes folders. */
export const SEARCH_SIZES = {
  small: { maxSize: MIB - 1 },
  medium: { minSize: MIB, maxSize: 10 * MIB - 1 },
  large: { minSize: 10 * MIB, maxSize: 100 * MIB - 1 },
  huge: { minSize: 100 * MIB },
} as const satisfies Record<string, { minSize?: number; maxSize?: number }>;
export type SearchSize = keyof typeof SEARCH_SIZES;

const HOUR = 60 * 60 * 1000;
/** Rolling windows back from the current full hour, so every page of one query in that hour asks the same. */
export const SEARCH_MODIFIED = { day: 24 * HOUR, week: 7 * 24 * HOUR, month: 30 * 24 * HOUR, year: 365 * 24 * HOUR } as const;
export type SearchModified = keyof typeof SEARCH_MODIFIED;

/** Everything about a search the address keeps; `sort` is absent while it is the default. */
export type SearchState = {
  q: string;
  scope: "folder" | "tree";
  /** Exact names only, without typos or folder names; the cheaper search after a spent budget. */
  exact: boolean;
  sort?: SearchSort;
  order: "asc" | "desc";
  kind?: SearchKind;
  size?: SearchSize;
  modified?: SearchModified;
};

const pick = <T extends string>(value: string | null, values: readonly T[]) => values.find((item) => item === value);
const hasFilter = (state: Pick<SearchState, "kind" | "size" | "modified">) => !!(state.kind || state.size || state.modified);

/** The search an address asks for, or null when it shows a folder. Unknown values fall back to their default. */
export function searchState(params: URLSearchParams): SearchState | null {
  const q = params.get("q")?.trim() ?? "";
  const state: SearchState = {
    q,
    scope: params.get("scope") === "folder" ? "folder" : "tree",
    exact: params.get("match") === "exact",
    sort: pick(params.get("sort"), SEARCH_SORTS),
    order: params.get("order") === "desc" ? "desc" : "asc",
    kind: pick(params.get("kind"), Object.keys(SEARCH_KINDS) as SearchKind[]),
    size: pick(params.get("size"), Object.keys(SEARCH_SIZES) as SearchSize[]),
    modified: pick(params.get("modified"), Object.keys(SEARCH_MODIFIED) as SearchModified[]),
  };
  if (!q && state.sort === "relevance") state.sort = undefined;
  return q || hasFilter(state) ? state : null;
}

/** The search fields of an address, in a stable order; defaults stay out. */
export function searchEntries(state: SearchState): [string, string][] {
  const entries: [string, string][] = [];
  if (state.q) entries.push(["q", state.q]);
  if (state.scope === "folder") entries.push(["scope", "folder"]);
  if (state.exact) entries.push(["match", "exact"], ["in", "name"]);
  if (state.kind) entries.push(["kind", state.kind]);
  if (state.size) entries.push(["size", state.size]);
  if (state.modified) entries.push(["modified", state.modified]);
  if (state.sort && state.sort !== defaultSort(state)) entries.push(["sort", state.sort]);
  if (effectiveSort(state) !== "relevance" && state.order === "desc") entries.push(["order", "desc"]);
  return entries;
}

export const defaultSort = (state: Pick<SearchState, "q">): SearchSort => (state.q ? "relevance" : "name");
export const effectiveSort = (state: Pick<SearchState, "q" | "sort">): SearchSort => state.sort ?? defaultSort(state);
export const searchFiltered = hasFilter;

/** The API query of a search. Results are never grouped, so a known total covers files and folders together. */
export function searchRequest(state: SearchState, now = Date.now()) {
  const extensions = state.kind && state.kind !== "folder" ? SEARCH_KINDS[state.kind].join(",") : undefined;
  const size = state.size ? SEARCH_SIZES[state.size] : {};
  const window = state.modified ? SEARCH_MODIFIED[state.modified] : undefined;
  return {
    q: state.q,
    scope: state.scope,
    match: state.exact ? ("exact" as const) : ("fuzzy" as const),
    in: state.exact ? ("name" as const) : ("path" as const),
    sort: effectiveSort(state),
    order: state.order,
    type: state.kind === "folder" ? ("directories" as const) : ("all" as const),
    groupFolders: "false" as const,
    ...(extensions ? { ext: extensions } : {}),
    ...("minSize" in size ? { minSize: String(size.minSize) } : {}),
    ...("maxSize" in size ? { maxSize: String(size.maxSize) } : {}),
    ...(window ? { modifiedAfter: new Date(Math.floor(now / HOUR) * HOUR - window).toISOString() } : {}),
  };
}
