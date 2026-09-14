import { createSignal } from "solid-js";
import type {
  Aggregation,
  MetricQueryPoint,
  PanelVisual,
  PulseCurrentState,
  PulseDashboardConfig,
  PulseDashboardDslCompileResult,
  PulseQueryCompileResult,
  PulseRecordedEvent,
} from "../../contracts";
import { readQueryHistory } from "./query-history";
import { readActivityQueryState, readResourceQueryState } from "./routes";
import type { ExplorerResultView, PulseWorkspaceProps, WorkspaceView } from "./types";

export const createPulseWorkspaceState = (props: PulseWorkspaceProps) => {
  const initialBaseId = props.initialBaseId ?? props.initialBases[0]?.id ?? "";
  const initialRouteState = props.initialRouteState ?? {
    view: "resources" as const,
    dashboardId: "",
    sourceId: "",
    signalId: "",
  };
  const initialDashboardId =
    props.initialDashboards?.find((dashboard) => dashboard.id === initialRouteState.dashboardId)?.id ??
    props.initialDashboards?.[0]?.id ??
    initialRouteState.dashboardId;
  const initialActivityQuery = props.initialActivityQuery ?? readActivityQueryState(props.initialSearch ?? "");
  const initialResourceQuery = props.initialResourceQuery ?? readResourceQueryState(props.initialSearch ?? "");
  const initialFocusedSearch = new URLSearchParams(props.initialSearch ?? "").get("q")?.trim() ?? "";

  const [selectedBaseId, setSelectedBaseId] = createSignal(initialBaseId);
  const [sourceSearch, setSourceSearch] = createSignal("");
  const [resourceSearch, setResourceSearch] = createSignal(initialResourceQuery.q);
  const [resourceSourceFilter, setResourceSourceFilter] = createSignal(initialResourceQuery.sourceId);
  const [resourceTypeFilter, setResourceTypeFilter] = createSignal(initialResourceQuery.type);
  const [selectedResourceKey, setSelectedResourceKey] = createSignal(
    initialRouteState.view === "resource-detail" ? initialRouteState.signalId : (props.initialInventory?.resources[0]?.key ?? ""),
  );
  const [selectedDashboardId, setSelectedDashboardId] = createSignal(initialDashboardId);
  const [activeView] = createSignal<WorkspaceView>(initialRouteState.view);
  const [selectedMetric, setSelectedMetric] = createSignal(props.initialMetrics?.[0]?.name ?? "");
  const [selectedSourceId, setSelectedSourceId] = createSignal(initialRouteState.sourceId);
  const [selectedQuerySourceId, setSelectedQuerySourceId] = createSignal("");
  const [activitySearch, setActivitySearch] = createSignal(initialActivityQuery.q);
  const [metricTypeFilter, setMetricTypeFilter] = createSignal(initialActivityQuery.type);
  const [focusedSignalId] = createSignal(initialRouteState.signalId);
  const [focusedSearch, setFocusedSearch] = createSignal(initialFocusedSearch);
  const [selectedFocusedSeriesId, setSelectedFocusedSeriesId] = createSignal("");
  const [selectedFocusedStateId, setSelectedFocusedStateId] = createSignal("");
  const [selectedFocusedEventId, setSelectedFocusedEventId] = createSignal("");
  const [selectedSeriesId, setSelectedSeriesId] = createSignal("");
  const [selectedVisual, setSelectedVisual] = createSignal<PanelVisual>("line");
  const [selectedAggregation, setSelectedAggregation] = createSignal<Aggregation>("avg");
  const [selectedBucket, setSelectedBucket] = createSignal("5m");
  const [selectedSince, setSelectedSince] = createSignal("24h");
  const [queryText, setQueryText] = createSignal("");
  const [lastRunQuery, setLastRunQuery] = createSignal("");
  const [queryDiagnostics, setQueryDiagnostics] = createSignal<PulseQueryCompileResult | null>(null);
  const [queryHistory, setQueryHistory] = createSignal(readQueryHistory(initialBaseId));
  const [querySeeded, setQuerySeeded] = createSignal(false);
  const [querySuggestionsExpanded, setQuerySuggestionsExpanded] = createSignal(false);
  const [querySuggestionSearch, setQuerySuggestionSearch] = createSignal("");
  const [browseSearch, setBrowseSearch] = createSignal("");
  const [browseSourceId, setBrowseSourceId] = createSignal("");
  const [browseResourceKey, setBrowseResourceKey] = createSignal("");
  const [explorerResultView, setExplorerResultView] = createSignal<ExplorerResultView>("chart");
  const [points, setPoints] = createSignal<MetricQueryPoint[]>([]);
  const [explorerEvents, setExplorerEvents] = createSignal<PulseRecordedEvent[]>([]);
  const [explorerStates, setExplorerStates] = createSignal<PulseCurrentState[]>([]);
  const [queryRunning, setQueryRunning] = createSignal(false);
  const [dashboardControlValues, setDashboardControlValues] = createSignal<Record<string, Record<string, string>>>(
    initialDashboardId && Object.keys(props.initialDashboardControlValues ?? {}).length
      ? { [initialDashboardId]: props.initialDashboardControlValues ?? {} }
      : {},
  );
  const [dashboardDslText, setDashboardDslText] = createSignal("");
  const [dashboardDslDiagnostics, setDashboardDslDiagnostics] = createSignal<PulseDashboardDslCompileResult | null>(null);
  const [dashboardDslDiagnosticsText, setDashboardDslDiagnosticsText] = createSignal("");
  const [dashboardPreviewConfig, setDashboardPreviewConfig] = createSignal<PulseDashboardConfig | null>(null);
  const [dashboardDslSeededFor, setDashboardDslSeededFor] = createSignal("");
  const [dashboardDslSaving, setDashboardDslSaving] = createSignal(false);
  const [origin, setOrigin] = createSignal(props.initialOrigin ?? "");
  const [loading, setLoading] = createSignal(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = createSignal(false);

  return {
    activeView,
    activitySearch,
    browseResourceKey,
    browseSearch,
    browseSourceId,
    dashboardControlValues,
    dashboardDslDiagnostics,
    dashboardDslDiagnosticsText,
    dashboardDslSaving,
    dashboardDslSeededFor,
    dashboardDslText,
    dashboardPreviewConfig,
    explorerEvents,
    explorerResultView,
    explorerStates,
    focusedSearch,
    focusedSignalId,
    lastRunQuery,
    loading,
    metricTypeFilter,
    origin,
    points,
    queryDiagnostics,
    queryHistory,
    queryRunning,
    querySeeded,
    querySuggestionSearch,
    querySuggestionsExpanded,
    queryText,
    resourceSearch,
    resourceSourceFilter,
    resourceTypeFilter,
    selectedAggregation,
    selectedBaseId,
    selectedBucket,
    selectedDashboardId,
    selectedFocusedEventId,
    selectedFocusedSeriesId,
    selectedFocusedStateId,
    selectedMetric,
    selectedQuerySourceId,
    selectedResourceKey,
    selectedSeriesId,
    selectedSince,
    selectedSourceId,
    selectedVisual,
    setActivitySearch,
    setBrowseResourceKey,
    setBrowseSearch,
    setBrowseSourceId,
    setDashboardControlValues,
    setDashboardDslDiagnostics,
    setDashboardDslDiagnosticsText,
    setDashboardDslSaving,
    setDashboardDslSeededFor,
    setDashboardDslText,
    setDashboardPreviewConfig,
    setExplorerEvents,
    setExplorerResultView,
    setExplorerStates,
    setFocusedSearch,
    setLastRunQuery,
    setLoading,
    setMetricTypeFilter,
    setOrigin,
    setPoints,
    setQueryDiagnostics,
    setQueryHistory,
    setQueryRunning,
    setQuerySeeded,
    setQuerySuggestionSearch,
    setQuerySuggestionsExpanded,
    setQueryText,
    setResourceSearch,
    setResourceSourceFilter,
    setResourceTypeFilter,
    setSelectedAggregation,
    setSelectedBaseId,
    setSelectedBucket,
    setSelectedDashboardId,
    setSelectedFocusedEventId,
    setSelectedFocusedSeriesId,
    setSelectedFocusedStateId,
    setSelectedMetric,
    setSelectedQuerySourceId,
    setSelectedResourceKey,
    setSelectedSeriesId,
    setSelectedSince,
    setSelectedSourceId,
    setSelectedVisual,
    setSettingsDialogOpen,
    settingsDialogOpen,
    sourceSearch,
    setSourceSearch,
  };
};
