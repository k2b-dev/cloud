import { type Aggregation, isEventAggregateQuery, type PulseExplorerQuery, type PulseQueryCompileResult } from "../../contracts";
import { jsonFetch } from "./helpers";
import type { ExplorerResultView, MetricTextQueryResult } from "./types";

type MetricQueryControls = {
  aggregation: Aggregation;
  bucket: string;
  metric: string;
  since: string;
  sourceId: string;
};

export const runPulseTextQuery = async (baseId: string, query: string, signal?: AbortSignal): Promise<MetricTextQueryResult> =>
  jsonFetch<MetricTextQueryResult>("/api/pulse/query/metric-text", {
    method: "POST",
    body: JSON.stringify({ baseId, query }),
    signal,
  });

export const metricControlsFromQuery = (compiled: PulseExplorerQuery): MetricQueryControls | null => {
  if (compiled.kind !== "metric" || !compiled.since) return null;
  return {
    aggregation: compiled.aggregation,
    bucket: compiled.bucket,
    metric: compiled.metric,
    since: compiled.since,
    sourceId: compiled.sourceId ?? "",
  };
};

export const explorerResultViewAfterQuery = (currentView: ExplorerResultView, compiled: PulseExplorerQuery): ExplorerResultView => {
  if (compiled.kind === "metric" || (compiled.kind === "events" && isEventAggregateQuery(compiled))) return currentView;
  return currentView === "chart" ? "table" : currentView;
};

export const queryRunApplication = (currentView: ExplorerResultView, result: MetricTextQueryResult) => ({
  diagnostics: validQueryDiagnostics(result.compiled),
  events: result.events,
  metricControls: metricControlsFromQuery(result.compiled),
  nextResultView: explorerResultViewAfterQuery(currentView, result.compiled),
  points: result.points,
  states: result.states,
});

export const validQueryDiagnostics = (compiled: PulseExplorerQuery): PulseQueryCompileResult => ({
  ok: true,
  diagnostics: [{ severity: "info", message: "Query is valid." }],
  compiled,
});

export const failedQueryDiagnostics = (message: string): PulseQueryCompileResult => ({
  ok: false,
  diagnostics: [{ severity: "error", message }],
  compiled: null,
});

export const shouldRememberQueryRun = (options: { manual?: boolean; remember?: boolean }): boolean =>
  options.remember ?? options.manual ?? true;

export const shouldToastQueryError = (options: { manual?: boolean }): boolean => options.manual ?? true;
