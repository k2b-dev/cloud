import { batch, createEffect, createSignal, onCleanup, untrack, type Accessor } from "solid-js";
import type { ChartSnapshot } from "./chart-snapshot";

/** Omitted visibleKeys means no series filter; [] explicitly hides every series. */
export type ChartExplorerRequest = { step?: string; visibleKeys?: readonly string[]; referenceStep?: string };
export type ChartExplorerRow = { key: string };
export type ChartExplorerData<T extends ChartExplorerRow = ChartExplorerRow> = { chart: ChartSnapshot; rows: readonly T[] };
export type ChartExplorerCharts = Readonly<Record<string, ChartExplorerData>>;
export type ChartExplorerSnapshot<C extends ChartExplorerCharts> = { request: ChartExplorerRequest; charts: C };
export type ChartExplorerOptions<C extends ChartExplorerCharts> = {
  /** Authoritative initial/replacement data. Replacements cancel pending work. */
  snapshot: Accessor<ChartExplorerSnapshot<C>>;
  load: (
    request: ChartExplorerRequest,
    signal: AbortSignal,
  ) => ChartExplorerSnapshot<NoInfer<C>> | Promise<ChartExplorerSnapshot<NoInfer<C>>>;
  /** Optional controlled filters. Changes trigger loading; setRequest emits onRequestChange. */
  request?: Accessor<ChartExplorerRequest>;
  onRequestChange?: (request: ChartExplorerRequest) => void;
  selectedKey?: Accessor<string | null>;
  onSelectedKeyChange?: (key: string | null) => void;
};
export type ChartExplorerController<C extends ChartExplorerCharts> = ReturnType<typeof createChartExplorer<C>>;

export const sameExplorerRequest = (a: ChartExplorerRequest, b: ChartExplorerRequest) =>
  a.step === b.step &&
  a.referenceStep === b.referenceStep &&
  (a.visibleKeys === undefined || b.visibleKeys === undefined
    ? a.visibleKeys === b.visibleKeys
    : a.visibleKeys.length === b.visibleKeys.length && a.visibleKeys.every((key) => b.visibleKeys!.includes(key)));

function validateRequest(request: ChartExplorerRequest) {
  if (
    request.step === "" ||
    request.referenceStep === "" ||
    (request.referenceStep !== undefined && request.step === undefined) ||
    request.visibleKeys?.some((key) => !key) ||
    new Set(request.visibleKeys).size !== (request.visibleKeys?.length ?? 0)
  ) {
    throw new Error("Chart filters require nonempty unique keys; a reference requires a current step");
  }
}

export function validateChartExplorerData(data: ChartExplorerData) {
  const keys = data.rows.map((row) => row.key);
  const rows = new Set(keys);
  const marks = data.chart.marks.map((mark) => mark.key);
  if (
    keys.some((key) => !key) ||
    rows.size !== keys.length ||
    marks.some((key) => !key) ||
    new Set(marks).size !== marks.length ||
    data.chart.marks.some((mark) => !rows.has(mark.rowKey))
  ) {
    throw new Error("Chart data requires unique row/mark keys and a row for every mark.rowKey");
  }
}

/** One owner for one or many charts. Source/HTTP/aggregation remain caller-owned. */
export function createChartExplorer<C extends ChartExplorerCharts>(options: ChartExplorerOptions<C>) {
  if (options.request && !options.onRequestChange) throw new Error("Controlled chart filters require onRequestChange");
  if (options.selectedKey && !options.onSelectedKeyChange) throw new Error("Controlled chart selection requires onSelectedKeyChange");
  const initial = options.snapshot();
  const ids = Object.keys(initial.charts).sort();
  if (!ids.length || ids.some((id) => !id)) throw new Error("An explorer needs named charts");
  const validate = (value: ChartExplorerSnapshot<C>) => {
    validateRequest(value.request);
    const nextIds = Object.keys(value.charts).sort();
    if (nextIds.length !== ids.length || nextIds.some((id, i) => id !== ids[i])) throw new Error("Return every configured chart");
    Object.values(value.charts).forEach(validateChartExplorerData);
  };
  validate(initial);
  const [snapshot, setSnapshot] = createSignal(initial);
  const [desired, setDesired] = createSignal(options.request?.() ?? initial.request);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<Error | null>(null);
  const [localSelection, setLocalSelection] = createSignal<string | null>(null);
  const rawSelection = () => (options.selectedKey ? options.selectedKey() : localSelection());
  const hasRow = (value: ChartExplorerSnapshot<C>, key: string) =>
    Object.values(value.charts).some((data) => data.rows.some((row) => row.key === key));
  const selectedKey = () => {
    const key = rawSelection();
    return key !== null && hasRow(snapshot(), key) ? key : null;
  };
  const select = (key: string | null) => {
    if (key !== null && !hasRow(snapshot(), key)) return;
    if (!options.selectedKey) setLocalSelection(key);
    options.onSelectedKeyChange?.(key);
  };
  let pending: AbortController | undefined;
  let disposed = false;
  const adopt = (next: ChartExplorerSnapshot<C>) => {
    setSnapshot(() => next);
    const key = rawSelection();
    if (!options.selectedKey && key !== null && !hasRow(next, key)) select(null);
  };
  const execute = async (next: ChartExplorerRequest, force = false) => {
    if (disposed) return;
    validateRequest(next);
    if (!force && pending && sameExplorerRequest(next, desired())) return;
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    batch(() => {
      setDesired(next);
      setError(null);
    });
    if (!force && sameExplorerRequest(next, snapshot().request)) {
      pending = undefined;
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await options.load(next, controller.signal);
      if (controller.signal.aborted || pending !== controller) return;
      if (!sameExplorerRequest(result.request, next)) throw new Error("Chart response does not match requested filters");
      validate(result);
      batch(() => adopt(result));
    } catch (cause) {
      if (!controller.signal.aborted && pending === controller)
        setError(() => (cause instanceof Error ? cause : new Error("Could not load chart data", { cause })));
    } finally {
      if (!controller.signal.aborted && pending === controller) {
        setLoading(false);
        pending = undefined;
      }
    }
  };
  createEffect(() => {
    const next = options.snapshot();
    untrack(() => {
      validate(next);
      pending?.abort();
      pending = undefined;
      batch(() => {
        adopt(next);
        setDesired(options.request?.() ?? next.request);
        setLoading(false);
        setError(null);
      });
    });
  });
  createEffect(() => {
    options.snapshot();
    const request = options.request?.();
    if (request)
      untrack(() => {
        void execute(request);
      });
  });
  onCleanup(() => {
    disposed = true;
    pending?.abort();
  });
  const setRequest = (next: ChartExplorerRequest) => {
    validateRequest(next);
    if (!options.request) void execute(next);
    options.onRequestChange?.(next);
  };
  return {
    snapshot,
    desired,
    loading,
    error,
    selectedKey,
    select,
    setRequest,
    /** Force a fresh read of the desired filters, even when nothing changed. */
    refresh: () => execute(options.request?.() ?? desired(), true),
    retry: () => execute(options.request?.() ?? desired(), true),
    pinReference() {
      const step = snapshot().request.step;
      if (step !== undefined) setRequest({ ...desired(), referenceStep: step });
    },
    clearReference() {
      setRequest({ ...desired(), referenceStep: undefined });
    },
  };
}
