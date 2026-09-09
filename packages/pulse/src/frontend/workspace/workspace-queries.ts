import { query } from "@k2b/stdlib/solid";
import type { ResourceApiKey } from "@k2b/cloud/access/ui";
import { type Accessor, createMemo } from "solid-js";
import type {
  MetricQueryPoint,
  MetricType,
  PulseBase,
  PulseCurrentState,
  PulseDashboardConfig,
  PulseInventory,
  PulseMapSeries,
  PulseRecordedEvent,
  PulseSourceScrape,
} from "../../contracts";
import { jsonFetch } from "../http";
import {
  fetchDashboardEventsWidgetRows,
  fetchDashboardMapWidgetSeries,
  fetchDashboardMetricWidgetPoints,
  fetchDashboardStatesWidgetRows,
} from "./dashboard-runtime";
import { type FocusedRowsPage, type FocusedRowsView, fetchFocusedRowsPage } from "./focused-rows";
import { dashboardEventsWidgets, dashboardMapWidgets, dashboardMetricWidgets, dashboardStatesWidgets, FOCUSED_PAGE_SIZE } from "./helpers";
import { readResourceQueryState } from "./routes";
import type { PulseWorkspaceProps, WorkspaceView } from "./types";
import {
  fetchPulseActivityData,
  fetchPulseBaseData,
  fetchPulseMetricSeries,
  fetchPulseResourceSignals,
  fetchPulseResources,
  fetchPulseSourceApiKeys,
  fetchPulseSourceScrapes,
} from "./workspace-loaders";

type WorkspaceQueryDeps = {
  activeView: Accessor<WorkspaceView>;
  activitySearch: Accessor<string>;
  dashboardControlValues: Accessor<Record<string, Record<string, string>>>;
  dashboardPreviewConfig: Accessor<PulseDashboardConfig | null>;
  focusedSearch: Accessor<string>;
  focusedSignalId: Accessor<string>;
  metricTypeFilter: Accessor<"" | MetricType>;
  resourceSearch: Accessor<string>;
  resourceSourceFilter: Accessor<string>;
  resourceTypeFilter: Accessor<string>;
  selectedBaseId: Accessor<string>;
  selectedDashboardId: Accessor<string>;
  selectedMetric: Accessor<string>;
  selectedQuerySourceId: Accessor<string>;
  selectedResourceKey: Accessor<string>;
  selectedSourceId: Accessor<string>;
  selectedSourceKind: Accessor<string | null>;
};

const same = <T extends Record<string, unknown>>(left: T, right: T) => Object.keys(left).every((key) => left[key] === right[key]);

type QuerySnapshot<TSource, TData> = { source: TSource; data: TData };

const currentQueryData = <TSource, TData>(
  source: TSource,
  loaded: QuerySnapshot<TSource, TData> | undefined,
  isSameSource: (left: TSource, right: TSource) => boolean = Object.is,
) => (loaded && isSameSource(loaded.source, source) ? loaded.data : undefined);

const emptyInventory = (): PulseInventory => ({ resources: [], metrics: [], events: [], states: [], fields: [] });

const dashboardRuntimeValues = (config: PulseDashboardConfig | null, values?: Record<string, string>) => ({
  ...Object.fromEntries((config?.layout?.controls ?? []).map((control) => [control.variable, control.defaultValue])),
  ...(values ?? {}),
});

type SourceDetail = { sourceId: string; scrapes: PulseSourceScrape[]; apiKeys: ResourceApiKey[] };
type FocusedSource = { baseId: string; view: FocusedRowsView; signalId: string; search: string };
type FocusedPage = { result: FocusedRowsPage; nextOffset: number };
type DashboardData = {
  points: Record<string, MetricQueryPoint[]>;
  events: Record<string, PulseRecordedEvent[]>;
  states: Record<string, PulseCurrentState[]>;
  maps: Record<string, PulseMapSeries[]>;
};

export const createPulseWorkspaceQueries = (props: PulseWorkspaceProps, deps: WorkspaceQueryDeps) => {
  const initialBaseId = props.initialBaseId ?? props.initialBases[0]?.id ?? "";
  const initialView = props.initialRouteState?.view ?? "resources";
  const initialResourceQuery = props.initialResourceQuery ?? readResourceQueryState(props.initialSearch ?? "");

  const basesQuery = query.create({
    source: () => "bases",
    initial: props.initialQueryCoverage.bases ? { source: "bases", data: props.initialBases } : undefined,
    load: (_source, { abortSignal }) => jsonFetch<PulseBase[]>("/api/pulse/bases", { signal: abortSignal }),
  });

  const baseDataQuery = query.create({
    source: deps.selectedBaseId,
    initial: props.initialQueryCoverage.baseData
      ? {
          source: initialBaseId,
          data: {
            source: initialBaseId,
            data: {
              sources: props.initialSources ?? [],
              metrics: props.initialMetrics ?? [],
              inventory: props.initialInventory ?? emptyInventory(),
              dashboards: props.initialDashboards ?? [],
              savedQueries: props.initialSavedQueries ?? [],
            },
          },
        }
      : undefined,
    enabled: () => Boolean(deps.selectedBaseId()),
    load: async (baseId, { abortSignal }) => ({ source: baseId, data: await fetchPulseBaseData(baseId, abortSignal) }),
  });
  const currentBaseData = () => currentQueryData(deps.selectedBaseId(), baseDataQuery.data());

  const activitySource = createMemo(
    () => ({ baseId: deps.selectedBaseId(), q: deps.activitySearch().trim(), type: deps.metricTypeFilter() }),
    undefined,
    { equals: same },
  );
  const initialActivitySource = {
    baseId: initialBaseId,
    q: props.initialActivityQuery?.q ?? "",
    type: props.initialActivityQuery?.type ?? "",
  };
  const activityQuery = query.create({
    source: activitySource,
    initial: props.initialQueryCoverage.activity
      ? {
          source: initialActivitySource,
          data: {
            source: initialActivitySource,
            data: {
              events: props.initialRecentEvents ?? [],
              metrics: props.initialActivityMetrics ?? [],
              states: props.initialCurrentStates ?? [],
            },
          },
        }
      : undefined,
    enabled: () =>
      Boolean(deps.selectedBaseId()) && ["explorer", "activity-events", "activity-states", "activity-metrics"].includes(deps.activeView()),
    isSameSource: same,
    load: async (source, { abortSignal }) => ({
      source,
      data: await fetchPulseActivityData(source.baseId, { q: source.q, type: source.type }, abortSignal),
    }),
  });
  const currentActivity = () => currentQueryData(activitySource(), activityQuery.data(), same);

  const resourceListSource = createMemo(
    () => ({
      baseId: deps.selectedBaseId(),
      view: deps.activeView(),
      q: deps.resourceSearch().trim(),
      sourceId: deps.resourceSourceFilter(),
      type: deps.resourceTypeFilter(),
      ref: deps.selectedResourceKey(),
    }),
    undefined,
    { equals: same },
  );
  const initialResourceListSource = {
    baseId: initialBaseId,
    view: initialView,
    q: initialResourceQuery.q,
    sourceId: initialResourceQuery.sourceId,
    type: initialResourceQuery.type,
    ref: initialView === "resource-detail" ? (props.initialRouteState?.signalId ?? "") : (props.initialInventory?.resources[0]?.key ?? ""),
  };
  const resourceListQuery = query.create({
    source: resourceListSource,
    initial: props.initialQueryCoverage.resources
      ? {
          source: initialResourceListSource,
          data: {
            source: initialResourceListSource,
            data: props.initialInventory?.resources ?? [],
          },
        }
      : undefined,
    enabled: () => Boolean(deps.selectedBaseId()) && ["resources", "resource-detail"].includes(deps.activeView()),
    isSameSource: same,
    load: async (source, { abortSignal }) => ({
      source,
      data: await fetchPulseResources(
        source.baseId,
        source.view === "resource-detail"
          ? { ref: source.ref, limit: 20 }
          : { q: source.q, sourceId: source.sourceId, type: source.type, limit: 500 },
        abortSignal,
      ),
    }),
  });
  const currentResources = () => currentQueryData(resourceListSource(), resourceListQuery.data(), same);

  const resourceSignalsSource = createMemo(() => ({ baseId: deps.selectedBaseId(), resourceKey: deps.selectedResourceKey() }), undefined, {
    equals: same,
  });
  const initialResourceSignalsSource = { baseId: initialBaseId, resourceKey: props.initialRouteState?.signalId ?? "" };
  const resourceSignalsQuery = query.create({
    source: resourceSignalsSource,
    initial: props.initialQueryCoverage.resourceSignals
      ? {
          source: initialResourceSignalsSource,
          data: {
            source: initialResourceSignalsSource,
            data: {
              metrics: props.initialInventory?.metrics ?? [],
              states: props.initialInventory?.states ?? [],
              events: props.initialInventory?.events ?? [],
            },
          },
        }
      : undefined,
    enabled: () => deps.activeView() === "resource-detail" && Boolean(deps.selectedBaseId() && deps.selectedResourceKey()),
    isSameSource: same,
    load: async (source, { abortSignal }) => ({
      source,
      data: await fetchPulseResourceSignals(source.baseId, source.resourceKey, abortSignal),
    }),
  });
  const currentResourceSignals = () => currentQueryData(resourceSignalsSource(), resourceSignalsQuery.data(), same);

  const seriesSource = createMemo(
    () => ({ baseId: deps.selectedBaseId(), metric: deps.selectedMetric(), sourceId: deps.selectedQuerySourceId() }),
    undefined,
    { equals: same },
  );
  const seriesQuery = query.create({
    source: seriesSource,
    enabled: () => deps.activeView() === "explorer" && Boolean(deps.selectedBaseId() && deps.selectedMetric()),
    isSameSource: same,
    load: async (source, { abortSignal }) => ({
      source,
      data: await fetchPulseMetricSeries(source.baseId, source.metric, source.sourceId, abortSignal),
    }),
  });
  const currentSeries = () => currentQueryData(seriesSource(), seriesQuery.data(), same);

  const sourceDetailSource = createMemo(
    () => ({ baseId: deps.selectedBaseId(), sourceId: deps.selectedSourceId(), kind: deps.selectedSourceKind() }),
    undefined,
    { equals: same },
  );
  const initialSourceId = props.initialRouteState?.sourceId ?? "";
  const sourceDetailQuery = query.create({
    source: sourceDetailSource,
    initial:
      initialSourceId && props.initialQueryCoverage.sourceDetail
        ? {
            source: {
              baseId: initialBaseId,
              sourceId: initialSourceId,
              kind: props.initialSources?.find((source) => source.id === initialSourceId)?.kind ?? null,
            },
            data: {
              sourceId: initialSourceId,
              scrapes: props.initialSourceScrapes?.[initialSourceId] ?? [],
              apiKeys: props.initialSourceApiKeys?.[initialSourceId] ?? [],
            },
          }
        : undefined,
    enabled: () => deps.activeView() === "sources" && Boolean(deps.selectedBaseId() && deps.selectedSourceId()),
    isSameSource: same,
    load: async ({ baseId, sourceId, kind }, { abortSignal }): Promise<SourceDetail> => {
      const [scrapes, apiKeys] = await Promise.all([
        fetchPulseSourceScrapes(baseId, sourceId, abortSignal),
        kind === "http_ingest" ? fetchPulseSourceApiKeys(baseId, sourceId, abortSignal) : Promise.resolve([]),
      ]);
      return { sourceId, scrapes, apiKeys };
    },
  });

  const dashboardSource = createMemo(() => {
    const baseData = currentBaseData();
    const dashboard = baseData?.dashboards.find((item) => item.id === deps.selectedDashboardId()) ?? baseData?.dashboards[0] ?? null;
    const config = deps.activeView() === "dashboard-edit" ? (deps.dashboardPreviewConfig() ?? dashboard?.config) : dashboard?.config;
    const controlValues = dashboard ? dashboardRuntimeValues(config ?? null, deps.dashboardControlValues()[dashboard.id]) : undefined;
    return {
      baseId: deps.selectedBaseId(),
      dashboard,
      config: config ?? null,
      controlValues,
      fingerprint: JSON.stringify([deps.selectedBaseId(), dashboard?.id, config, controlValues]),
    };
  });
  const initialDashboard =
    props.initialDashboards?.find((dashboard) => dashboard.id === props.initialRouteState?.dashboardId) ??
    props.initialDashboards?.[0] ??
    null;
  const initialDashboardSource = {
    baseId: initialBaseId,
    dashboard: initialDashboard,
    config: initialDashboard?.config ?? null,
    controlValues: initialDashboard ? dashboardRuntimeValues(initialDashboard.config, props.initialDashboardControlValues) : undefined,
    fingerprint: JSON.stringify([
      initialBaseId,
      initialDashboard?.id,
      initialDashboard?.config,
      initialDashboard ? dashboardRuntimeValues(initialDashboard.config, props.initialDashboardControlValues) : undefined,
    ]),
  };
  let lastDashboardSource = initialDashboardSource.fingerprint;
  let lastDashboardData: DashboardData = {
    points: props.initialMetricWidgetPoints ?? {},
    events: props.initialDashboardEvents ?? {},
    states: props.initialDashboardStates ?? {},
    maps: props.initialDashboardMaps ?? {},
  };
  const dashboardQuery = query.create({
    source: dashboardSource,
    initial: props.initialQueryCoverage.dashboard
      ? { source: initialDashboardSource, data: { source: initialDashboardSource, data: lastDashboardData } }
      : undefined,
    enabled: () => ["dashboard", "dashboard-edit"].includes(deps.activeView()) && Boolean(dashboardSource().dashboard),
    isSameSource: (left, right) => left.fingerprint === right.fingerprint,
    load: async (source, { abortSignal }) => {
      const { baseId, dashboard, config, controlValues, fingerprint } = source;
      if (!dashboard || !config) return { source, data: { points: {}, events: {}, states: {}, maps: {} } };
      const previous = lastDashboardSource === fingerprint ? lastDashboardData : { points: {}, events: {}, states: {}, maps: {} };
      const points = Object.fromEntries(
        await Promise.all(
          dashboardMetricWidgets(config).map(async (widget) => {
            try {
              return [
                widget.id,
                await fetchDashboardMetricWidgetPoints({ baseId, config, controlValues, dashboard, signal: abortSignal, widget }),
              ] as const;
            } catch {
              return [widget.id, previous.points[widget.id] ?? []] as const;
            }
          }),
        ),
      );
      const events = Object.fromEntries(
        await Promise.all(
          dashboardEventsWidgets(config).map(async (widget) => {
            try {
              return [
                widget.id,
                await fetchDashboardEventsWidgetRows({ baseId, config, controlValues, dashboard, signal: abortSignal, widget }),
              ] as const;
            } catch {
              return [widget.id, previous.events[widget.id] ?? []] as const;
            }
          }),
        ),
      );
      const states = Object.fromEntries(
        await Promise.all(
          dashboardStatesWidgets(config).map(async (widget) => {
            try {
              return [
                widget.id,
                await fetchDashboardStatesWidgetRows({ baseId, config, controlValues, dashboard, signal: abortSignal, widget }),
              ] as const;
            } catch {
              return [widget.id, previous.states[widget.id] ?? []] as const;
            }
          }),
        ),
      );
      const maps = Object.fromEntries(
        await Promise.all(
          dashboardMapWidgets(config).map(async (widget) => {
            try {
              return [
                widget.id,
                await fetchDashboardMapWidgetSeries({ baseId, config, controlValues, dashboard, signal: abortSignal, widget }),
              ] as const;
            } catch {
              return [widget.id, previous.maps[widget.id] ?? []] as const;
            }
          }),
        ),
      );
      const next = { points, events, states, maps };
      if (!abortSignal.aborted) {
        lastDashboardSource = fingerprint;
        lastDashboardData = next;
      }
      return { source, data: next };
    },
  });
  const currentDashboard = () =>
    currentQueryData(dashboardSource(), dashboardQuery.data(), (left, right) => left.fingerprint === right.fingerprint);

  const focusedSource = createMemo(
    () => ({
      baseId: deps.selectedBaseId(),
      view: deps.activeView() as FocusedRowsView,
      signalId: deps.focusedSignalId(),
      search: deps.focusedSearch().trim(),
    }),
    undefined,
    { equals: same },
  );
  const focusedView = ["metric-detail", "state-detail", "event-detail"].includes(initialView) ? (initialView as FocusedRowsView) : null;
  const initialFocusedRows =
    focusedView === "metric-detail"
      ? (props.initialFocusedMetricSeries ?? [])
      : focusedView === "state-detail"
        ? (props.initialFocusedStates ?? [])
        : (props.initialFocusedEvents ?? []);
  const initialFocusedSearch = new URLSearchParams(props.initialSearch ?? "").get("q")?.trim() ?? "";
  const initialFocusedSource = focusedView
    ? {
        baseId: initialBaseId,
        view: focusedView,
        signalId: props.initialRouteState?.signalId ?? "",
        search: initialFocusedSearch,
      }
    : null;
  const focusedQuery = query.createInfinite<FocusedSource, QuerySnapshot<FocusedSource, FocusedPage>, number>({
    source: focusedSource,
    initial:
      initialFocusedSource && props.initialQueryCoverage.focused
        ? {
            source: initialFocusedSource,
            pages: [
              {
                source: initialFocusedSource,
                data: {
                  result: {
                    view: initialFocusedSource.view,
                    rows: initialFocusedRows,
                    hasMore: props.initialFocusedHasMore ?? false,
                  } as FocusedRowsPage,
                  nextOffset: initialFocusedRows.length,
                },
              },
            ],
          }
        : undefined,
    enabled: () =>
      ["metric-detail", "state-detail", "event-detail"].includes(deps.activeView()) &&
      Boolean(deps.selectedBaseId() && deps.focusedSignalId()),
    isSameSource: same,
    loadPage: async (source, { cursor, abortSignal }) => {
      const offset = cursor ?? 0;
      const result = await fetchFocusedRowsPage({
        baseId: source.baseId,
        offset,
        pageSize: FOCUSED_PAGE_SIZE,
        search: source.search,
        signal: abortSignal,
        signalId: source.signalId,
        view: source.view,
      });
      return { source, data: { result, nextOffset: offset + result.rows.length } };
    },
    getNextCursor: (page) => (page.data.result.hasMore ? page.data.nextOffset : null),
  });
  const currentFocusedPages = () =>
    focusedQuery
      .pages()
      .filter((page) => same(page.source, focusedSource()))
      .map((page) => page.data);

  const focusedMetricSeries = createMemo(() =>
    deps.activeView() === "metric-detail"
      ? currentFocusedPages().flatMap((page) => (page.result.view === "metric-detail" ? page.result.rows : []))
      : [],
  );
  const focusedStates = createMemo(() =>
    deps.activeView() === "state-detail"
      ? currentFocusedPages().flatMap((page) => (page.result.view === "state-detail" ? page.result.rows : []))
      : [],
  );
  const focusedEvents = createMemo(() =>
    deps.activeView() === "event-detail"
      ? currentFocusedPages().flatMap((page) => (page.result.view === "event-detail" ? page.result.rows : []))
      : [],
  );
  const inventory = createMemo<PulseInventory>(() => {
    const base = currentBaseData()?.inventory ?? emptyInventory();
    const signals = currentResourceSignals();
    const resourceChanged = Boolean(resourceListQuery.data() && !currentResources());
    const resourceSignalsChanged = Boolean(resourceSignalsQuery.data() && !signals);
    return {
      ...base,
      resources: currentResources() ?? (resourceChanged ? [] : base.resources),
      metrics: deps.activeView() === "resource-detail" ? (signals?.metrics ?? (resourceSignalsChanged ? [] : base.metrics)) : base.metrics,
      states: deps.activeView() === "resource-detail" ? (signals?.states ?? (resourceSignalsChanged ? [] : base.states)) : base.states,
      events: deps.activeView() === "resource-detail" ? (signals?.events ?? (resourceSignalsChanged ? [] : base.events)) : base.events,
    };
  });

  return {
    activityMetrics: () => currentActivity()?.metrics ?? [],
    baseData: currentBaseData,
    bases: () => basesQuery.data() ?? [],
    currentStates: () => currentActivity()?.states ?? [],
    dashboardEvents: () => currentDashboard()?.events ?? {},
    dashboardMaps: () => currentDashboard()?.maps ?? {},
    dashboards: () => currentBaseData()?.dashboards ?? [],
    dashboardStates: () => currentDashboard()?.states ?? {},
    focusedEvents,
    focusedHasMore: () => currentFocusedPages().length > 0 && focusedQuery.hasMore(),
    focusedLoadingMore: focusedQuery.loadingMore,
    focusedMetricSeries,
    focusedStates,
    inventory,
    metrics: () => currentBaseData()?.metrics ?? [],
    metricWidgetPoints: () => currentDashboard()?.points ?? {},
    recentEvents: () => currentActivity()?.events ?? [],
    savedQueries: () => currentBaseData()?.savedQueries ?? [],
    series: () => currentSeries() ?? [],
    sourceApiKeys: () => {
      const detail = sourceDetailQuery.data();
      return detail ? { [detail.sourceId]: detail.apiKeys } : {};
    },
    sourceScrapes: () => {
      const detail = sourceDetailQuery.data();
      return detail ? { [detail.sourceId]: detail.scrapes } : {};
    },
    sources: () => currentBaseData()?.sources ?? [],
    queries: {
      activity: { ...activityQuery, data: currentActivity },
      baseData: { ...baseDataQuery, data: currentBaseData },
      bases: basesQuery,
      dashboard: { ...dashboardQuery, data: currentDashboard },
      focused: {
        ...focusedQuery,
        pages: currentFocusedPages,
        hasMore: () => currentFocusedPages().length > 0 && focusedQuery.hasMore(),
      },
      resources: { ...resourceListQuery, data: currentResources },
      resourceSignals: { ...resourceSignalsQuery, data: currentResourceSignals },
      series: { ...seriesQuery, data: currentSeries },
      sourceDetail: sourceDetailQuery,
    },
  };
};
