import type { BrowseOptions } from "../contracts";
import { parseStableEntryRefId } from "../resource-ref";
import { type SearchState, searchEntries, searchState } from "./search-state";

/** A search keeps its own order and filters; the folder's sort and type options apply only without one. */
export function filesUrl(
  baseId?: string,
  path = "",
  after?: string | null,
  file?: string | null,
  search?: SearchState | null,
  browse?: BrowseOptions,
) {
  const query = new URLSearchParams();
  if (baseId) query.set("base", baseId);
  if (path) query.set("path", path);
  if (search) for (const [key, value] of searchEntries(search)) query.set(key, value);
  else if (browse) for (const [key, value] of Object.entries(browse)) query.set(key, String(value));
  if (after) query.set("after", after);
  if (file) query.set("file", file);
  return `/app/filesv2${query.size ? `?${query}` : ""}`;
}

/** The editor view: the folder stays in the URL so leaving the editor returns to the file's row. */
export const editorUrl = (baseId: string, path: string) =>
  `${filesUrl(baseId, path.split("/").slice(0, -1).join("/"), null, path)}&view=edit`;

/** The plain-text link of a copied reference: a stable ref opens through the deep link, which follows renames and moves. */
export const referenceHref = (baseId: string, entry: { path: string; directory: boolean }, id: string) =>
  parseStableEntryRefId(id)
    ? `/app/filesv2/ref/${encodeURIComponent(id)}`
    : entry.directory
      ? filesUrl(baseId, entry.path)
      : filesUrl(baseId, entry.path.split("/").slice(0, -1).join("/"), null, entry.path);

export function pathCrumbs(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join("/") }));
}

/**
 * Files starts at all storage when there is more than one storage and the address names no non-empty storage,
 * folder or file, no search (a query after trimming or a search filter), and no trash, shares, recent or favorites view. Unknown views and
 * edit without a file are ignored, matching the normalized snapshot address. A single storage opens inside it.
 */
export const showsOverview = (params: URLSearchParams, storageCount: number) =>
  storageCount > 1 &&
  !["base", "path", "file"].some((key) => params.get(key)) &&
  !searchState(params) &&
  !["trash", "shares", "recent", "favorites"].includes(params.get("view") ?? "");
