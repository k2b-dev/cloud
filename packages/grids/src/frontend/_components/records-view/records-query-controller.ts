import { type Accessor, createEffect, createResource, createSignal, onCleanup } from "solid-js";
import type { PublicTableQueryResult as TableQueryResult } from "../../../api/public-dto";
import type { RecordQuery } from "../../../contracts";
import { fetchTableQuery } from "./fetcher";

export type RecordsQuerySource = {
  tableId: string;
  viewId?: string;
  query: RecordQuery;
  cursor: string | null;
  filePreviewFieldIds?: string[];
  calendar: {
    view: "day" | "week" | "month" | "year";
    date: string;
  };
};

export type RecordsTableQueryResult = TableQueryResult & {
  __recordsFetchEpoch?: number;
  __liveCommitId?: number;
};

type RecordsQueryFailure = {
  error: Error;
};

const errorInstance = (error: unknown): Error => (error instanceof Error ? error : new Error("Could not load records."));

export const recordsQueryFailure = (error: unknown): RecordsQueryFailure | null => {
  if (!error || (error instanceof Error && error.name === "AbortError")) return null;
  return { error: errorInstance(error) };
};

export const createLatestRequestController = () => {
  let active: AbortController | undefined;
  return {
    start: () => {
      active?.abort();
      active = new AbortController();
      return active;
    },
    finish: (request: AbortController) => {
      if (active === request) active = undefined;
    },
    abort: () => {
      active?.abort();
      active = undefined;
    },
  };
};

type RecordsQueryControllerOptions = {
  source: Accessor<RecordsQuerySource>;
  initialValue: TableQueryResult;
  /** Message of the server's failed read of the initial source, whose `initialValue` is then empty. */
  initialError: string | null;
  prepareSource?: (source: RecordsQuerySource) => RecordsQuerySource;
};

export const createRecordsQueryController = (options: RecordsQueryControllerOptions) => {
  const requests = createLatestRequestController();
  let fetchEpoch = 0;
  const initialValue: RecordsTableQueryResult = { ...options.initialValue, __recordsFetchEpoch: 0 };
  // The initial value is the server's read of the initial source. Solid loads that source once on creation, so the
  // first load adopts the initial value instead of repeating the read and showing records that are already there
  // as loading. On the server, `ssrLoadFrom` keeps the render from reporting that load as pending.
  let adoptInitialValue = true;
  // A failed server read is adopted as well, because repeating it would fail the same way. Its failure shows until a
  // client read succeeds.
  const [initialFailure, setInitialFailure] = createSignal<RecordsQueryFailure | null>(
    options.initialError === null ? null : { error: new Error(options.initialError) },
  );

  const fetchRecords = async (source: RecordsQuerySource): Promise<RecordsTableQueryResult> => {
    const request = requests.start();
    const epoch = ++fetchEpoch;
    try {
      const result = await fetchTableQuery(options.prepareSource?.(source) ?? source, { signal: request.signal });
      setInitialFailure(null);
      return { ...result, __recordsFetchEpoch: epoch };
    } finally {
      requests.finish(request);
    }
  };

  const [data, actions] = createResource<RecordsTableQueryResult, RecordsQuerySource>(
    options.source,
    (source) => {
      if (!adoptInitialValue) return fetchRecords(source);
      adoptInitialValue = false;
      return initialValue;
    },
    { initialValue, ssrLoadFrom: "initial" },
  );
  const [latest, setLatest] = createSignal<RecordsTableQueryResult>(initialValue);

  createEffect(() => {
    const state = data.state;
    if (state !== "ready" && state !== "refreshing") return;
    const result = data();
    if (result) setLatest(result);
  });

  onCleanup(requests.abort);

  // Records pages always hydrate with SSR data, so client failures are
  // refresh failures and the last successful result remains renderable.
  const failure = () => recordsQueryFailure(data.error) ?? initialFailure();

  return {
    data,
    latest,
    failure,
    refetch: actions.refetch,
    cancel: requests.abort,
    mutate: actions.mutate,
    fetchEpoch: () => fetchEpoch,
  };
};
