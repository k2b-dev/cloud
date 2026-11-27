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

/** The cookie that keeps the storage this person opened last; an address without a place opens it again. */
export const lastBaseCookie = "filesv2-base";

/** The storage this person opened last, as the cookie header names it; `undefined` without one. */
export function readLastBase(cookie?: string | null): string | undefined {
  const value = cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${lastBaseCookie}=`))
    ?.slice(lastBaseCookie.length + 1);
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/**
 * Where Files opens when an address names no place (Valentin 27.11.: no page of all storage): the storage opened last,
 * if this person still reaches it, else their personal one, else the first one there is.
 */
export function startBase<B extends { id: string; kind: string; status: string }>(bases: readonly B[], last?: string): B | undefined {
  const existing = bases.filter((base) => base.status === "existing");
  return (
    (last ? existing.find((base) => base.id === last) : undefined) ??
    existing.find((base) => base.kind === "users") ??
    existing[0] ??
    bases[0]
  );
}

/**
 * Whether an address names no place: no storage, folder or file, no search (a query after trimming or a search filter),
 * and no trash, shares, recent, favorites or Activity view. Unknown views and edit without a file count as no place.
 */
export const namesNoPlace = (params: URLSearchParams) =>
  !["base", "path", "file"].some((key) => params.get(key)) &&
  !searchState(params) &&
  !["trash", "shares", "recent", "favorites", "activity"].includes(params.get("view") ?? "");

/** The views of the Files screen; each is shown in place beside the others. */
export type ScreenView = "folder" | "trash" | "favorites" | "shares" | "activity" | "edit";

/**
 * The view an address shows: the trash of a storage, the favorites, the shares, Activity, a file in its editor, or a
 * folder (with a search below it). Unknown views and an editor without a file show the folder.
 */
export const screenViewOf = (params: URLSearchParams): ScreenView => {
  const view = params.get("view");
  if (view === "trash" || view === "favorites" || view === "shares" || view === "activity") return view;
  if (view === "edit" && params.get("file")) return "edit";
  return "folder";
};

const WHEN: readonly ActivityWhen[] = ["today", "7", "30", "365"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Activity address: `base`, `path`, `scope`, `who`, `what`, `when` and `q` keep the filters across reload, back and
 * links; `run` opens the run of one entry beside the list, so its details also survive reload, back and links.
 */
export function activityUrl(filters: ActivityFilters = {}, run?: string | null) {
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
  if (run) query.set("run", run);
  return `/app/filesv2?${query}`;
}

/** The entry whose run Activity shows beside its list: `undefined` without one, `null` for a value that is no entry ID. */
export function parseActivityRun(params: URLSearchParams): string | null | undefined {
  const run = params.get("run");
  if (run === null) return undefined;
  return UUID.test(run) ? run.toLowerCase() : null;
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
    // `me` is the person's own activity; the server resolves it from the request identity.
    if (who !== "me" && !UUID.test(who)) return null;
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
