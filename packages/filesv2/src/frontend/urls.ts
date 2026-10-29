import { HistoryAction } from "../activity-contracts";
import type { BrowseOptions } from "../contracts";
import type { ActivityFilters, ActivityWhen } from "./history-requests";
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
  !["trash", "shares", "recent", "favorites", "activity"].includes(params.get("view") ?? "");

const WHEN: readonly ActivityWhen[] = ["today", "7", "30", "365"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Activity address: `base`, `path`, `scope`, `who`, `what`, `when` and `q` keep the filters across reload, back and links. */
export function activityUrl(filters: ActivityFilters = {}) {
  const query = new URLSearchParams({ view: "activity" });
  if (filters.baseId) query.set("base", filters.baseId);
  if (filters.baseId && filters.path !== undefined) {
    query.set("path", filters.path);
    if (filters.scope) query.set("scope", filters.scope);
  }
  if (filters.actor) query.set("who", filters.actor);
  if (filters.action) query.set("what", filters.action);
  if (filters.when) query.set("when", filters.when);
  if (filters.q) query.set("q", filters.q);
  return `/app/filesv2?${query}`;
}

/**
 * Reads the Activity filters of an address with the reader's own bounds. `null` means a value the reader would
 * reject, so the page answers 400 instead of silently showing a different filter.
 */
export function parseActivityFilters(params: URLSearchParams): ActivityFilters | null {
  const filters: ActivityFilters = {};
  const base = params.get("base") ?? "";
  const path = params.get("path") ?? "";
  const scope = params.get("scope");
  const who = params.get("who") ?? "";
  const what = params.get("what") ?? "";
  const when = params.get("when") ?? "";
  const q = params.get("q")?.trim() ?? "";
  if (base.length > 256 || path.length > 4096 || q.length > 4096) return null;
  if (path && (!base || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === ".."))) return null;
  if (base) filters.baseId = base;
  if (params.has("path") && base) filters.path = path;
  if (scope !== null) {
    if ((scope !== "item" && scope !== "folder") || !base || !params.has("path")) return null;
    filters.scope = scope;
  }
  if (who) {
    if (!UUID.test(who)) return null;
    filters.actor = who;
  }
  if (what) {
    const action = HistoryAction.safeParse(what);
    if (!action.success) return null;
    filters.action = action.data;
  }
  if (when) {
    const range = WHEN.find((value) => value === when);
    if (!range) return null;
    filters.when = range;
  }
  if (q) filters.q = q;
  return filters;
}
