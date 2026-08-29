import { clipboard } from "@k2b/stdlib/browser";
import { AppWorkspace, Button, NoticeCard, Panes, type PanesLayout, toast } from "@k2b/ui";
import { createEffect, createSignal, on, Show, untrack } from "solid-js";
import type { MetricType, PulseDashboard, PulseDashboardConfig, PulseResourceSummary, PulseSource } from "../contracts";
import { createBaseController } from "./workspace/base-controller";
import DashboardEditorView from "./workspace/DashboardEditorView";
import DashboardView, { type DashboardRenderContext } from "./workspace/DashboardView";
import { createDashboardController } from "./workspace/dashboard-controller";
import FocusedSignalView, { FocusedSignalDetail } from "./workspace/FocusedSignalView";
import { eventKindQueryText, metricSummaryQueryText, openQueryReferenceWindow, stateKeyQueryText } from "./workspace/helpers";
import { navigatePulseWorkspace, replacePulseWorkspaceUrl } from "./workspace/navigation";
import { installNearRealtimeController } from "./workspace/near-realtime-controller";
import PulseSidebar from "./workspace/PulseSidebar";
import {
  createQueryExplorerPanesLayout,
  initialPulsePanesLayout,
  persistPulsePanesLayout,
  QUERY_EXPLORER_ITEM_IDS,
  QUERY_EXPLORER_PANES_KEY,
} from "./workspace/panes-state";
import { QueryHistoryPane, SavedQueriesPane } from "./workspace/QueryExplorerAuxPanes";
import QueryExplorerBrowsePane from "./workspace/QueryExplorerBrowsePane";
import QueryExplorerEditorPane from "./workspace/QueryExplorerEditorPane";
import QueryExplorerResultPane from "./workspace/QueryExplorerResultPane";
import { createQueryController } from "./workspace/query-controller";
import ResourceBrowserView from "./workspace/ResourceBrowserView";
import ResourceDetailView, { createResourceDetailSelection, ResourceSignalDetail } from "./workspace/ResourceDetailView";
import { signalCatalogKindForView } from "./workspace/SignalCatalogChrome";
import SignalCatalogView from "./workspace/SignalCatalogView";
import SourcesView, { SourcesDetailPanel } from "./workspace/SourcesView";
import { createSignalTableCellRenderers } from "./workspace/signal-table-cells";
import { createSourceController } from "./workspace/source-controller";
import {
  eventColumns,
  eventGroupColumns,
  metricColumns,
  metricSeriesColumns,
  stateColumns,
  stateGroupColumns,
} from "./workspace/table-columns";
import type { PulseWorkspaceProps, WorkspaceView } from "./workspace/types";
import { createWorkspaceDerivedModel } from "./workspace/workspace-derived-model";
import { installWorkspaceEffects } from "./workspace/workspace-effects";
import { createPulseWorkspaceQueries } from "./workspace/workspace-queries";
import { createPulseWorkspaceState } from "./workspace/workspace-state";
import { usePulseMessages } from "./use-messages";

export default function PulseWorkspace(props: PulseWorkspaceProps) {
  const t = usePulseMessages();
  const localState = createPulseWorkspaceState(props);
  let selectedSourceKind = () => props.initialSources?.find((source) => source.id === localState.selectedSourceId())?.kind ?? null;
  const queryState = createPulseWorkspaceQueries(props, {
    activeView: localState.activeView,
    activitySearch: localState.activitySearch,
    dashboardControlValues: localState.dashboardControlValues,
    dashboardPreviewConfig: localState.dashboardPreviewConfig,
    focusedSearch: localState.focusedSearch,
    focusedSignalId: localState.focusedSignalId,
    metricTypeFilter: localState.metricTypeFilter,
    resourceSearch: localState.resourceSearch,
    resourceSourceFilter: localState.resourceSourceFilter,
    resourceTypeFilter: localState.resourceTypeFilter,
    selectedBaseId: localState.selectedBaseId,
    selectedDashboardId: localState.selectedDashboardId,
    selectedMetric: localState.selectedMetric,
    selectedQuerySourceId: localState.selectedQuerySourceId,
    selectedResourceKey: localState.selectedResourceKey,
    selectedSourceId: localState.selectedSourceId,
    selectedSourceKind: () => selectedSourceKind(),
  });
  selectedSourceKind = () => queryState.sources().find((source) => source.id === localState.selectedSourceId())?.kind ?? null;
  const state = { ...localState, ...queryState };
  let missingBaseNavigationStarted = false;
  createEffect(
    on(
      queryState.queries.bases.data,
      (nextBases) => {
        const currentBaseId = untrack(localState.selectedBaseId);
        if (!nextBases || !currentBaseId || nextBases.some((base) => base.id === currentBaseId) || missingBaseNavigationStarted) return;
        missingBaseNavigationStarted = true;
        navigatePulseWorkspace({ baseId: nextBases[0]?.id ?? "", state: { view: "resources" } });
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      queryState.baseData,
      (data) => {
        if (!data) return;
        untrack(() => {
          localState.setSelectedResourceKey((current) =>
            current && data.inventory.resources.some((resource) => resource.key === current)
              ? current
              : (data.inventory.resources[0]?.key ?? ""),
          );
          localState.setSelectedMetric((current) =>
            current && data.metrics.some((metric) => metric.name === current) ? current : (data.metrics[0]?.name ?? ""),
          );
          localState.setSelectedSourceId((current) => (current && !data.sources.some((source) => source.id === current) ? "" : current));
          localState.setSelectedDashboardId(
            (current) => data.dashboards.find((dashboard) => dashboard.id === current)?.id ?? data.dashboards[0]?.id ?? "",
          );
        });
      },
      { defer: true },
    ),
  );
  const [explorerPanesLayout, setExplorerPanesLayout] = createSignal(
    initialPulsePanesLayout(props.initialExplorerPanesLayout, createQueryExplorerPanesLayout(), QUERY_EXPLORER_ITEM_IDS),
  );
  const updateExplorerPanesLayout = (layout: PanesLayout) => {
    setExplorerPanesLayout(layout);
    persistPulsePanesLayout(QUERY_EXPLORER_PANES_KEY, layout);
  };
  const {
    activeView,
    activityMetrics,
    activitySearch,
    bases,
    browseEntityId,
    browseSearch,
    browseSourceId,
    dashboardControlValues,
    dashboardDslDiagnostics,
    dashboardDslDiagnosticsText,
    dashboardDslSaving,
    dashboardDslSeededFor,
    dashboardDslText,
    dashboardEvents,
    dashboardMaps,
    dashboardPreviewConfig,
    dashboards,
    dashboardStates,
    explorerEvents,
    explorerResultView,
    explorerStates,
    focusedEvents,
    focusedHasMore,
    focusedLoadingMore,
    focusedMetricSeries,
    focusedSearch,
    focusedSignalId,
    focusedStates,
    inventory,
    lastRunQuery,
    loading,
    metricTypeFilter,
    metricWidgetPoints,
    metrics,
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
    savedQueries,
    selectedBaseId,
    selectedDashboardId,
    selectedMetric,
    selectedResourceKey,
    selectedSourceId,
    selectedVisual,
    setActivitySearch,
    setBrowseEntityId,
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
    setSelectedBucket,
    setSelectedDashboardId,
    setSelectedFocusedEventId,
    setSelectedFocusedSeriesId,
    setSelectedFocusedStateId,
    setSelectedMetric,
    setSelectedQuerySourceId,
    setSelectedResourceKey,
    setSelectedSince,
    setSelectedSourceId,
    setSelectedVisual,
    setSettingsDialogOpen,
    settingsDialogOpen,
    sourceSearch,
    sources,
    setSourceSearch,
    queries,
  } = state;
  const {
    browseEvents,
    browseLabels,
    browseMetrics,
    browseSources,
    browseStates,
    browseVisibleEntities,
    compiledMetricQuery,
    compiledQuery,
    dashboardEditPreviewConfig,
    defaultQueryText,
    eventGroups,
    filteredResources,
    filteredSources,
    focusedMetric,
    matchingMetricSeries,
    matchingMetricSources,
    metricByName,
    metricScopeByName,
    previewSeries,
    previewUnit,
    pulseDateContext,
    queryCompletions,
    queryFilterSuggestions,
    querySuggestionMatches,
    querySuggestionOverflow,
    selectedBase,
    selectedBrowseEntity,
    selectedBrowseSource,
    selectedDashboard,
    selectedFocusedEvent,
    selectedFocusedSeries,
    selectedFocusedState,
    selectedResource,
    selectedResourceEvents,
    selectedResourceMetrics,
    selectedResourceStates,
    selectedSource,
    selectedSourceApiKeys,
    selectedSourceScrapes,
    sourceNameById,
    stateGroups,
    visibleQueryLabelSuggestions,
    visibleQuerySourceSuggestions,
    visibleSelectedResource,
  } = createWorkspaceDerivedModel(props, state);
  const resourceDetailSelection = createResourceDetailSelection({
    metrics: selectedResourceMetrics,
    states: selectedResourceStates,
    events: selectedResourceEvents,
  });
  const loadFocusedRows = (options: { append?: boolean; signal?: AbortSignal } = {}) =>
    options.append ? queries.focused.loadMore() : queries.focused.refresh();
  const refreshResourceView = async (_baseId?: string, _signal?: AbortSignal) => {
    await queries.resources.refresh();
    if (activeView() === "resource-detail") await queries.resourceSignals.refresh();
    const error = queries.resources.error() ?? (activeView() === "resource-detail" ? queries.resourceSignals.error() : null);
    if (error) throw error;
  };

  const refreshDashboardConfig = async (_config?: PulseDashboardConfig, _dashboard?: PulseDashboard | null, _baseId?: string) => {
    await queries.dashboard.refresh();
    if (queries.dashboard.error()) throw queries.dashboard.error();
  };

  const refreshDashboard = async (_dashboard?: PulseDashboard | null, _baseId?: string) => refreshDashboardConfig();

  const queryBlocksWrite = (item: { error: () => Error | null; loading: () => boolean; stale: () => boolean }) =>
    item.loading() || item.stale() || item.error() !== null;
  const canonicalWriteBlocked = () => {
    const activeQueries: Array<Parameters<typeof queryBlocksWrite>[0]> = [queries.bases, queries.baseData];
    const view = activeView();
    if (view === "sources" && selectedSourceId()) activeQueries.push(queries.sourceDetail);
    else if (view === "resources") activeQueries.push(queries.resources);
    else if (view === "resource-detail") activeQueries.push(queries.resources, queries.resourceSignals);
    else if (["metric-detail", "state-detail", "event-detail"].includes(view)) activeQueries.push(queries.focused);
    else if (["dashboard", "dashboard-edit"].includes(view)) activeQueries.push(queries.dashboard);
    else if (view === "explorer") activeQueries.push(queries.activity, queries.series);
    else if (["activity-events", "activity-states", "activity-metrics"].includes(view)) activeQueries.push(queries.activity);
    return activeQueries.some(queryBlocksWrite);
  };

  const navigateWorkspace = (
    nextState: { view: WorkspaceView; dashboardId?: string; sourceId?: string; signalId?: string },
    mode: "push" | "replace" = "push",
  ) => {
    const options = {
      baseId: selectedBaseId(),
      state: {
        ...nextState,
        signalId: nextState.signalId ?? focusedSignalId(),
      },
      activity: {
        q: activitySearch(),
        type: metricTypeFilter(),
      },
      resources: {
        q: resourceSearch(),
        sourceId: resourceSourceFilter(),
        type: resourceTypeFilter(),
      },
      focusedSearch: focusedSearch(),
    };
    if (mode === "replace") replacePulseWorkspaceUrl(options);
    else navigatePulseWorkspace(options);
  };

  const { openSettings: openSettingsDialog } = createBaseController({
    bases,
    selectedBase,
    loading,
    settingsDialogOpen,
    setLoading,
    setSettingsDialogOpen,
    refreshBases: () => queries.bases.invalidate(),
    refreshWorkspace: async () => {
      const tasks: Promise<void>[] = [queries.baseData.invalidate()];
      const view = activeView();
      if (["resources", "resource-detail"].includes(view)) tasks.push(queries.resources.invalidate());
      if (view === "resource-detail" && selectedResourceKey()) tasks.push(queries.resourceSignals.invalidate());
      if (["explorer", "activity-events", "activity-states", "activity-metrics"].includes(view)) tasks.push(queries.activity.invalidate());
      if (view === "explorer" && selectedMetric()) tasks.push(queries.series.invalidate());
      if (view === "sources" && selectedSourceId()) tasks.push(queries.sourceDetail.invalidate());
      if (["dashboard", "dashboard-edit"].includes(view) && selectedDashboard()) tasks.push(queries.dashboard.invalidate());
      if (["metric-detail", "state-detail", "event-detail"].includes(view) && focusedSignalId()) tasks.push(queries.focused.invalidate());
      await Promise.all(tasks);
    },
    writeBlocked: canonicalWriteBlocked,
    navigateToBase: (baseId) => navigatePulseWorkspace({ baseId, state: { view: "resources" } }),
  });

  const sourceController = createSourceController({
    selectedBaseId,
    loading,
    setLoading,
    setSelectedSourceId,
    navigate: (state) => navigateWorkspace(state),
    refreshBaseData: () => queries.baseData.invalidate(),
    refreshSourceDetail: () => queries.sourceDetail.invalidate(),
    refreshDashboard: () => refreshDashboard(),
    writeBlocked: canonicalWriteBlocked,
  });
  const { addSource, editSource, removeSource, scrape, toggleSource } = sourceController;

  const queryController = createQueryController({
    selectedBaseId,
    metrics,
    queryText,
    setQueryText,
    defaultQueryText,
    queryHistory,
    setQueryHistory,
    compiledQuery,
    explorerResultView,
    setExplorerResultView,
    setSelectedMetric,
    setSelectedAggregation,
    setSelectedBucket,
    setSelectedSince,
    setSelectedQuerySourceId,
    setPoints,
    setExplorerEvents,
    setExplorerStates,
    setQueryDiagnostics,
    setLastRunQuery,
    setQueryRunning,
    loading,
    setLoading,
    refreshBaseData: () => queries.baseData.invalidate(),
    writeBlocked: canonicalWriteBlocked,
    selectedVisual,
    browseSourceId,
    browseEntityId,
    openExplorer: () => openQueryExplorer(),
  });
  const {
    applyDimensionFilter: applyQueryDimensionFilter,
    applySourceFilter: applyQuerySourceFilter,
    copyDashboardWidget: copyDashboardWidgetSnippet,
    current: currentExplorerQuery,
    openEventQuery,
    openMetricQuery,
    openStateQuery,
    removeSaved: removeSavedQuery,
    run: runTextQuery,
    save: saveCurrentQuery,
    setEventBrowseQuery,
    setMetricBrowseQuery,
    setStateBrowseQuery,
  } = queryController;
  const dashboardController = createDashboardController({
    selectedBaseId,
    selectedDashboard,
    selectedDashboardId,
    dashboards,
    setSelectedDashboardId,
    loading,
    setLoading,
    origin,
    activeView,
    dashboardDslText,
    setDashboardDslText,
    dashboardDslDiagnostics,
    setDashboardDslDiagnostics,
    dashboardDslDiagnosticsText,
    setDashboardDslDiagnosticsText,
    dashboardPreviewConfig,
    setDashboardPreviewConfig,
    setDashboardDslSeededFor,
    setDashboardDslSaving,
    dashboardControlValues,
    setDashboardControlValues,
    navigate: (state) => navigateWorkspace(state),
    refreshBaseData: () => queries.baseData.invalidate(),
    refreshDashboard: (dashboard) => refreshDashboard(dashboard),
    refreshDashboardConfig: (config, dashboard, baseId) => refreshDashboardConfig(config, dashboard, baseId),
    writeBlocked: canonicalWriteBlocked,
  });
  const {
    compilePreview: compileDashboardDslPreview,
    createDashboard,
    openPublicDisplay: openPublicDashboardDisplayDialog,
    openSettings: openDashboardSettingsDialog,
    saveDsl: saveDashboardDsl,
    updateControl: updateDashboardControl,
  } = dashboardController;
  const dashboardRenderContext: DashboardRenderContext = {
    metricWidgetPoints,
    dashboardEvents,
    dashboardStates,
    dashboardMaps,
    metricByName,
    sourceNameById,
    sources,
    dashboardControlValues,
    dateContext: pulseDateContext,
    onControlChange: updateDashboardControl,
    onOpenPublicDisplay: (dashboard) => void openPublicDashboardDisplayDialog(dashboard),
  };

  const refreshSourcesView = async () => {
    await Promise.all([queries.baseData.refresh(), ...(selectedSourceId() ? [queries.sourceDetail.refresh()] : [])]);
    const error = queries.baseData.error() ?? (selectedSourceId() ? queries.sourceDetail.error() : null);
    if (error) throw error;
  };

  const refreshActivityView = async () => {
    await queries.activity.refresh();
    if (queries.activity.error()) throw queries.activity.error();
  };

  const refreshDashboardView = async (baseId: string) => {
    await queries.baseData.refresh();
    if (queries.baseData.error()) throw queries.baseData.error();
    await refreshDashboard(selectedDashboard(), baseId);
  };

  installNearRealtimeController({
    selectedBaseId,
    activeView,
    selectedDashboard,
    refreshSources: refreshSourcesView,
    refreshActivity: refreshActivityView,
    refreshDashboard: refreshDashboardView,
    refreshResources: refreshResourceView,
  });

  installWorkspaceEffects({
    selectedBaseId,
    activeView,
    selectedDashboard,
    origin,
    setOrigin,
    setQueryHistory,
    dashboardControlValues,
    setDashboardControlValues,
    dashboardDslSeededFor,
    setDashboardDslText,
    setDashboardPreviewConfig,
    setDashboardDslDiagnostics,
    setDashboardDslDiagnosticsText,
    setDashboardDslSeededFor,
    dashboardDslText,
    compileDashboardDslPreview,
    querySeeded,
    queryText,
    metrics,
    setQueryText,
    setQuerySeeded,
    setQueryDiagnostics,
    currentExplorerQuery,
    runTextQuery,
  });

  const openDashboard = (dashboardId: string) => {
    navigateWorkspace({ view: "dashboard", dashboardId });
  };

  const openDashboardEditor = (dashboardId = selectedDashboardId()) => {
    if (!dashboardId) return;
    navigateWorkspace({ view: "dashboard-edit", dashboardId });
  };

  const renderDashboardSidebarItem = (dashboard: PulseDashboard) => {
    return (
      <AppWorkspace.SidebarItem
        active={(activeView() === "dashboard" || activeView() === "dashboard-edit") && selectedDashboard()?.id === dashboard.id}
        title={dashboard.name}
        onClick={() => openDashboard(dashboard.id)}
      >
        <AppWorkspace.SidebarItemIcon icon="ti ti-chart-area-line" />
        <AppWorkspace.SidebarItemLabel>{dashboard.name}</AppWorkspace.SidebarItemLabel>
        <AppWorkspace.SidebarItemAction
          icon="ti ti-code"
          label={`Edit ${dashboard.name} dashboard DSL`}
          visibility="hover"
          onSelect={() => openDashboardEditor(dashboard.id)}
        />
      </AppWorkspace.SidebarItem>
    );
  };

  const openSources = () => {
    const sourceId = sources().some((source) => source.id === selectedSourceId()) ? selectedSourceId() : "";
    setSelectedSourceId(sourceId);
    navigateWorkspace({ view: "sources", sourceId });
  };

  const selectSource = (source: PulseSource) => {
    setSelectedSourceId(source.id);
    navigateWorkspace({ view: "sources", sourceId: source.id });
  };

  const openQueryExplorer = () => navigateWorkspace({ view: "explorer" });
  const openResources = () => navigateWorkspace({ view: "resources" });
  const openResourceDetailView = (key: string) => {
    setSelectedResourceKey(key);
    navigateWorkspace({ view: "resource-detail", signalId: key });
  };
  const openActivityEvents = () => navigateWorkspace({ view: "activity-events" });
  const openActivityStates = () => navigateWorkspace({ view: "activity-states" });
  const openActivityMetrics = () => navigateWorkspace({ view: "activity-metrics" });
  const openMetricDetailView = (metric: string) => navigateWorkspace({ view: "metric-detail", signalId: metric });
  const openStateDetailView = (key: string) => navigateWorkspace({ view: "state-detail", signalId: key });
  const openEventDetailView = (kind: string) => navigateWorkspace({ view: "event-detail", signalId: kind });

  const replaceActivityUrl = () => {
    const view = activeView();
    if (view !== "activity-events" && view !== "activity-states" && view !== "activity-metrics") return;
    navigateWorkspace({ view }, "replace");
  };

  const replaceResourceUrl = () => {
    if (activeView() !== "resources") return;
    navigateWorkspace({ view: "resources" }, "replace");
  };

  const updateActivitySearch = (value: string) => {
    setActivitySearch(value);
    replaceActivityUrl();
  };

  const updateMetricTypeFilter = (value: string[]) => {
    setMetricTypeFilter((value[0] ?? "") as "" | MetricType);
    replaceActivityUrl();
  };

  const updateResourceSearch = (value: string) => {
    setResourceSearch(value);
    replaceResourceUrl();
  };

  const updateResourceSourceFilter = (value: string[]) => {
    setResourceSourceFilter(value[0] ?? "");
    replaceResourceUrl();
  };

  const updateResourceTypeFilter = (value: string[]) => {
    setResourceTypeFilter(value[0] ?? "");
    replaceResourceUrl();
  };

  const clearResourceFilters = () => {
    setResourceSourceFilter("");
    setResourceTypeFilter("");
    replaceResourceUrl();
  };

  const renderDashboardView = () => <DashboardView dashboard={selectedDashboard} context={dashboardRenderContext} />;

  const renderDashboardEditView = () => {
    return (
      <DashboardEditorView
        selectedBaseId={selectedBaseId}
        selectedDashboard={selectedDashboard}
        dashboardDslText={dashboardDslText}
        setDashboardDslText={setDashboardDslText}
        dashboardPreviewConfig={dashboardEditPreviewConfig}
        dashboardDslDiagnostics={dashboardDslDiagnostics}
        dashboardDslSaving={dashboardDslSaving}
        initialPanesLayout={props.initialDashboardEditorPanesLayout}
        sources={sources}
        inventory={inventory}
        metrics={metrics}
        savedQueries={savedQueries}
        renderContext={dashboardRenderContext}
        onSave={saveDashboardDsl}
        onOpenSettings={openDashboardSettingsDialog}
      />
    );
  };

  const signalCatalogTabs = () => [
    { kind: "events" as const, label: t().events, icon: "ti ti-bolt", count: eventGroups().length, open: openActivityEvents },
    { kind: "states" as const, label: t().states, icon: "ti ti-toggle-right", count: stateGroups().length, open: openActivityStates },
    { kind: "metrics" as const, label: t().metrics, icon: "ti ti-chart-dots", count: activityMetrics().length, open: openActivityMetrics },
  ];

  const openSourceFromDetail = (sourceId: string | null | undefined) => {
    if (!sourceId) return;
    setSelectedSourceId(sourceId);
    navigateWorkspace({ view: "sources", sourceId });
  };

  const { renderEventCell, renderStateCell, renderMetricSeriesCell } = createSignalTableCellRenderers({
    sourceNameById,
    dateContext: pulseDateContext,
    metricUnit: () => focusedMetric()?.unit ?? null,
    openSource: openSourceFromDetail,
  });

  const resourceSourceLabel = (resource: PulseResourceSummary): string =>
    resource.sourceIds.map((sourceId) => sourceNameById().get(sourceId) ?? t().unknownSource).join(", ") || t().noSource;

  const openSourceResources = (source: PulseSource) => {
    setResourceSearch("");
    setResourceSourceFilter(source.id);
    navigateWorkspace({ view: "resources" });
  };

  const sourcePublishedCounts = (sourceId: string) => ({
    resources: inventory().resources.filter((resource) => resource.sourceIds.includes(sourceId)).length,
    metricVariants: inventory().metrics.filter((metric) => metric.sourceId === sourceId).length,
    states: inventory().states.filter((state) => state.sourceId === sourceId).length,
    events: inventory().events.filter((event) => event.sourceId === sourceId).length,
  });

  const createSourceApiKey = sourceController.createApiKey;
  const revokeSourceApiKey = sourceController.revokeApiKey;

  const renderResourceBrowserView = () => (
    <ResourceBrowserView
      search={resourceSearch}
      setSearch={updateResourceSearch}
      sourceFilter={resourceSourceFilter}
      setSourceFilter={updateResourceSourceFilter}
      typeFilter={resourceTypeFilter}
      setTypeFilter={updateResourceTypeFilter}
      clearFilters={clearResourceFilters}
      inventory={inventory}
      filteredResources={filteredResources}
      selectedResource={visibleSelectedResource}
      dateContext={pulseDateContext()}
      openResource={openResourceDetailView}
      resourceSourceLabel={resourceSourceLabel}
      sourceNameById={sourceNameById}
    />
  );

  const renderResourceDetailView = () => {
    const resource = selectedResource();
    if (!resource) {
      return (
        <section class="paper flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-dimmed">
          Resource not found.
        </section>
      );
    }
    return (
      <ResourceDetailView
        resource={resource}
        metrics={selectedResourceMetrics()}
        states={selectedResourceStates()}
        events={selectedResourceEvents()}
        selection={resourceDetailSelection}
        dateContext={pulseDateContext()}
        sourceNameById={sourceNameById}
        openSource={openSourceFromDetail}
        openMetricQuery={openMetricQuery}
        openMetricVariants={openMetricDetailView}
        openStateQuery={openStateQuery}
        openStateVariants={openStateDetailView}
        openEventQuery={openEventQuery}
        openEventVariants={openEventDetailView}
      />
    );
  };

  const renderResourceSignalDetail = () => {
    const resource = selectedResource();
    if (!resource) return null;
    return (
      <ResourceSignalDetail
        resource={resource}
        metrics={selectedResourceMetrics()}
        states={selectedResourceStates()}
        events={selectedResourceEvents()}
        selection={resourceDetailSelection}
        dateContext={pulseDateContext()}
        sourceNameById={sourceNameById}
        openSource={openSourceFromDetail}
        openMetricQuery={openMetricQuery}
        openMetricVariants={openMetricDetailView}
        openStateQuery={openStateQuery}
        openStateVariants={openStateDetailView}
        openEventQuery={openEventQuery}
        openEventVariants={openEventDetailView}
      />
    );
  };

  const renderSourcesView = () => (
    <SourcesView
      search={sourceSearch}
      setSearch={setSourceSearch}
      selectedBaseId={selectedBaseId}
      loading={loading}
      sources={filteredSources}
      selectedSourceId={selectedSourceId}
      selectedSource={selectedSource}
      selectedSourceScrapes={selectedSourceScrapes}
      selectedSourceApiKeys={selectedSourceApiKeys}
      origin={origin}
      dateContext={pulseDateContext}
      publishedCounts={sourcePublishedCounts}
      copySetupText={copySetupText}
      addSource={addSource}
      selectSource={selectSource}
      closeSource={() => {
        setSelectedSourceId("");
        navigateWorkspace({ view: "sources" });
      }}
      openSourceResources={openSourceResources}
      editSource={editSource}
      toggleSource={toggleSource}
      scrape={scrape}
      removeSource={removeSource}
      createApiKey={createSourceApiKey}
      revokeApiKey={revokeSourceApiKey}
    />
  );

  const renderSourcesDetail = () => (
    <SourcesDetailPanel
      search={sourceSearch}
      setSearch={setSourceSearch}
      selectedBaseId={selectedBaseId}
      loading={loading}
      sources={filteredSources}
      selectedSourceId={selectedSourceId}
      selectedSource={selectedSource}
      selectedSourceScrapes={selectedSourceScrapes}
      selectedSourceApiKeys={selectedSourceApiKeys}
      origin={origin}
      dateContext={pulseDateContext}
      publishedCounts={sourcePublishedCounts}
      copySetupText={copySetupText}
      addSource={addSource}
      selectSource={selectSource}
      closeSource={() => {
        setSelectedSourceId("");
        navigateWorkspace({ view: "sources" });
      }}
      openSourceResources={openSourceResources}
      editSource={editSource}
      toggleSource={toggleSource}
      scrape={scrape}
      removeSource={removeSource}
      createApiKey={createSourceApiKey}
      revokeApiKey={revokeSourceApiKey}
    />
  );

  const openFocusedSignalQuery = () => {
    const view = activeView();
    const signalId = focusedSignalId();
    if (view === "metric-detail") {
      const metric = focusedMetric();
      if (metric) {
        setQueryText(metricSummaryQueryText(metric));
        openQueryExplorer();
        return;
      }
    }
    if (view === "state-detail") setQueryText(stateKeyQueryText(signalId));
    else setQueryText(eventKindQueryText(signalId));
    openQueryExplorer();
  };

  const closeFocusedSignalDetail = () => {
    if (activeView() === "metric-detail") setSelectedFocusedSeriesId("");
    if (activeView() === "state-detail") setSelectedFocusedStateId("");
    if (activeView() === "event-detail") setSelectedFocusedEventId("");
  };

  const renderFocusedSignalView = () => (
    <FocusedSignalView
      view={activeView}
      signalId={focusedSignalId}
      focusedMetric={focusedMetric}
      metricSeries={focusedMetricSeries}
      states={focusedStates}
      events={focusedEvents}
      hasMore={focusedHasMore}
      loadingMore={focusedLoadingMore}
      search={focusedSearch}
      setSearch={setFocusedSearch}
      selectedSeries={selectedFocusedSeries}
      selectedState={selectedFocusedState}
      selectedEvent={selectedFocusedEvent}
      setSelectedSeriesId={setSelectedFocusedSeriesId}
      setSelectedStateId={setSelectedFocusedStateId}
      setSelectedEventId={setSelectedFocusedEventId}
      metricSeriesColumns={metricSeriesColumns(t())}
      stateColumns={stateColumns(t())}
      eventColumns={eventColumns(t())}
      renderMetricSeriesCell={renderMetricSeriesCell}
      renderStateCell={renderStateCell}
      renderEventCell={renderEventCell}
      loadRows={loadFocusedRows}
      onOpenQuery={openFocusedSignalQuery}
      sourceNameById={sourceNameById}
      dateContext={pulseDateContext}
      openSource={openSourceFromDetail}
      closeDetail={closeFocusedSignalDetail}
    />
  );

  const renderFocusedSignalDetail = () => (
    <FocusedSignalDetail
      view={activeView}
      signalId={focusedSignalId}
      focusedMetric={focusedMetric}
      metricSeries={focusedMetricSeries}
      states={focusedStates}
      events={focusedEvents}
      hasMore={focusedHasMore}
      loadingMore={focusedLoadingMore}
      search={focusedSearch}
      setSearch={setFocusedSearch}
      selectedSeries={selectedFocusedSeries}
      selectedState={selectedFocusedState}
      selectedEvent={selectedFocusedEvent}
      setSelectedSeriesId={setSelectedFocusedSeriesId}
      setSelectedStateId={setSelectedFocusedStateId}
      setSelectedEventId={setSelectedFocusedEventId}
      metricSeriesColumns={metricSeriesColumns(t())}
      stateColumns={stateColumns(t())}
      eventColumns={eventColumns(t())}
      renderMetricSeriesCell={renderMetricSeriesCell}
      renderStateCell={renderStateCell}
      renderEventCell={renderEventCell}
      loadRows={loadFocusedRows}
      onOpenQuery={openFocusedSignalQuery}
      sourceNameById={sourceNameById}
      dateContext={pulseDateContext}
      openSource={openSourceFromDetail}
      closeDetail={closeFocusedSignalDetail}
    />
  );

  const renderQueryEditorPane = () => (
    <QueryExplorerEditorPane
      queryText={queryText}
      onQueryInput={setQueryText}
      completions={queryCompletions}
      diagnostics={queryDiagnostics}
      running={queryRunning}
      compiledMetricQuery={compiledMetricQuery}
      matchingSeriesCount={() => matchingMetricSeries().length}
      matchingSourcesCount={() => matchingMetricSources().length}
      filterSuggestionCount={() => queryFilterSuggestions().length}
      suggestionsExpanded={querySuggestionsExpanded}
      setSuggestionsExpanded={setQuerySuggestionsExpanded}
      suggestionSearch={querySuggestionSearch}
      setSuggestionSearch={setQuerySuggestionSearch}
      visibleSourceSuggestions={visibleQuerySourceSuggestions}
      visibleLabelSuggestions={visibleQueryLabelSuggestions}
      suggestionMatches={querySuggestionMatches}
      suggestionOverflow={querySuggestionOverflow}
      canRun={() => Boolean(currentExplorerQuery())}
      canOpenReference={() => Boolean(selectedBaseId())}
      onRun={() => void runTextQuery({ manual: true, remember: true })}
      onOpenReference={() => openQueryReferenceWindow(selectedBaseId())}
      onApplySourceFilter={applyQuerySourceFilter}
      onApplyDimensionFilter={applyQueryDimensionFilter}
    />
  );

  const renderExplorerResultPane = () => (
    <QueryExplorerResultPane
      compiled={compiledQuery}
      resultView={explorerResultView}
      setResultView={setExplorerResultView}
      visual={selectedVisual}
      setVisual={setSelectedVisual}
      points={points}
      events={explorerEvents}
      states={explorerStates}
      eventColumns={eventColumns(t())}
      stateColumns={stateColumns(t())}
      renderEventCell={renderEventCell}
      renderStateCell={renderStateCell}
      queryWasRun={() => lastRunQuery() === currentExplorerQuery()}
      previewTitle={() => compiledMetricQuery()?.metric ?? (selectedMetric() || t().query)}
      previewUnit={previewUnit}
      previewSeries={previewSeries}
      dateContext={pulseDateContext}
      onCopyWidgetSnippet={copyDashboardWidgetSnippet}
    />
  );

  const renderBrowseExplorerPane = () => (
    <QueryExplorerBrowsePane
      search={browseSearch}
      onSearchInput={setBrowseSearch}
      selectedSource={selectedBrowseSource}
      selectedEntity={selectedBrowseEntity}
      sourceId={browseSourceId}
      sources={browseSources}
      entities={browseVisibleEntities}
      metrics={browseMetrics}
      events={browseEvents}
      states={browseStates}
      labels={browseLabels}
      onClearSourceScope={() => setBrowseSourceId("")}
      onClearEntityScope={() => setBrowseEntityId("")}
      onSelectSource={setBrowseSourceId}
      onSelectEntity={setBrowseEntityId}
      onMetricQuery={setMetricBrowseQuery}
      onEventQuery={setEventBrowseQuery}
      onStateQuery={setStateBrowseQuery}
      onApplySourceFilter={applyQuerySourceFilter}
      onApplyDimensionFilter={applyQueryDimensionFilter}
    />
  );

  const renderMetricExplorerView = () => (
    <section class="flex min-h-0 flex-1 overflow-hidden pb-2">
      <Panes
        layout={explorerPanesLayout()}
        onLayoutChange={updateExplorerPanesLayout}
        class="h-full min-h-0 w-full"
        ariaLabel={t().queryExplorerPanes}
        items={[
          { id: "result", title: t().result, icon: "ti ti-chart-line", render: renderExplorerResultPane },
          { id: "editor", title: t().query, icon: "ti ti-code", render: renderQueryEditorPane },
          { id: "browse", title: t().browse, icon: "ti ti-list-search", render: renderBrowseExplorerPane },
          {
            id: "saved",
            title: t().saved,
            icon: "ti ti-device-floppy",
            render: () => (
              <SavedQueriesPane
                queries={savedQueries}
                currentQuery={currentExplorerQuery}
                loading={loading}
                onSelect={setQueryText}
                onSaveCurrent={saveCurrentQuery}
                onRemove={removeSavedQuery}
              />
            ),
          },
          {
            id: "history",
            title: t().history,
            icon: "ti ti-history",
            render: () => <QueryHistoryPane history={queryHistory} dateContext={pulseDateContext} onSelect={setQueryText} />,
          },
        ]}
      />
    </section>
  );

  const renderSignalCatalogView = () => (
    <SignalCatalogView
      kind={signalCatalogKindForView(activeView())}
      tabs={signalCatalogTabs()}
      search={activitySearch}
      metricTypeFilter={metricTypeFilter}
      onSearch={updateActivitySearch}
      onMetricTypeFilter={updateMetricTypeFilter}
      eventGroups={eventGroups}
      stateGroups={stateGroups}
      metrics={activityMetrics}
      eventColumns={eventGroupColumns(t())}
      stateColumns={stateGroupColumns(t())}
      metricColumns={metricColumns(t())}
      metricScopeByName={metricScopeByName}
      sourceNameById={sourceNameById}
      dateContext={pulseDateContext}
      openEventDetail={openEventDetailView}
      openStateDetail={openStateDetailView}
      openMetricDetail={openMetricDetailView}
      openSource={openSourceFromDetail}
    />
  );

  const copySetupText = async (text: string, label: string) => {
    await clipboard.copy(text);
    toast.success(label);
  };

  const workspaceDetailOpen = () => {
    if (activeView() === "sources") return selectedSource() !== null;
    if (activeView() === "resource-detail") return resourceDetailSelection.open();
    if (activeView() === "metric-detail") return selectedFocusedSeries() !== null;
    if (activeView() === "state-detail") return selectedFocusedState() !== null;
    if (activeView() === "event-detail") return selectedFocusedEvent() !== null;
    return false;
  };

  const renderWorkspaceDetail = () => {
    if (activeView() === "sources") return renderSourcesDetail();
    if (activeView() === "resource-detail") return renderResourceSignalDetail();
    if (activeView() === "metric-detail" || activeView() === "state-detail" || activeView() === "event-detail") {
      return renderFocusedSignalDetail();
    }
    return null;
  };

  const activeReadError = () => {
    const view = activeView();
    return (
      queries.bases.error() ??
      queries.baseData.error() ??
      (view === "sources"
        ? selectedSourceId()
          ? queries.sourceDetail.error()
          : null
        : view === "resources"
          ? queries.resources.error()
          : view === "resource-detail"
            ? (queries.resources.error() ?? queries.resourceSignals.error())
            : ["metric-detail", "state-detail", "event-detail"].includes(view)
              ? queries.focused.error()
              : ["dashboard", "dashboard-edit"].includes(view)
                ? queries.dashboard.error()
                : view === "explorer"
                  ? (queries.activity.error() ?? queries.series.error())
                  : queries.activity.error())
    );
  };

  const retryActiveRead = async () => {
    const view = activeView();
    if (queries.bases.error()) {
      await queries.bases.refresh();
      if (queries.bases.error()) return;
      if (!bases().some((base) => base.id === selectedBaseId())) return;
    }
    const retriedBaseData = Boolean(queries.baseData.error());
    if (retriedBaseData) {
      await queries.baseData.refresh();
      if (queries.baseData.error()) return;
    }
    if (view === "sources") {
      if (selectedSourceId()) return queries.sourceDetail.refresh();
      if (!retriedBaseData) return queries.baseData.refresh();
      return;
    }
    if (view === "resources" || view === "resource-detail") return refreshResourceView();
    if (["metric-detail", "state-detail", "event-detail"].includes(view)) return queries.focused.refresh();
    if (["dashboard", "dashboard-edit"].includes(view)) return queries.dashboard.refresh();
    if (view === "explorer") await Promise.all([queries.activity.refresh(), queries.series.refresh()]);
    else await queries.activity.refresh();
  };

  return (
    <AppWorkspace class={`${activeView() === "explorer" ? "min-h-0" : "min-h-[760px]"}`}>
      <PulseSidebar
        title={selectedBase()?.name ?? t().appName}
        activeView={activeView()}
        dashboards={dashboards()}
        resourceCount={inventory().resources.length}
        sourceCount={sources().length}
        eventCount={eventGroups().length}
        stateCount={stateGroups().length}
        metricCount={metrics().length}
        settingsDisabled={!selectedBase() || loading()}
        openSettings={openSettingsDialog}
        createDashboard={createDashboard}
        openDashboard={openDashboard}
        renderDashboardItem={renderDashboardSidebarItem}
        openResources={openResources}
        openSources={openSources}
        openQueryExplorer={openQueryExplorer}
        openActivityEvents={openActivityEvents}
        openActivityStates={openActivityStates}
        openActivityMetrics={openActivityMetrics}
      />

      <AppWorkspace.Content>
        <AppWorkspace.Main
          class={`p-[var(--ui-space-shell)] ${activeView() === "explorer" ? "gap-2 overflow-hidden" : "gap-2 overflow-y-auto"}`}
        >
          <Show when={activeReadError()}>
            {(error) => (
              <NoticeCard tone="danger" title={t().pulseDataRefreshFailed} detail={error().message}>
                <Button variant="secondary" size="sm" onClick={() => void retryActiveRead()}>
                  Retry
                </Button>
              </NoticeCard>
            )}
          </Show>
          {activeView() === "dashboard"
            ? renderDashboardView()
            : activeView() === "dashboard-edit"
              ? renderDashboardEditView()
              : activeView() === "sources"
                ? renderSourcesView()
                : activeView() === "resources"
                  ? renderResourceBrowserView()
                  : activeView() === "resource-detail"
                    ? renderResourceDetailView()
                    : activeView() === "metric-detail" || activeView() === "state-detail" || activeView() === "event-detail"
                      ? renderFocusedSignalView()
                      : activeView() === "explorer"
                        ? renderMetricExplorerView()
                        : renderSignalCatalogView()}
        </AppWorkspace.Main>

        <AppWorkspace.Detail id="pulse-detail-panel" open={workspaceDetailOpen()} width="lg" viewTransitionName="pulse-detail-panel-shell">
          {renderWorkspaceDetail()}
        </AppWorkspace.Detail>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}
