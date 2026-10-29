import { startOfDay } from "@k2b/stdlib";
import type { ActivityEntry, ActivityInput, ActivityPage, HistoryAction } from "../activity-contracts";
import type { BaseSummary, FileEntry } from "../contracts";
import { parseStableEntryRefId } from "../resource-ref";
import { baseLabel } from "./base-label";
import type { HistoryEnvironment, HistoryPlace } from "./history-actions";

/*
 * Requests and projections that SSR and the browser share, so the first render and every client reload ask the
 * reader the same question. Nothing here authorizes anything; the reader and the action endpoints decide.
 */

export type ActivityWhen = "today" | "7" | "30" | "365";
/** URL state of the Activity view; the parent keeps it in the address so reload and back restore it. */
export type ActivityFilters = {
  baseId?: string;
  /** A base-relative item or folder path; "All in Activity" preserves its scope. */
  path?: string;
  scope?: ActivityInput["scope"];
  actor?: string;
  action?: HistoryAction;
  when?: ActivityWhen;
  q?: string;
};
export type ActivityRequest = Omit<ActivityInput, "itemId" | "limit">;

const DAYS: Record<ActivityWhen, number> = { today: 0, "7": 7, "30": 30, "365": 365 };

/** Start of the range in the request's zone. "Today" starts at local midnight. */
export function rangeStart(when: ActivityWhen, env: HistoryEnvironment): string {
  const now = new Date(env.now);
  if (when !== "today") return new Date(now.getTime() - DAYS[when] * 86_400_000).toISOString();
  return startOfDay(now, { timeZone: env.timeZone }).toISOString();
}

export function activityRequest(filters: ActivityFilters, env: HistoryEnvironment): ActivityRequest {
  return {
    ...(filters.baseId ? { baseId: filters.baseId } : {}),
    ...(filters.baseId && filters.path !== undefined ? { path: filters.path, scope: filters.scope ?? "item" } : {}),
    ...(filters.actor ? { actor: filters.actor } : {}),
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.when ? { from: rangeStart(filters.when, env) } : {}),
    ...(filters.q ? { q: filters.q } : {}),
  };
}
/** Folders include descendants at their current path; files use a stable ID where available, otherwise the exact path. */
export type ItemHistoryRequest = Pick<ActivityInput, "baseId" | "itemId" | "path" | "scope">;
export function itemHistoryRequest(
  base: Pick<BaseSummary, "id">,
  entry: Pick<FileEntry, "path" | "resourceId" | "directory">,
): ItemHistoryRequest {
  if (entry.directory) return { baseId: base.id, path: entry.path, scope: "folder" };
  const stable = entry.resourceId ? parseStableEntryRefId(entry.resourceId) : null;
  return stable && stable.baseId === base.id
    ? { baseId: base.id, itemId: stable.fileId }
    : { baseId: base.id, path: entry.path, scope: "item" };
}
export const itemHistorySource = (request: ItemHistoryRequest) => JSON.stringify(request);

/** The counted window of link access: the last 30 calendar days in UTC, both ends included. */
export function sharePeriod(now: string) {
  const to = new Date(now);
  const from = new Date(to.getTime() - 29 * 86_400_000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

const MOVES = new Set(["item.move", "item.rename"]);
/**
 * The move that took the opened item or one of its directory ancestors away from this base-relative address.
 * Only the reader-approved relative path scopes a candidate. The chain must still authorize the actual child.
 * Entries arrive newest first; an unrelated name/suffix never identifies the old base.
 */
export function movedEntry(page: ActivityPage, oldPath: string): ActivityEntry | null {
  return (
    page.items.find((entry) => {
      const before = entry.before;
      if (!MOVES.has(entry.action) || entry.state !== "done" || before.visibility === "hidden" || before.relativePath == null) return false;
      return (
        before.relativePath === oldPath ||
        (before.directory === true && (before.relativePath === "" || oldPath.startsWith(`${before.relativePath}/`)))
      );
    }) ?? null
  );
}

/**
 * Names approved places with their current storage label and base-relative folders. Unknown snapshots retain
 * their raw recorded path through the caller's fallback; matching a name or suffix never establishes authority.
 */
export function placeDescriber(
  bases: readonly BaseSummary[],
  messages: { personal: string },
  locale: string,
): NonNullable<HistoryEnvironment["describePlace"]> {
  return (place: HistoryPlace) => {
    const baseId = place.kind === "endpoint" ? place.endpoint.baseId : place.side.publicBaseId;
    const path = place.kind === "endpoint" ? place.endpoint.path : place.side.relativePath;
    if (!baseId || path == null) return undefined;
    const base = bases.find((item) => item.id === baseId);
    if (!base) return undefined;
    return [baseLabel(base, messages, locale), ...path.split("/").filter(Boolean).slice(0, -1)];
  };
}
