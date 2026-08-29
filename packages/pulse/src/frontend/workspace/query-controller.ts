import { clipboard } from "@k2b/stdlib/browser";
import { mutation, query } from "@k2b/stdlib/solid";
import { prompts, toast } from "@k2b/ui";
import { type Accessor, createSignal, onCleanup, type Setter } from "solid-js";
import type {
  Aggregation,
  MetricQueryPoint,
  PanelVisual,
  PulseCurrentState,
  PulseExplorerQuery,
  PulseMetricSummary,
  PulseQueryCompileResult,
  PulseRecordedEvent,
  PulseResourceMetric,
  PulseSavedQuery,
} from "../../contracts";
import { defaultPulseQuery } from "../query-authoring";
import {
  currentStateQueryText,
  dashboardWidgetSnippetFromQuery,
  eventKindQueryText,
  metricSummaryQueryText,
  queryWithDimensionFilter,
  queryWithSourceFilter,
  recordedEventQueryText,
  resourceMetricQueryText,
  stateKeyQueryText,
} from "./helpers";
import { writeQueryHistory } from "./query-history";
import {
  failedQueryDiagnostics,
  queryRunApplication,
  runPulseTextQuery,
  shouldRememberQueryRun,
  shouldToastQueryError,
} from "./query-runner";
import { createPulseSavedQuery, deletePulseSavedQuery } from "./saved-query-actions";
import { openSaveQueryDialog } from "./saved-query-dialog";
import type { ExplorerResultView, QueryHistoryEntry } from "./types";
import { usePulseMessages } from "../use-messages";

type QueryControllerDeps = {
  selectedBaseId: Accessor<string>;
  metrics: Accessor<PulseMetricSummary[]>;
  queryText: Accessor<string>;
  setQueryText: Setter<string>;
  defaultQueryText: Accessor<string>;
  queryHistory: Accessor<QueryHistoryEntry[]>;
  setQueryHistory: Setter<QueryHistoryEntry[]>;
  compiledQuery: Accessor<PulseExplorerQuery | null>;
  explorerResultView: Accessor<ExplorerResultView>;
  setExplorerResultView: Setter<ExplorerResultView>;
  setSelectedMetric: Setter<string>;
  setSelectedAggregation: Setter<Aggregation>;
  setSelectedBucket: Setter<string>;
  setSelectedSince: Setter<string>;
  setSelectedQuerySourceId: Setter<string>;
  setPoints: Setter<MetricQueryPoint[]>;
  setExplorerEvents: Setter<PulseRecordedEvent[]>;
  setExplorerStates: Setter<PulseCurrentState[]>;
  setQueryDiagnostics: Setter<PulseQueryCompileResult | null>;
  setLastRunQuery: Setter<string>;
  setQueryRunning: Setter<boolean>;
  loading: Accessor<boolean>;
  setLoading: Setter<boolean>;
  refreshBaseData: () => Promise<void>;
  writeBlocked: Accessor<boolean>;
  selectedVisual: Accessor<PanelVisual>;
  browseSourceId: Accessor<string>;
  browseEntityId: Accessor<string>;
  openExplorer: () => void;
};

export const createQueryController = (deps: QueryControllerDeps) => {
  const t = usePulseMessages();
  let runId = 0;
  let disposed = false;
  const [runIntent, setRunIntent] = createSignal<{ baseId: string; query: string; requestId: number } | null>(null);
  const runQuery = query.create({
    source: runIntent,
    enabled: () => runIntent() !== null,
    load: (intent, { abortSignal }) => {
      if (!intent) throw new Error("No query run requested");
      return runPulseTextQuery(intent.baseId, intent.query, abortSignal);
    },
  });
  const saveMutation = mutation.create<PulseSavedQuery, { baseId: string; name: string; description: string | null; query: string }>({
    mutation: ({ baseId, ...input }, { abortSignal }) => createPulseSavedQuery(baseId, input, abortSignal),
  });
  const deleteMutation = mutation.create<void, PulseSavedQuery>({
    mutation: (savedQuery, { abortSignal }) => deletePulseSavedQuery(savedQuery, abortSignal),
  });
  onCleanup(() => {
    disposed = true;
    runId += 1;
    saveMutation.abort();
    deleteMutation.abort();
  });
  const reconcileSavedQueries = async (message: string): Promise<boolean> => {
    try {
      await deps.refreshBaseData();
      return !disposed;
    } catch {
      if (!disposed) toast.error(message);
      return false;
    }
  };
  const requireWritable = (): boolean => {
    if (!deps.writeBlocked()) return true;
    toast.error(t().refreshBeforeChanges);
    return false;
  };
  const current = () => deps.queryText().trim() || deps.defaultQueryText() || defaultPulseQuery(deps.metrics());

  const applyDimensionFilter = (key: string, value: string) => {
    const query = current();
    if (query) deps.setQueryText(queryWithDimensionFilter(query, key, value));
  };

  const applySourceFilter = (sourceId: string) => {
    const query = current();
    if (query) deps.setQueryText(queryWithSourceFilter(query, sourceId));
  };

  const setMetricBrowseQuery = (metric: PulseMetricSummary, dimensions: Record<string, string> = {}) =>
    deps.setQueryText(metricSummaryQueryText(metric, { sourceId: deps.browseSourceId() || null, dimensions }));

  const setEventBrowseQuery = (kind: string, sample?: PulseRecordedEvent) =>
    deps.setQueryText(
      eventKindQueryText(kind, {
        sourceId: deps.browseSourceId() || sample?.sourceId,
        entityId: deps.browseEntityId() || sample?.entityId,
      }),
    );

  const setStateBrowseQuery = (key: string, sample?: PulseCurrentState) =>
    deps.setQueryText(
      stateKeyQueryText(key, { sourceId: deps.browseSourceId() || sample?.sourceId, entityId: deps.browseEntityId() || sample?.entityId }),
    );

  const openMetricQuery = (metric: PulseResourceMetric) => {
    deps.setQueryText(resourceMetricQueryText(metric));
    deps.openExplorer();
  };
  const openEventQuery = (event: PulseRecordedEvent) => {
    deps.setQueryText(recordedEventQueryText(event));
    deps.openExplorer();
  };
  const openStateQuery = (state: PulseCurrentState) => {
    deps.setQueryText(currentStateQueryText(state));
    deps.openExplorer();
  };

  const remember = (baseId: string, query: string) => {
    const next = [{ query, ranAt: new Date().toISOString() }, ...deps.queryHistory().filter((item) => item.query !== query)].slice(0, 20);
    deps.setQueryHistory(next);
    writeQueryHistory(baseId, next);
  };

  const run = async (options: { query?: string; manual?: boolean; remember?: boolean } = {}) => {
    const baseId = deps.selectedBaseId();
    const query = options.query?.trim() || current();
    if (!baseId || !query) return;
    const requestId = ++runId;
    deps.setQueryRunning(true);
    try {
      setRunIntent({ baseId, query, requestId });
      await runQuery.refresh();
      if (disposed || requestId !== runId) return;
      if (runQuery.error()) throw runQuery.error();
      const result = runQuery.data()!;
      if (requestId !== runId) return;
      const application = queryRunApplication(deps.explorerResultView(), result);
      deps.setQueryText(query);
      if (application.metricControls) {
        deps.setSelectedMetric(application.metricControls.metric);
        deps.setSelectedAggregation(application.metricControls.aggregation);
        deps.setSelectedBucket(application.metricControls.bucket);
        deps.setSelectedSince(application.metricControls.since);
        deps.setSelectedQuerySourceId(application.metricControls.sourceId);
      } else deps.setExplorerResultView(application.nextResultView);
      deps.setPoints(application.points);
      deps.setExplorerEvents(application.events);
      deps.setExplorerStates(application.states);
      deps.setQueryDiagnostics(application.diagnostics);
      deps.setLastRunQuery(query);
      if (shouldRememberQueryRun(options)) remember(baseId, query);
    } catch (error) {
      if (requestId !== runId) return;
      const message = error instanceof Error ? error.message : t().queryFailed;
      if (shouldToastQueryError(options)) toast.error(message);
      else deps.setQueryDiagnostics(failedQueryDiagnostics(message));
    } finally {
      if (requestId === runId) deps.setQueryRunning(false);
    }
  };

  const save = async () => {
    if (!requireWritable()) return;
    const baseId = deps.selectedBaseId();
    const query = current();
    if (!baseId || !query) return;
    const result = await openSaveQueryDialog(deps.compiledQuery());
    if (disposed || !result || !requireWritable()) return;
    deps.setLoading(true);
    try {
      await saveMutation.mutate({ baseId, name: result.name, description: result.description, query });
      if (disposed) return;
      if (saveMutation.error()) throw saveMutation.error();
      if (!(await reconcileSavedQueries(t().querySavedRefreshFailed))) return;
      toast.success(t().querySaved);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().querySaveFailed);
    } finally {
      deps.setLoading(false);
    }
  };

  const copyDashboardWidget = async () => {
    const query = current();
    const compiled = deps.compiledQuery();
    if (!query || !compiled) return;
    try {
      await clipboard.copy(dashboardWidgetSnippetFromQuery(query, compiled, deps.selectedVisual()));
      if (disposed) return;
      toast.success(t().widgetDslCopied);
    } catch (error) {
      if (disposed) return;
      toast.error(error instanceof Error ? error.message : t().widgetDslCopyFailed);
    }
  };

  const removeSaved = async (query: PulseSavedQuery) => {
    if (!requireWritable()) return;
    if (
      !(await prompts.confirm(t().removeSavedQueryConfirm({ name: query.name }), { title: t().removeQuery, variant: "danger" })) ||
      disposed ||
      !requireWritable()
    )
      return;
    deps.setLoading(true);
    try {
      await deleteMutation.mutate(query);
      if (disposed) return;
      if (deleteMutation.error()) throw deleteMutation.error();
      if (!(await reconcileSavedQueries(t().queryRemovedRefreshFailed))) return;
      toast.success(t().queryRemoved);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().queryRemoveFailed);
    } finally {
      deps.setLoading(false);
    }
  };

  return {
    applyDimensionFilter,
    applySourceFilter,
    copyDashboardWidget,
    current,
    openEventQuery,
    openMetricQuery,
    openStateQuery,
    removeSaved,
    run,
    save,
    setEventBrowseQuery,
    setMetricBrowseQuery,
    setStateBrowseQuery,
  };
};
