import type { PublicGridRecord as GridRecord, PublicTableQueryResult as TableQueryResult } from "../../../api/public-dto";
import type { RecordQuery } from "../../../contracts";

export const visibleIdsFromResult = (result: TableQueryResult | undefined): string[] =>
  ((result?.items ?? []) as GridRecord[]).map((record) => record.id);

export const highlightedIdsForLiveRefresh = (params: {
  eventRecordIds: Iterable<string>;
  previousVisibleIds: Iterable<string>;
  nextVisibleIds: Iterable<string>;
}): string[] => {
  const eventIds = new Set(params.eventRecordIds);
  const previous = new Set(params.previousVisibleIds);
  const next = new Set(params.nextVisibleIds);
  const highlighted = new Set<string>();

  for (const id of eventIds) {
    if (next.has(id)) highlighted.add(id);
  }
  for (const id of next) {
    if (!previous.has(id)) highlighted.add(id);
  }
  return [...highlighted];
};

export const liveRefreshQuery = (query: RecordQuery, visibleCount: number): RecordQuery => {
  const currentLimit = typeof query.limit === "number" && Number.isFinite(query.limit) ? query.limit : 100;
  const limit = Math.min(Math.max(currentLimit, visibleCount, 1), 500);
  return { ...query, limit };
};

export const shouldLoadNextLiveRefreshPage = (params: { loadedCount: number; targetCount: number; nextCursor: string | null }): boolean =>
  !!params.nextCursor && params.loadedCount < Math.max(params.targetCount, 1);

export const shouldOptimisticallyRemoveDeletedRecord = (query: Pick<RecordQuery, "includeDeleted" | "deletedOnly">): boolean =>
  !query.includeDeleted && !query.deletedOnly;
