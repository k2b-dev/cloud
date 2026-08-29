import { prompts } from "@k2b/ui";
import { type Accessor, createEffect, createMemo, createSignal, onCleanup, type Setter } from "solid-js";
import { apiClient } from "../../../api/client";
import type { PublicGridRecord as GridRecord, PublicTableQueryResult as TableQueryResult } from "../../../api/public-dto";
import { errorMessage } from "../utils/api-helpers";
import type { PublicWorkspaceRecordDetail as WorkspaceRecordDetail } from "../workspace/workspace-public-state-model";
import { visibleIdsFromResult } from "./live-refresh";
import { recordsViewMessages } from "./messages";

type RecordsSelectionControllerOptions = {
  tableId: string;
  activeViewId?: string;
  mode: Accessor<"live" | "trash">;
  items: Accessor<GridRecord[]>;
  selectedRecordId: Accessor<string | null>;
  setSelectedRecordId: Setter<string | null>;
  initialRecord: GridRecord | null;
  initialDetail: WorkspaceRecordDetail | null;
  syncUrl: (options: { replace: boolean }) => void;
  locale?: Accessor<string>;
};

const emptyDetail = (recordId: string): WorkspaceRecordDetail => ({
  recordId,
  relationLabels: {},
  filesByField: {},
  documents: { items: [], cursor: null, hasMore: false },
  snapshots: [],
  auditEntries: [],
  combinedOrigin: null,
});

export const createRecordsSelectionController = (options: RecordsSelectionControllerOptions) => {
  const t = () => recordsViewMessages.resolve([options.locale?.() ?? "en"]).t;
  const [fetchedRecord, setFetchedRecord] = createSignal<GridRecord | null>(null);
  const [detail, setDetail] = createSignal<WorkspaceRecordDetail | null>(options.initialDetail);
  const [failure, setFailure] = createSignal<Error | null>(null);
  const [loadAttempt, setLoadAttempt] = createSignal(0);

  const record = createMemo<GridRecord | null>(() => {
    const id = options.selectedRecordId();
    if (!id) return null;
    const fetched = fetchedRecord();
    return (
      options.items().find((item) => item.id === id) ??
      (options.initialRecord?.id === id ? options.initialRecord : null) ??
      (fetched?.id === id ? fetched : null)
    );
  });

  const clearState = () => {
    setFetchedRecord(null);
    setDetail(null);
    setFailure(null);
  };

  const close = () => {
    options.setSelectedRecordId(null);
    clearState();
    options.syncUrl({ replace: true });
  };

  const loadDetail = async (recordId: string, signal?: AbortSignal): Promise<WorkspaceRecordDetail> => {
    const response = await apiClient.workspace["record-detail"].$get(
      {
        query: {
          tableId: options.tableId,
          recordId,
          ...(options.activeViewId ? { viewId: options.activeViewId } : {}),
          ...(options.mode() === "trash" ? { deletedOnly: "true" as const } : {}),
        },
      },
      signal ? { init: { signal } } : undefined,
    );
    if (response.status === 403 || response.status === 404) return emptyDetail(recordId);
    if (!response.ok) throw new Error(await errorMessage(response, t().loadRecordDetailsFailed));
    return response.json();
  };

  createEffect(() => {
    const recordId = options.selectedRecordId();
    const currentDetail = detail();
    if (!recordId || currentDetail?.recordId === recordId) return;
    if (currentDetail) {
      setDetail(null);
      return;
    }
    const abort = new AbortController();
    onCleanup(() => abort.abort());
    void loadDetail(recordId, abort.signal)
      .then((next) => {
        if (options.selectedRecordId() === recordId) setDetail(next);
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) prompts.error(error instanceof Error ? error.message : t().loadRecordDetailsFailed);
      });
  });

  createEffect(() => {
    loadAttempt();
    const recordId = options.selectedRecordId();
    if (!recordId) {
      clearState();
      return;
    }
    if (record()) {
      setFailure(null);
      return;
    }

    const abort = new AbortController();
    onCleanup(() => abort.abort());
    setFailure(null);
    void apiClient.records[":tableId"][":recordId"]
      .$get(
        {
          param: { tableId: options.tableId, recordId },
          query: options.mode() === "trash" ? { deletedOnly: "true" } : {},
        },
        { init: { signal: abort.signal } },
      )
      .then(async (response) => {
        if (response.status === 403 || response.status === 404) {
          if (options.selectedRecordId() === recordId) close();
          return;
        }
        if (!response.ok) throw new Error(await errorMessage(response, t().loadRecordFailed));
        const next = await response.json();
        if (options.selectedRecordId() === recordId) setFetchedRecord(() => next);
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted || options.selectedRecordId() !== recordId) return;
        setFailure(error instanceof Error ? error : new Error(t().loadRecordFailedFallback));
      });
  });

  const verifyAfterRefresh = async (result: TableQueryResult) => {
    const recordId = options.selectedRecordId();
    if (!recordId || visibleIdsFromResult(result).includes(recordId)) return;
    const response = await apiClient.records[":tableId"][":recordId"].$get({
      param: { tableId: options.tableId, recordId },
      query: options.mode() === "trash" ? { deletedOnly: "true" } : {},
    });
    if (options.selectedRecordId() !== recordId) return;
    if (response.ok) {
      const next = await response.json();
      if (options.selectedRecordId() === recordId) setFetchedRecord(() => next);
      return;
    }
    if (response.status === 403 || response.status === 404) close();
  };

  const selectRecord = (next: GridRecord) => {
    if (detail()?.recordId !== next.id) setDetail(null);
    setFetchedRecord(() => next);
    options.setSelectedRecordId(next.id);
    options.syncUrl({ replace: false });
  };

  const openRecord = (recordId: string) => {
    clearState();
    options.setSelectedRecordId(recordId);
    options.syncUrl({ replace: false });
  };

  const refreshDetail = async (recordId: string) => {
    try {
      setDetail(await loadDetail(recordId));
    } catch (error) {
      prompts.error(error instanceof Error ? error.message : t().refreshRecordDetailsFailed);
    }
  };

  return {
    record,
    detail,
    failure,
    close,
    clearState,
    selectRecord,
    openRecord,
    setFetchedRecord,
    setDetail,
    retry: () => setLoadAttempt((attempt) => attempt + 1),
    refreshDetail,
    verifyAfterRefresh,
  };
};
