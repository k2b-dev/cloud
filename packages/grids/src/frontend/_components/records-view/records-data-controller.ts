import { type Accessor, createEffect, createSignal, onCleanup, onMount, type Setter } from "solid-js";
import type { PublicGridRecord as GridRecord, PublicTableQueryResult as TableQueryResult } from "../../../api/public-dto";
import { fetchTableQuery } from "./fetcher";
import { createGridsRecordEventsProvider } from "./grids-record-events-provider";
import {
  highlightedIdsForLiveRefresh,
  liveRefreshQuery,
  shouldLoadNextLiveRefreshPage,
  shouldOptimisticallyRemoveDeletedRecord,
  visibleIdsFromResult,
} from "./live-refresh";
import { nextCursorWithinLimit, queryForRecordsPage } from "./records-pagination";
import { createRecordsQueryController, type RecordsQuerySource, type RecordsTableQueryResult } from "./records-query-controller";

type FilePreviews = NonNullable<TableQueryResult["filePreviews"]>;

type FlatRecordsPage = {
  items: GridRecord[];
  nextCursor: string | null;
  filePreviews: FilePreviews;
};

type GroupedRecordsPage = {
  buckets: NonNullable<TableQueryResult["buckets"]>;
  nextCursor: string | null;
  relationLabels: NonNullable<TableQueryResult["relationLabels"]>;
  explode: boolean;
};

export const reconcileFlatRecordsPage = (
  current: FlatRecordsPage,
  response: TableQueryResult,
  append: boolean,
  absoluteLimit?: number,
): FlatRecordsPage => {
  const pageItems = (response.items ?? []) as GridRecord[];
  if (!append) {
    const items = absoluteLimit === undefined ? pageItems : pageItems.slice(0, absoluteLimit);
    return {
      items,
      nextCursor: nextCursorWithinLimit(response.nextCursor ?? null, items.length, absoluteLimit),
      filePreviews: response.filePreviews ?? {},
    };
  }

  const seen = new Set(current.items.map((record) => record.id));
  const combined = [...current.items, ...pageItems.filter((record) => !seen.has(record.id))];
  const items = absoluteLimit === undefined ? combined : combined.slice(0, absoluteLimit);
  return {
    items,
    nextCursor: nextCursorWithinLimit(response.nextCursor ?? null, items.length, absoluteLimit),
    filePreviews: { ...current.filePreviews, ...(response.filePreviews ?? {}) },
  };
};

export const reconcileGroupedRecordsPage = (
  current: GroupedRecordsPage,
  response: TableQueryResult,
  append: boolean,
  absoluteLimit?: number,
): GroupedRecordsPage => {
  const pageBuckets = response.buckets ?? [];
  if (!append) {
    const buckets = absoluteLimit === undefined ? pageBuckets : pageBuckets.slice(0, absoluteLimit);
    return {
      buckets,
      nextCursor: nextCursorWithinLimit(response.nextCursor ?? null, buckets.length, absoluteLimit),
      relationLabels: response.relationLabels ?? {},
      explode: response.explode ?? false,
    };
  }

  const seen = new Set(current.buckets.map((bucket) => JSON.stringify(bucket.keys)));
  const combined = [...current.buckets, ...pageBuckets.filter((bucket) => !seen.has(JSON.stringify(bucket.keys)))];
  const buckets = absoluteLimit === undefined ? combined : combined.slice(0, absoluteLimit);
  return {
    buckets,
    nextCursor: nextCursorWithinLimit(response.nextCursor ?? null, buckets.length, absoluteLimit),
    relationLabels: { ...current.relationLabels, ...(response.relationLabels ?? {}) },
    explode: current.explode || (response.explode ?? false),
  };
};

type FetchRecords = typeof fetchTableQuery;

export const fetchVisibleFlatRecords = async (options: {
  source: RecordsQuerySource;
  targetCount: number;
  signal: AbortSignal;
  fetchRecords?: FetchRecords;
}): Promise<TableQueryResult> => {
  const desiredCount = Math.max(options.targetCount, 1);
  const fetchRecords = options.fetchRecords ?? fetchTableQuery;
  let nextCursor: string | null = null;
  let firstPage: TableQueryResult | null = null;
  const combinedItems: GridRecord[] = [];
  const combinedFilePreviews: FilePreviews = {};
  const relationLabels: NonNullable<TableQueryResult["relationLabels"]> = {};
  const cursors = new Set<string>();

  do {
    const page = await fetchRecords(
      {
        tableId: options.source.tableId,
        viewId: options.source.viewId,
        query: liveRefreshQuery(options.source.query, Math.max(desiredCount - combinedItems.length, 1)),
        cursor: nextCursor,
        filePreviewFieldIds: options.source.filePreviewFieldIds,
      },
      { signal: options.signal },
    );
    firstPage ??= page;
    combinedItems.push(...((page.items ?? []) as GridRecord[]));
    Object.assign(combinedFilePreviews, page.filePreviews ?? {});
    Object.assign(relationLabels, page.relationLabels ?? {});
    nextCursor = page.nextCursor ?? null;
    if (nextCursor && cursors.has(nextCursor)) throw new Error("Repeated records cursor");
    if (nextCursor) cursors.add(nextCursor);
  } while (
    shouldLoadNextLiveRefreshPage({
      loadedCount: combinedItems.length,
      targetCount: desiredCount,
      nextCursor,
    })
  );

  return {
    ...(firstPage ?? { nextCursor: null }),
    items: combinedItems,
    relationLabels,
    filePreviews: Object.keys(combinedFilePreviews).length > 0 ? combinedFilePreviews : undefined,
    nextCursor,
  };
};

export const fetchVisibleGroupedRecords = async (options: {
  source: RecordsQuerySource;
  targetCount: number;
  signal: AbortSignal;
  fetchRecords?: FetchRecords;
}): Promise<TableQueryResult> => {
  const desiredCount = Math.max(options.targetCount, 1);
  const fetchRecords = options.fetchRecords ?? fetchTableQuery;
  let page: GroupedRecordsPage = { buckets: [], nextCursor: null, relationLabels: {}, explode: false };
  let cursor: string | null = null;
  let firstPage: TableQueryResult | undefined;
  const cursors = new Set<string>();

  do {
    const response = await fetchRecords(
      {
        tableId: options.source.tableId,
        viewId: options.source.viewId,
        query: liveRefreshQuery(options.source.query, Math.max(desiredCount - page.buckets.length, 1)),
        cursor,
        filePreviewFieldIds: options.source.filePreviewFieldIds,
      },
      { signal: options.signal },
    );
    firstPage ??= response;
    page = reconcileGroupedRecordsPage(page, response, page.buckets.length > 0, options.source.query.limit);
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error("Repeated records cursor");
    if (cursor) cursors.add(cursor);
  } while (shouldLoadNextLiveRefreshPage({ loadedCount: page.buckets.length, targetCount: desiredCount, nextCursor: cursor }));

  return {
    ...firstPage,
    buckets: page.buckets,
    nextCursor: page.nextCursor,
    relationLabels: page.relationLabels,
    explode: page.explode,
  };
};

type LiveProviderError = { message: string };

type RecordsDataControllerOptions = {
  tableId: string;
  trashMode: boolean;
  source: Accessor<RecordsQuerySource>;
  initialData: TableQueryResult;
  initialEventCursor: string | null;
  locale: string;
  cursor: Accessor<string | null>;
  setCursor: Setter<string | null>;
  isGrouped: Accessor<boolean>;
  hasBlockingDialog: Accessor<boolean>;
  onOptimisticDelete: (recordId: string) => void;
  onRefreshed: (result: TableQueryResult) => Promise<void> | void;
  onRevoked: (error: LiveProviderError) => void;
  onFatal: (error: LiveProviderError) => void;
};

export const createRecordsDataController = (options: RecordsDataControllerOptions) => {
  const [flatPage, setFlatPage] = createSignal<FlatRecordsPage>({
    items: (options.initialData.items ?? []) as GridRecord[],
    nextCursor: options.initialData.nextCursor ?? null,
    filePreviews: options.initialData.filePreviews ?? {},
  });
  const [groupedPage, setGroupedPage] = createSignal<GroupedRecordsPage>({
    buckets: options.initialData.buckets ?? [],
    nextCursor: options.initialData.nextCursor ?? null,
    relationLabels: options.initialData.relationLabels ?? {},
    explode: options.initialData.explode ?? false,
  });
  let requestedPage: { cursor: string; loadedCount: number } | null = null;
  const recordsQuery = createRecordsQueryController({
    source: options.source,
    initialValue: options.initialData,
    prepareSource: (source) => ({
      ...source,
      query: queryForRecordsPage(source.query, source.cursor && requestedPage?.cursor === source.cursor ? requestedPage.loadedCount : 0),
    }),
  });
  const [livePending, setLivePending] = createSignal(false);
  const [liveRefreshing, setLiveRefreshing] = createSignal(false);
  const [highlightedRecordIds, setHighlightedRecordIds] = createSignal<Set<string>>(new Set());
  let didApplyFirstFlatPage = false;
  let didApplyFirstGroupedPage = false;
  let liveRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let highlightTimer: ReturnType<typeof setTimeout> | undefined;
  let liveRefreshAbort: AbortController | undefined;
  let liveProvider: ReturnType<typeof createGridsRecordEventsProvider> | null = null;
  let pendingLiveCursor: string | null = null;
  let refreshRequestId = 0;
  let pendingLiveRecordIds = new Set<string>();
  let staleResourceEpochFloor = -1;
  let liveCommitId = 0;
  let revoked = false;
  const [refreshFailed, setRefreshFailed] = createSignal(false);

  const invalidate = () => {
    refreshRequestId++;
    liveRefreshAbort?.abort();
    liveRefreshAbort = undefined;
    pendingLiveRecordIds = new Set();
    pendingLiveCursor = null;
    if (liveRefreshTimer) {
      clearTimeout(liveRefreshTimer);
      liveRefreshTimer = undefined;
    }
    setLivePending(false);
    setLiveRefreshing(false);
  };

  createEffect(() => {
    if (revoked) return;
    const response = recordsQuery.latest();
    if (!response) return;
    const isLiveCommit = typeof response.__liveCommitId === "number" && response.__liveCommitId === liveCommitId;
    const fetchEpoch = response.__recordsFetchEpoch ?? 0;
    if (isLiveCommit || fetchEpoch <= staleResourceEpochFloor) return;

    if (options.isGrouped()) {
      const append = didApplyFirstGroupedPage && !!options.cursor();
      didApplyFirstGroupedPage = true;
      setGroupedPage((current) => reconcileGroupedRecordsPage(current, response, append, options.source().query.limit));
      return;
    }

    const append = didApplyFirstFlatPage && !!options.cursor();
    didApplyFirstFlatPage = true;
    setFlatPage((current) => reconcileFlatRecordsPage(current, response, append, options.source().query.limit));
  });

  const items = () => (options.isGrouped() ? [] : flatPage().items);
  const buckets = () => groupedPage().buckets;
  const aggregates = () => (revoked ? {} : (recordsQuery.latest()?.aggregates ?? {}));
  const relationLabels = () =>
    revoked ? {} : options.isGrouped() ? groupedPage().relationLabels : (recordsQuery.latest()?.relationLabels ?? {});

  const replaceRecord = (record: GridRecord) => {
    if (options.isGrouped()) return;
    setFlatPage((current) => ({
      ...current,
      items: current.items.map((item) => (item.id === record.id ? record : item)),
    }));
  };

  const removeRecord = (recordId: string) => {
    if (!options.isGrouped()) {
      setFlatPage((current) => ({
        ...current,
        items: current.items.filter((record) => record.id !== recordId),
      }));
    }
    setHighlightedRecordIds((current) => {
      if (!current.has(recordId)) return current;
      const next = new Set(current);
      next.delete(recordId);
      return next;
    });
  };

  const loadNextPage = () => {
    const next = options.isGrouped() ? groupedPage().nextCursor : flatPage().nextCursor;
    if (!next || recordsQuery.data.loading) return;
    invalidate();
    requestedPage = {
      cursor: next,
      loadedCount: options.isGrouped() ? groupedPage().buckets.length : flatPage().items.length,
    };
    options.setCursor(next);
  };

  const revoke = (error: LiveProviderError) => {
    revoked = true;
    recordsQuery.cancel();
    invalidate();
    setLivePending(false);
    liveCommitId++;
    staleResourceEpochFloor = recordsQuery.fetchEpoch();
    setFlatPage({ items: [], nextCursor: null, filePreviews: {} });
    setGroupedPage({ buckets: [], nextCursor: null, relationLabels: {}, explode: false });
    recordsQuery.mutate({
      items: [],
      buckets: [],
      aggregates: {},
      nextCursor: null,
      __liveCommitId: liveCommitId,
    } as RecordsTableQueryResult);
    options.onRevoked(error);
  };

  function scheduleLiveRefresh() {
    if (revoked) return;
    setRefreshFailed(false);
    if (options.hasBlockingDialog() || liveRefreshing() || liveRefreshTimer) {
      setLivePending(true);
      return;
    }
    liveRefreshTimer = setTimeout(() => {
      liveRefreshTimer = undefined;
      if (options.hasBlockingDialog()) {
        setLivePending(true);
        return;
      }
      void refreshVisibleRecords();
    }, 250);
    setLivePending(true);
  }

  async function refreshVisibleRecords(config: { recordIds?: Iterable<string>; force?: boolean } = {}) {
    if (revoked) return;
    if (!config.force && (recordsQuery.data.loading || options.hasBlockingDialog())) {
      if (config.recordIds) {
        for (const id of config.recordIds) pendingLiveRecordIds.add(id);
      }
      setLivePending(true);
      return;
    }

    const eventRecordIds = new Set(config.recordIds ?? pendingLiveRecordIds);
    pendingLiveRecordIds = new Set();
    const cursorToApply = pendingLiveCursor;
    const previousVisibleIds = options.isGrouped() ? [] : flatPage().items.map((record) => record.id);
    const requestId = ++refreshRequestId;
    liveRefreshAbort?.abort();
    const abort = new AbortController();
    liveRefreshAbort = abort;
    setLivePending(false);
    setLiveRefreshing(true);

    try {
      const source = options.source();
      const next = options.isGrouped()
        ? await fetchVisibleGroupedRecords({
            source,
            targetCount: groupedPage().buckets.length,
            signal: abort.signal,
          })
        : await fetchVisibleFlatRecords({
            source,
            targetCount: flatPage().items.length,
            signal: abort.signal,
          });
      if (requestId !== refreshRequestId || revoked) return;

      if (!options.isGrouped()) {
        setFlatPage((current) => reconcileFlatRecordsPage(current, next, false, source.query.limit));
      } else {
        setGroupedPage((current) => reconcileGroupedRecordsPage(current, next, false, source.query.limit));
      }
      liveCommitId++;
      staleResourceEpochFloor = recordsQuery.fetchEpoch();
      recordsQuery.mutate({ ...next, __liveCommitId: liveCommitId } as RecordsTableQueryResult);
      await options.onRefreshed(next);
      if (requestId !== refreshRequestId || revoked) return;
      liveProvider?.markApplied(cursorToApply);
      if (pendingLiveCursor === cursorToApply) pendingLiveCursor = null;

      if (!options.isGrouped()) {
        const highlighted = highlightedIdsForLiveRefresh({
          eventRecordIds,
          previousVisibleIds,
          nextVisibleIds: visibleIdsFromResult(next),
        });
        if (highlighted.length > 0) {
          if (highlightTimer) clearTimeout(highlightTimer);
          setHighlightedRecordIds(new Set(highlighted));
          highlightTimer = setTimeout(() => setHighlightedRecordIds(new Set()), 1400);
        }
      }
      if (pendingLiveCursor) {
        setLivePending(true);
        scheduleLiveRefresh();
      }
    } catch (error) {
      if (abort.signal.aborted) return;
      if (error instanceof Error && "status" in error && [401, 403, 404].includes(Number(error.status))) {
        revoke({ message: error.message });
        return;
      }
      if (requestId === refreshRequestId) {
        pendingLiveRecordIds = new Set([...eventRecordIds, ...pendingLiveRecordIds]);
        setLivePending(true);
        setRefreshFailed(true);
      }
    } finally {
      if (liveRefreshAbort === abort) liveRefreshAbort = undefined;
      if (requestId === refreshRequestId) setLiveRefreshing(false);
    }
  }

  createEffect(() => {
    if (revoked || refreshFailed() || !livePending()) return;
    if (liveRefreshing() || recordsQuery.data.loading || options.hasBlockingDialog() || liveRefreshTimer) return;
    void refreshVisibleRecords();
  });

  onMount(() => {
    if (typeof document === "undefined") return;

    const drainAfterDialogClose = () => {
      requestAnimationFrame(() => {
        if (!livePending() || liveRefreshing() || recordsQuery.data.loading || options.hasBlockingDialog()) return;
        void refreshVisibleRecords();
      });
    };

    document.addEventListener("close", drainAfterDialogClose, true);
    onCleanup(() => document.removeEventListener("close", drainAfterDialogClose, true));
  });

  onMount(() => {
    liveProvider = createGridsRecordEventsProvider({
      tableId: options.tableId,
      initialCursor: options.initialEventCursor,
      locale: options.locale,
      onReady: (cursor) => {
        pendingLiveCursor = cursor;
        scheduleLiveRefresh();
      },
      onEvent: (event, cursor) => {
        if (cursor) pendingLiveCursor = cursor;
        if (!event) {
          scheduleLiveRefresh();
          return;
        }
        pendingLiveRecordIds.add(event.recordId);
        document.dispatchEvent(new CustomEvent("grids:record-live-change", { detail: event }));
        if (!options.trashMode && event.type === "record.deleted" && shouldOptimisticallyRemoveDeletedRecord(options.source().query)) {
          removeRecord(event.recordId);
          options.onOptimisticDelete(event.recordId);
        }
        scheduleLiveRefresh();
      },
      onError: (error) => {
        if (error.code === "resync_required") invalidate();
        scheduleLiveRefresh();
      },
      onRevoked: revoke,
      onFatal: (error) => {
        setLivePending(false);
        options.onFatal(error);
      },
    });

    liveProvider.connect();
    onCleanup(() => {
      liveProvider?.dispose();
      liveProvider = null;
      liveRefreshAbort?.abort();
      if (liveRefreshTimer) clearTimeout(liveRefreshTimer);
      if (highlightTimer) clearTimeout(highlightTimer);
    });
  });

  return {
    data: recordsQuery.data,
    failure: recordsQuery.failure,
    refetch: recordsQuery.refetch,
    items,
    buckets,
    aggregates,
    relationLabels,
    filePreviews: () => flatPage().filePreviews,
    nextCursor: () => (options.isGrouped() ? groupedPage().nextCursor : flatPage().nextCursor),
    livePending,
    liveRefreshing,
    highlightedRecordIds,
    invalidate,
    loadNextPage,
    refreshVisibleRecords,
    replaceRecord,
    removeRecord,
  };
};
