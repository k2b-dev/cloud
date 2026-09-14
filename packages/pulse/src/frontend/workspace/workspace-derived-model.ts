import { createMemo } from "solid-js";
import type { MetricQuery, MetricQueryPoint, PulseSource } from "../../contracts";
import { buildPulseQuery, buildPulseQueryCompletions } from "../query-authoring";
import { buildActivityEventGroups, buildActivityStateGroups } from "./activity-groups";
import { defaultPulseDateContext, signalResourceKey, stateRowId } from "./helpers";
import {
  buildBrowseEntities,
  buildBrowseEvents,
  buildBrowseLabels,
  buildBrowseMetrics,
  buildBrowseSources,
  buildBrowseStates,
  filterBrowseSeries,
} from "./query-browser-model";
import type { ActivityEventGroup, ActivityStateGroup, PulseWorkspaceProps } from "./types";
import type { createPulseWorkspaceQueries } from "./workspace-queries";
import type { createPulseWorkspaceState } from "./workspace-state";

type WorkspaceState = ReturnType<typeof createPulseWorkspaceState> & ReturnType<typeof createPulseWorkspaceQueries>;

export const createWorkspaceDerivedModel = (props: PulseWorkspaceProps, state: WorkspaceState) => {
  const {
    bases,
    browseResourceKey,
    browseSearch,
    browseSourceId,
    currentStates,
    dashboardPreviewConfig,
    dashboards,
    focusedEvents,
    focusedMetricSeries,
    focusedSignalId,
    focusedStates,
    inventory,
    metrics,
    points,
    queryDiagnostics,
    querySuggestionSearch,
    querySuggestionsExpanded,
    recentEvents,
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
    series,
    sourceApiKeys,
    sourceScrapes,
    sourceSearch,
    sources,
  } = state;

  const selectedBase = createMemo(() => bases().find((base) => base.id === selectedBaseId()) ?? null);
  const selectedDashboard = createMemo(
    () => dashboards().find((dashboard) => dashboard.id === selectedDashboardId()) ?? dashboards()[0] ?? null,
  );
  const dashboardEditPreviewConfig = createMemo(() => dashboardPreviewConfig() ?? selectedDashboard()?.config ?? null);
  const selectedSource = createMemo(() => sources().find((source) => source.id === selectedSourceId()) ?? null);
  const selectedSourceScrapes = createMemo(() => (selectedSourceId() ? (sourceScrapes()[selectedSourceId()] ?? []) : []));
  const selectedSourceApiKeys = createMemo(() => (selectedSourceId() ? (sourceApiKeys()[selectedSourceId()] ?? []) : []));
  const focusedMetric = createMemo(() => metrics().find((metric) => metric.name === focusedSignalId()) ?? null);
  const selectedFocusedSeries = createMemo(() => focusedMetricSeries().find((item) => item.id === selectedFocusedSeriesId()) ?? null);
  const selectedFocusedState = createMemo(() => focusedStates().find((item) => stateRowId(item) === selectedFocusedStateId()) ?? null);
  const selectedFocusedEvent = createMemo(() => focusedEvents().find((event) => event.id === selectedFocusedEventId()) ?? null);
  const selectedSeries = createMemo(() => series().find((item) => item.id === selectedSeriesId()) ?? null);
  const sourceNameById = createMemo(() => new Map(sources().map((source) => [source.id, source.name])));
  const metricByName = createMemo(() => new Map(metrics().map((metric) => [metric.name, metric])));
  const sourceById = createMemo(() => new Map(sources().map((source) => [source.id, source])));
  const pulseDateContext = createMemo(() => ({
    ...defaultPulseDateContext,
    ...(props.initialDateConfig ?? {}),
    now: props.initialNow ?? new Date().toISOString(),
  }));
  const eventGroups = createMemo<ActivityEventGroup[]>(() => buildActivityEventGroups(recentEvents()));
  const stateGroups = createMemo<ActivityStateGroup[]>(() => buildActivityStateGroups(currentStates()));
  const resourceByKey = createMemo(() => new Map(inventory().resources.map((resource) => [resource.key, resource])));
  const selectedResource = createMemo(() => resourceByKey().get(selectedResourceKey()) ?? inventory().resources[0] ?? null);
  const resourceNeedle = createMemo(() => resourceSearch().trim().toLowerCase());
  const resourceMatches = (values: Array<string | null | undefined>) => {
    const needle = resourceNeedle();
    return !needle || values.some((value) => value?.toLowerCase().includes(needle));
  };
  const filteredResources = createMemo(() =>
    inventory().resources.filter((resource) => {
      if (resourceSourceFilter() && !resource.sourceIds.includes(resourceSourceFilter())) return false;
      if (resourceTypeFilter() && (resource.type ?? "resource") !== resourceTypeFilter()) return false;
      return resourceMatches([
        resource.id,
        resource.label,
        resource.type,
        ...resource.sourceIds.map((sourceId) => sourceNameById().get(sourceId) ?? sourceId),
        ...Object.keys(resource.dimensions),
        ...Object.values(resource.dimensions),
      ]);
    }),
  );
  const visibleSelectedResource = createMemo(() => {
    const selected = selectedResource();
    return filteredResources().find((resource) => resource.key === selected?.key) ?? filteredResources()[0] ?? selected ?? null;
  });
  const selectedResourceMetrics = createMemo(() =>
    visibleSelectedResource() ? inventory().metrics.filter((metric) => metric.resourceKey === visibleSelectedResource()!.key) : [],
  );
  const selectedResourceStates = createMemo(() =>
    visibleSelectedResource() ? inventory().states.filter((item) => signalResourceKey(item) === visibleSelectedResource()!.key) : [],
  );
  const selectedResourceEvents = createMemo(() =>
    visibleSelectedResource() ? inventory().events.filter((item) => signalResourceKey(item) === visibleSelectedResource()!.key) : [],
  );
  const selectedBrowseSource = createMemo(() => sourceById().get(browseSourceId()) ?? null);
  const browseSearchNeedle = createMemo(() => browseSearch().trim().toLowerCase());
  const filteredSources = createMemo(() => {
    const q = sourceSearch().trim().toLowerCase();
    if (!q) return sources();
    return sources().filter((source) =>
      [source.name, source.kind, source.endpointUrl ?? "", source.lastError ?? ""].some((value) => value.toLowerCase().includes(q)),
    );
  });
  const previewSeries = createMemo(() => {
    const grouped = new Map<string, MetricQueryPoint[]>();
    for (const point of points()) {
      const label = Object.entries(point.group ?? {})
        .map(([key, value]) => `${key}=${value || "(none)"}`)
        .join(", ");
      const seriesLabel = label || selectedMetric() || "value";
      grouped.set(seriesLabel, [...(grouped.get(seriesLabel) ?? []), point]);
    }
    return [...grouped.entries()].map(([label, seriesPoints]) => ({
      label,
      data: seriesPoints.flatMap((point) => (point.value === null ? [] : [{ x: Date.parse(point.bucket), y: point.value }])),
    }));
  });
  const queryCompletions = createMemo(() =>
    buildPulseQueryCompletions({
      metrics: metrics(),
      events: recentEvents(),
      states: currentStates(),
      sources: sources(),
      series: series(),
      fields: inventory().fields,
    }),
  );
  const metricScopeByName = createMemo(() => {
    const scopes = new Map<string, { sources: Set<string>; resources: Set<string> }>();
    for (const metric of inventory().metrics) {
      const scope = scopes.get(metric.metric) ?? { sources: new Set<string>(), resources: new Set<string>() };
      if (metric.sourceId) scope.sources.add(metric.sourceId);
      scope.resources.add(metric.resourceKey);
      scopes.set(metric.metric, scope);
    }
    return scopes;
  });
  const browseScope = createMemo(() => ({ sourceId: browseSourceId(), resourceKey: browseResourceKey() }));
  const browseEntities = createMemo(() =>
    buildBrowseEntities({ inventory: inventory(), series: series(), events: recentEvents(), states: currentStates() }),
  );
  const selectedBrowseEntity = createMemo(() => browseEntities().find((resource) => resource.id === browseResourceKey()) ?? null);
  const browseMatches = (values: Array<string | null | undefined>) => {
    const needle = browseSearchNeedle();
    return !needle || values.some((value) => value?.toLowerCase().includes(needle));
  };
  const browseScopedSeries = createMemo(() => filterBrowseSeries(series(), browseScope()));
  const browseSources = createMemo(() =>
    buildBrowseSources({ sources: sources(), series: series(), events: recentEvents(), states: currentStates(), matches: browseMatches }),
  );
  const browseVisibleEntities = createMemo(() =>
    browseEntities()
      .filter((resource) => {
        if (browseSourceId() && !resource.sourceIds.includes(browseSourceId())) return false;
        return browseMatches([resource.id, resource.type, ...Object.keys(resource.dimensions), ...Object.values(resource.dimensions)]);
      })
      .slice(0, 24),
  );
  const browseMetrics = createMemo(() =>
    buildBrowseMetrics({
      metrics: metrics(),
      scopedSeries: browseScopedSeries(),
      allSeries: series(),
      selectedEntityDimensions: selectedBrowseEntity()?.dimensions ?? {},
      resourceKey: browseResourceKey(),
      matches: browseMatches,
    }),
  );
  const browseEvents = createMemo(() => buildBrowseEvents(recentEvents(), browseScope(), browseMatches));
  const browseStates = createMemo(() => buildBrowseStates(currentStates(), browseScope(), browseMatches));
  const browseLabels = createMemo(() =>
    buildBrowseLabels({
      scopedSeries: browseScopedSeries(),
      events: recentEvents(),
      states: currentStates(),
      scope: browseScope(),
      matches: browseMatches,
    }),
  );
  const compiledQuery = createMemo(() => queryDiagnostics()?.compiled ?? null);
  const compiledMetricQuery = createMemo(() => (compiledQuery()?.kind === "metric" ? (compiledQuery() as MetricQuery) : null));
  const matchingMetricSeries = createMemo(() => {
    const compiled = compiledMetricQuery();
    if (!compiled) return [];
    const filters = Object.entries(compiled.dimensions ?? {}).map(([key, value]) => [key, String(value)] as const);
    return series().filter((item) => {
      if (item.metric !== compiled.metric || (compiled.sourceId && item.sourceId !== compiled.sourceId)) return false;
      return filters.every(([key, value]) => item.dimensions[key] === value);
    });
  });
  const queryFilterSuggestions = createMemo(() => {
    const compiled = compiledMetricQuery();
    if (!compiled) return [];
    const existing = new Set(Object.keys(compiled.dimensions ?? {}));
    const dimensions = new Map<string, Map<string, number>>();
    for (const item of matchingMetricSeries()) {
      for (const [key, value] of Object.entries(item.dimensions)) {
        if (existing.has(key)) continue;
        if (!dimensions.has(key)) dimensions.set(key, new Map());
        const values = dimensions.get(key)!;
        values.set(value, (values.get(value) ?? 0) + 1);
      }
    }
    return [...dimensions.entries()]
      .map(([key, values]) => ({
        key,
        count: [...values.values()].reduce((sum, value) => sum + value, 0),
        values: [...values.entries()]
          .map(([value, count]) => ({ key, value, count }))
          .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value)),
      }))
      .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
  });
  const matchingMetricSources = createMemo(() => {
    const unique = new Map<string, { source: PulseSource; count: number }>();
    for (const item of matchingMetricSeries()) {
      const source = sourceById().get(item.sourceId ?? "");
      if (source) unique.set(source.id, { source, count: (unique.get(source.id)?.count ?? 0) + 1 });
    }
    return [...unique.values()].sort((left, right) => right.count - left.count || left.source.name.localeCompare(right.source.name));
  });
  const querySuggestionMatches = createMemo(() => {
    const search = querySuggestionSearch().trim().toLowerCase();
    const sourceMatches = matchingMetricSources().filter(({ source }) =>
      !search ? true : [source.name, source.kind, source.endpointUrl ?? ""].some((value) => value.toLowerCase().includes(search)),
    );
    const labelMatches = queryFilterSuggestions()
      .map((group) => ({
        ...group,
        values: group.values.filter((filter) =>
          !search ? true : `${filter.key}=${filter.value}`.toLowerCase().includes(search) || filter.value.toLowerCase().includes(search),
        ),
      }))
      .filter((group) => group.values.length > 0);
    return { sources: sourceMatches, labels: labelMatches };
  });
  const visibleQuerySourceSuggestions = createMemo(() => querySuggestionMatches().sources.slice(0, querySuggestionsExpanded() ? 25 : 4));
  const visibleQueryLabelSuggestions = createMemo(() => {
    const groupLimit = querySuggestionsExpanded() ? 12 : 3;
    const valueLimit = querySuggestionsExpanded() ? 8 : 4;
    return querySuggestionMatches()
      .labels.slice(0, groupLimit)
      .map((group) => ({
        ...group,
        values: group.values.slice(0, valueLimit),
        hiddenValues: Math.max(0, group.values.length - valueLimit),
      }));
  });
  const querySuggestionOverflow = createMemo(() => {
    const sourceOverflow = compiledMetricQuery()?.sourceId
      ? 0
      : querySuggestionMatches().sources.length - visibleQuerySourceSuggestions().length;
    const labelOverflow = querySuggestionMatches().labels.reduce(
      (count, group, index) =>
        count +
        (index >= visibleQueryLabelSuggestions().length
          ? group.values.length
          : Math.max(0, group.values.length - (querySuggestionsExpanded() ? 8 : 4))),
      0,
    );
    return Math.max(0, sourceOverflow) + Math.max(0, labelOverflow);
  });
  const previewUnit = createMemo(() => metricByName().get(compiledMetricQuery()?.metric ?? selectedMetric())?.unit ?? null);
  const defaultQueryText = createMemo(() => {
    const metric = selectedMetric();
    if (!metric) return "";
    const seriesFilter = selectedSeries();
    return buildPulseQuery({
      metric,
      aggregation: selectedAggregation(),
      bucket: selectedBucket(),
      since: selectedSince(),
      sourceId: seriesFilter?.sourceId ?? selectedQuerySourceId(),
      dimensions: seriesFilter?.dimensions,
    });
  });

  return {
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
  };
};
