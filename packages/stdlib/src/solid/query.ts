import {
  batch,
  createEffect,
  createSignal,
  getOwner,
  onCleanup,
  onMount,
  type Accessor,
} from "solid-js";

type QueryCauseType = "source" | "refresh" | "invalidate";

type QueryCause<TInvalidation> = {
  type: QueryCauseType;
  invalidations: readonly TInvalidation[];
};

type QueryLoadContext<TInvalidation> = {
  abortSignal: AbortSignal;
  cause: QueryCause<TInvalidation>;
};

type QueryInvalidate<TInvalidation> = [TInvalidation] extends [void]
  ? (meta?: TInvalidation) => Promise<void>
  : (meta: TInvalidation) => Promise<void>;

type QuerySubscription<TInvalidation> = (controls: {
  invalidate: QueryInvalidate<TInvalidation>;
}) => void | (() => void);

type QueryInitial<TSource, TData> = {
  source: TSource;
  data: TData;
};

type QueryOptions<TSource, TData, TInvalidation = void> = {
  source: Accessor<TSource>;
  load: (
    source: TSource,
    context: QueryLoadContext<TInvalidation>,
  ) => Promise<TData>;
  initial?: QueryInitial<TSource, TData>;
  enabled?: Accessor<boolean>;
  isSameSource?: (left: TSource, right: TSource) => boolean;
  subscribe?: QuerySubscription<TInvalidation>;
};

type QueryResult<TData, TInvalidation = void> = {
  data: Accessor<TData | undefined>;
  error: Accessor<Error | null>;
  loading: Accessor<boolean>;
  refreshing: Accessor<boolean>;
  stale: Accessor<boolean>;
  refresh: () => Promise<void>;
  invalidate: QueryInvalidate<TInvalidation>;
  abort: () => void;
};

type InfiniteQueryCause<TInvalidation> =
  | QueryCause<TInvalidation>
  | { type: "load-more"; invalidations: readonly [] };

type InfiniteQueryLoadContext<TCursor, TInvalidation> = {
  cursor: TCursor | undefined;
  abortSignal: AbortSignal;
  cause: InfiniteQueryCause<TInvalidation>;
};

type InfiniteQueryInitial<TSource, TPage> = {
  source: TSource;
  pages: readonly TPage[];
};

type InfiniteQueryOptions<
  TSource,
  TPage,
  TCursor,
  TInvalidation = void,
> = {
  source: Accessor<TSource>;
  loadPage: (
    source: TSource,
    context: InfiniteQueryLoadContext<TCursor, TInvalidation>,
  ) => Promise<TPage>;
  getNextCursor: (page: TPage) => TCursor | null | undefined;
  initial?: InfiniteQueryInitial<TSource, TPage>;
  enabled?: Accessor<boolean>;
  isSameSource?: (left: TSource, right: TSource) => boolean;
  subscribe?: QuerySubscription<TInvalidation>;
};

type InfiniteQueryResult<TPage, TInvalidation = void> = {
  pages: Accessor<readonly TPage[]>;
  error: Accessor<Error | null>;
  loading: Accessor<boolean>;
  refreshing: Accessor<boolean>;
  loadingMore: Accessor<boolean>;
  stale: Accessor<boolean>;
  hasMore: Accessor<boolean>;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
  invalidate: QueryInvalidate<TInvalidation>;
  abort: () => void;
};

const normalizeError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const abortError = (message: string): Error => {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
};

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError";

const reasonPriority: Record<QueryCauseType, number> = {
  invalidate: 1,
  refresh: 2,
  source: 3,
};

type PendingInvalidation<TInvalidation> = {
  id: number;
  meta: TInvalidation;
  resolve: () => void;
  reject: (error: Error) => void;
};

type RefreshBatch = {
  promise: Promise<void>;
  resolve: () => void;
};

type ActiveRequest<TInvalidation> = {
  controller: AbortController;
  coveredInvalidationIds: readonly number[];
  refreshBatch: RefreshBatch | null;
  cause: QueryCause<TInvalidation>;
};

type QueryKernelOptions<TSource, TData, TInvalidation> = Omit<
  QueryOptions<TSource, TData, TInvalidation>,
  "initial"
> & {
  initial?: {
    source: TSource;
    data: () => TData;
  };
  onExternalInterrupt?: () => void;
};

type QueryKernel<TSource, TData, TInvalidation> = QueryResult<
  TData,
  TInvalidation
> & {
  currentSource: () => TSource;
  sourceGeneration: () => number;
  isEnabled: () => boolean;
  isMounted: () => boolean;
  isCanonicalActive: () => boolean;
  peek: () => { hasData: boolean; data: TData | undefined };
  commitExternal: (
    sourceGeneration: number,
    update: (current: TData) => TData,
  ) => boolean;
  beginExternal: (sourceGeneration: number) => boolean;
  failExternal: (sourceGeneration: number, error: unknown) => void;
};

const createKernel = <TSource, TData, TInvalidation = void>(
  options: QueryKernelOptions<TSource, TData, TInvalidation>,
): QueryKernel<TSource, TData, TInvalidation> => {
  if (!getOwner()) {
    throw new Error("query.create() must be called inside a SolidJS reactive owner");
  }

  const sameSource = options.isSameSource ?? Object.is;
  const initialSource = options.source();
  const initialMatches =
    options.initial !== undefined &&
    sameSource(options.initial.source, initialSource);
  const initialData = initialMatches ? options.initial?.data() : undefined;
  const initiallyEnabled = options.enabled?.() ?? true;

  const [data, setData] = createSignal<TData | undefined>(
    initialData,
  );
  const [error, setError] = createSignal<Error | null>(null);
  const [loading, setLoading] = createSignal(
    !initialMatches && initiallyEnabled,
  );
  const [refreshing, setRefreshing] = createSignal(false);
  const [stale, setStale] = createSignal(false);

  let disposed = false;
  let mounted = false;
  let currentSource = initialSource;
  let currentSourceGeneration = 0;
  let currentEnabled = initiallyEnabled;
  let hasData = initialMatches;
  let hasCommittedCurrentSource = initialMatches;
  let failedWithLastGoodData = false;
  let nextInvalidationId = 0;
  let activeRequest: ActiveRequest<TInvalidation> | null = null;
  let refreshBatch: RefreshBatch | null = null;
  let queuedReason: QueryCauseType | null = initialMatches ? null : "source";
  let loadScheduled = false;
  const invalidations = new Map<
    number,
    PendingInvalidation<TInvalidation>
  >();

  const writeData = (value: TData) => setData(() => value);

  const syncStale = () => {
    setStale(
      (hasData && !hasCommittedCurrentSource) ||
        invalidations.size > 0 ||
        failedWithLastGoodData,
    );
  };

  const resolveRefreshBatch = (batch: RefreshBatch | null) => {
    if (!batch || refreshBatch !== batch) return;
    refreshBatch = null;
    batch.resolve();
  };

  const rejectInvalidations = (
    ids: Iterable<number>,
    rejection: Error,
  ) => {
    for (const id of ids) {
      const pending = invalidations.get(id);
      if (!pending) continue;
      invalidations.delete(id);
      pending.reject(rejection);
    }
  };

  const resolveInvalidations = (ids: Iterable<number>) => {
    for (const id of ids) {
      const pending = invalidations.get(id);
      if (!pending) continue;
      invalidations.delete(id);
      pending.resolve();
    }
  };

  const rejectAllInvalidations = (rejection: Error) => {
    rejectInvalidations([...invalidations.keys()], rejection);
  };

  const cancelActive = (rejectCovered: boolean, message: string) => {
    const request = activeRequest;
    if (!request) return;
    activeRequest = null;
    request.controller.abort();
    if (rejectCovered) {
      rejectInvalidations(
        request.coveredInvalidationIds,
        abortError(message),
      );
      resolveRefreshBatch(request.refreshBatch);
      failedWithLastGoodData ||=
        hasData && request.coveredInvalidationIds.length > 0;
    }
    batch(() => {
      setLoading(false);
      setRefreshing(false);
      if (rejectCovered) syncStale();
    });
  };

  const mergeQueuedReason = (reason: QueryCauseType) => {
    if (
      !queuedReason ||
      reasonPriority[reason] > reasonPriority[queuedReason]
    ) {
      queuedReason = reason;
    }
  };

  const scheduleQueuedLoad = () => {
    if (
      disposed ||
      !mounted ||
      !currentEnabled ||
      activeRequest ||
      loadScheduled ||
      !queuedReason
    ) {
      return;
    }
    loadScheduled = true;
    queueMicrotask(() => {
      loadScheduled = false;
      if (
        disposed ||
        !mounted ||
        !currentEnabled ||
        activeRequest ||
        !queuedReason
      ) {
        return;
      }
      const reason = queuedReason;
      queuedReason = null;
      startCanonical(reason);
    });
  };

  const queueLoad = (reason: QueryCauseType) => {
    mergeQueuedReason(reason);
    scheduleQueuedLoad();
  };

  const finishRequest = (request: ActiveRequest<TInvalidation>) => {
    if (activeRequest !== request) return;
    activeRequest = null;
    scheduleQueuedLoad();
    batch(() => {
      setLoading(false);
      setRefreshing(false);
      syncStale();
    });
  };

  const startCanonical = (reason: QueryCauseType) => {
    if (disposed || !currentEnabled) {
      queueLoad(reason);
      return;
    }

    const source = currentSource;
    const coveredInvalidations = [...invalidations.values()];
    const coveredRefreshBatch = refreshBatch;
    const controller = new AbortController();
    const request: ActiveRequest<TInvalidation> = {
      controller,
      coveredInvalidationIds: coveredInvalidations.map((pending) => pending.id),
      refreshBatch: coveredRefreshBatch,
      cause: {
        type: reason,
        invalidations: coveredInvalidations.map((pending) => pending.meta),
      },
    };

    const run = async () => {
      let result: TData;
      try {
        result = await options.load(source, {
          abortSignal: controller.signal,
          cause: request.cause,
        });
      } catch (caught) {
        if (activeRequest !== request) return;
        if (controller.signal.aborted || isAbortError(caught)) {
          rejectInvalidations(
            request.coveredInvalidationIds,
            abortError("Query request was aborted"),
          );
          resolveRefreshBatch(request.refreshBatch);
          failedWithLastGoodData ||=
            hasData && request.coveredInvalidationIds.length > 0;
          finishRequest(request);
          return;
        }
        const normalized = normalizeError(caught);
        rejectInvalidations(request.coveredInvalidationIds, normalized);
        resolveRefreshBatch(request.refreshBatch);
        failedWithLastGoodData = hasData;
        batch(() => {
          setError(normalized);
          finishRequest(request);
        });
        return;
      }
      if (activeRequest !== request || controller.signal.aborted) return;

      // Update internal state before signals: computations that read the data
      // run during the batch, and an error they throw belongs to the consumer.
      hasData = true;
      hasCommittedCurrentSource = true;
      failedWithLastGoodData = false;
      resolveInvalidations(request.coveredInvalidationIds);
      resolveRefreshBatch(request.refreshBatch);
      batch(() => {
        writeData(result);
        finishRequest(request);
      });
    };

    // Internal state changes inside a batch apply immediately; computations
    // reading the signals run when it ends. Start the load even if one throws.
    try {
      batch(() => {
        cancelActive(false, "Query request was superseded");
        options.onExternalInterrupt?.();
        activeRequest = request;
        setError(null);
        setLoading(!hasData);
        setRefreshing(hasData);
      });
    } finally {
      void run();
    }
  };

  const invalidateImplementation = (
    meta?: TInvalidation,
  ): Promise<void> => {
    if (disposed) {
      return Promise.reject(abortError("Query owner was disposed"));
    }
    const id = ++nextInvalidationId;
    const promise = new Promise<void>((resolve, reject) => {
      invalidations.set(id, {
        id,
        meta: meta as TInvalidation,
        resolve,
        reject,
      });
    });
    queueLoad("invalidate");
    syncStale();
    return promise;
  };
  const invalidate = invalidateImplementation as QueryInvalidate<TInvalidation>;

  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (refreshBatch) {
      return refreshBatch.promise;
    }

    let resolve!: () => void;
    const promise = new Promise<void>((nextResolve) => {
      resolve = nextResolve;
    });
    refreshBatch = {
      promise,
      resolve,
    };

    if (mounted && currentEnabled) {
      queuedReason = null;
      startCanonical("refresh");
    } else {
      queueLoad("refresh");
    }
    return promise;
  };

  const abort = () => {
    batch(() => {
      queuedReason = null;
      cancelActive(true, "Query request was aborted");
      rejectAllInvalidations(abortError("Query request was aborted"));
      resolveRefreshBatch(refreshBatch);
      setLoading(false);
      setRefreshing(false);
      syncStale();
    });
  };

  createEffect(() => {
    const nextSource = options.source();
    const nextEnabled = options.enabled?.() ?? true;
    const sourceChanged = !sameSource(currentSource, nextSource);
    currentSource = nextSource;

    if (sourceChanged) {
      currentSourceGeneration += 1;
      queuedReason = null;
      options.onExternalInterrupt?.();
      cancelActive(false, "Query source changed");
      rejectAllInvalidations(abortError("Query source changed"));
      resolveRefreshBatch(refreshBatch);
      hasCommittedCurrentSource = false;
      failedWithLastGoodData = false;
      setError(null);
      syncStale();
      mergeQueuedReason("source");
    }

    if (currentEnabled !== nextEnabled) {
      currentEnabled = nextEnabled;
      if (!nextEnabled) {
        const interruptedReason = activeRequest?.cause.type;
        options.onExternalInterrupt?.();
        cancelActive(false, "Query was paused");
        if (interruptedReason) mergeQueuedReason(interruptedReason);
        if (invalidations.size > 0) mergeQueuedReason("invalidate");
        if (refreshBatch) mergeQueuedReason("refresh");
      }
    }

    scheduleQueuedLoad();
  });

  let subscriptionCleanup: void | (() => void);
  onMount(() => {
    mounted = true;
    subscriptionCleanup = options.subscribe?.({ invalidate });
    scheduleQueuedLoad();
  });

  onCleanup(() => {
    disposed = true;
    queuedReason = null;
    options.onExternalInterrupt?.();
    cancelActive(false, "Query owner was disposed");
    rejectAllInvalidations(abortError("Query owner was disposed"));
    resolveRefreshBatch(refreshBatch);
    if (typeof subscriptionCleanup === "function") subscriptionCleanup();
  });

  return {
    data,
    error,
    loading,
    refreshing,
    stale,
    refresh,
    invalidate,
    abort,
    currentSource: () => currentSource,
    sourceGeneration: () => currentSourceGeneration,
    isEnabled: () => currentEnabled,
    isMounted: () => mounted,
    isCanonicalActive: () => activeRequest !== null,
    peek: () => ({ hasData, data: data() }),
    commitExternal: (sourceGeneration, update) => {
      if (
        disposed ||
        activeRequest ||
        sourceGeneration !== currentSourceGeneration ||
        !currentEnabled ||
        !hasData
      ) {
        return false;
      }
      writeData(update(data() as TData));
      setError(null);
      return true;
    },
    beginExternal: (sourceGeneration) => {
      if (
        disposed ||
        activeRequest ||
        sourceGeneration !== currentSourceGeneration ||
        !currentEnabled
      ) {
        return false;
      }
      setError(null);
      return true;
    },
    failExternal: (sourceGeneration, caught) => {
      if (
        disposed ||
        activeRequest ||
        sourceGeneration !== currentSourceGeneration ||
        isAbortError(caught)
      ) {
        return;
      }
      setError(normalizeError(caught));
    },
  };
};

const create = <TSource, TData, TInvalidation = void>(
  options: QueryOptions<TSource, TData, TInvalidation>,
): QueryResult<TData, TInvalidation> => {
  const kernel = createKernel({
    ...options,
    initial: options.initial
      ? {
          source: options.initial.source,
          data: () => options.initial!.data,
        }
      : undefined,
  });
  return {
    data: kernel.data,
    error: kernel.error,
    loading: kernel.loading,
    refreshing: kernel.refreshing,
    stale: kernel.stale,
    refresh: kernel.refresh,
    invalidate: kernel.invalidate,
    abort: kernel.abort,
  };
};

type InfiniteSnapshot<TPage, TCursor> = {
  pages: readonly TPage[];
  nextCursor: TCursor | undefined;
};

const normalizedCursor = <TCursor>(
  cursor: TCursor | null | undefined,
): TCursor | undefined => (cursor == null ? undefined : cursor);

const createInfinite = <
  TSource,
  TPage,
  TCursor,
  TInvalidation = void,
>(
  options: InfiniteQueryOptions<
    TSource,
    TPage,
    TCursor,
    TInvalidation
  >,
): InfiniteQueryResult<TPage, TInvalidation> => {
  let cancelLoadMore = () => {};
  let kernel!: QueryKernel<
    TSource,
    InfiniteSnapshot<TPage, TCursor>,
    TInvalidation
  >;

  const initial = options.initial
    ? {
        source: options.initial.source,
        data: (): InfiniteSnapshot<TPage, TCursor> => ({
          pages: [...options.initial!.pages],
          nextCursor: normalizedCursor(
            options.initial!.pages.length > 0
              ? options.getNextCursor(options.initial!.pages.at(-1)!)
              : undefined,
          ),
        }),
      }
    : undefined;

  kernel = createKernel<
    TSource,
    InfiniteSnapshot<TPage, TCursor>,
    TInvalidation
  >({
    source: options.source,
    initial,
    enabled: options.enabled,
    isSameSource: options.isSameSource,
    subscribe: options.subscribe,
    onExternalInterrupt: () => cancelLoadMore(),
    load: async (source, context) => {
      const current = kernel.peek();
      const targetPageCount =
        context.cause.type === "source"
          ? 1
          : Math.max(current.hasData ? current.data!.pages.length : 0, 1);
      const pages: TPage[] = [];
      let cursor: TCursor | undefined;

      for (let index = 0; index < targetPageCount; index++) {
        const page = await options.loadPage(source, {
          cursor,
          abortSignal: context.abortSignal,
          cause: context.cause,
        });
        pages.push(page);
        cursor = normalizedCursor(options.getNextCursor(page));
        if (cursor === undefined) break;
      }

      return { pages, nextCursor: cursor };
    },
  });

  const emptyPages: readonly TPage[] = [];
  const [loadingMore, setLoadingMore] = createSignal(false);
  let activeLoadMore:
    | {
        controller: AbortController;
        promise: Promise<void>;
        resolve: () => void;
      }
    | null = null;

  cancelLoadMore = () => {
    const request = activeLoadMore;
    if (!request) return;
    activeLoadMore = null;
    request.controller.abort();
    request.resolve();
    setLoadingMore(false);
  };

  const loadMore = (): Promise<void> => {
    if (activeLoadMore) return activeLoadMore.promise;
    const snapshot = kernel.peek();
    if (
      !snapshot.hasData ||
      snapshot.data?.nextCursor === undefined ||
      kernel.isCanonicalActive() ||
      !kernel.isMounted() ||
      !kernel.isEnabled()
    ) {
      return Promise.resolve();
    }

    const sourceGeneration = kernel.sourceGeneration();
    if (!kernel.beginExternal(sourceGeneration)) return Promise.resolve();
    const source = kernel.currentSource();
    const cursor = snapshot.data.nextCursor;
    const controller = new AbortController();
    let resolve!: () => void;
    const promise = new Promise<void>((nextResolve) => {
      resolve = nextResolve;
    });
    const request = { controller, promise, resolve };
    activeLoadMore = request;

    // Settle the request before the batch so a consumer error thrown by a
    // computation reading pages() cannot leave loadMore() pending.
    const settle = (write: () => void) => {
      activeLoadMore = null;
      resolve();
      batch(() => {
        write();
        setLoadingMore(false);
      });
    };

    const run = async () => {
      let page: TPage;
      let nextCursor: TCursor | undefined;
      try {
        page = await options.loadPage(source, {
          cursor,
          abortSignal: controller.signal,
          cause: { type: "load-more", invalidations: [] },
        });
        if (activeLoadMore !== request || controller.signal.aborted) return;
        nextCursor = normalizedCursor(options.getNextCursor(page));
      } catch (caught) {
        if (activeLoadMore !== request || controller.signal.aborted) return;
        settle(() => kernel.failExternal(sourceGeneration, caught));
        return;
      }
      settle(() =>
        kernel.commitExternal(sourceGeneration, (current) => ({
          pages: [...current.pages, page],
          nextCursor,
        })),
      );
    };

    // Start the page load even if a computation reading loadingMore() throws.
    try {
      setLoadingMore(true);
    } finally {
      void run();
    }

    return promise;
  };

  return {
    pages: () => kernel.data()?.pages ?? emptyPages,
    error: kernel.error,
    loading: kernel.loading,
    refreshing: kernel.refreshing,
    stale: kernel.stale,
    refresh: kernel.refresh,
    invalidate: kernel.invalidate,
    abort: () =>
      batch(() => {
        cancelLoadMore();
        kernel.abort();
      }),
    loadingMore,
    hasMore: () => kernel.data()?.nextCursor !== undefined,
    loadMore,
  };
};

export const query = {
  create,
  createInfinite,
} as const;

export type {
  InfiniteQueryCause,
  InfiniteQueryInitial,
  InfiniteQueryLoadContext,
  InfiniteQueryOptions,
  InfiniteQueryResult,
  QueryCause,
  QueryInitial,
  QueryInvalidate,
  QueryLoadContext,
  QueryOptions,
  QueryResult,
  QuerySubscription,
};
