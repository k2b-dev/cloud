import type { ResourceApiKey } from "@valentinkolb/cloud/access/ui";
import type { ServiceError } from "@k2b/stdlib";
import { type AuthContext, expectUserBackedActor, getDateConfig } from "@valentinkolb/cloud/server";
import { get as getSetting } from "@valentinkolb/cloud/services";
import type { Context } from "hono";
import type {
  MetricQueryPoint,
  MetricType,
  PulseCurrentState,
  PulseDashboard,
  PulseDashboardConfig,
  PulseDashboardControl,
  PulseDashboardEventsWidget,
  PulseDashboardMapWidget,
  PulseDashboardStatesWidget,
  PulseInventory,
  PulseMapSeries,
  PulseMetricSeries,
  PulseRecordedEvent,
  PulseResourceMetric,
  PulseResourceSummary,
  PulseSource,
  PulseSourceScrape,
} from "../../contracts";
import { SHORT_ID_REGEX } from "../../lib/short-id";
import { pulseService } from "../../service";
import type { UserScope } from "../../service/access-control";
import {
  projectBases,
  projectDashboards,
  projectPublicRelations,
  projectSavedQueries,
  projectSources,
  resolveBasePublicId,
  resolvePublicId,
} from "../../service/public-resources";
import type { DashboardTextQuery } from "../../service/query-management";
import { metricWidgetQueryText } from "../workspace/dashboard-runtime";
import {
  dashboardEventsWidgets,
  dashboardMapWidgets,
  dashboardMetricWidgets,
  dashboardStatesWidgets,
  FOCUSED_PAGE_SIZE,
  quoteQueryPart,
} from "../workspace/helpers";
import { DASHBOARD_EDITOR_PANES_KEY, QUERY_EXPLORER_PANES_KEY, readPulsePanesLayoutCookie } from "../workspace/panes-state";
import {
  readActivityQueryState,
  readDashboardControlQueryState,
  readResourceQueryState,
  readWorkspacePathState,
  type WorkspaceRouteState,
} from "../workspace/routes";
import type { PulseWorkspaceProps } from "../workspace/types";

type PulseUser = UserScope;
type DashboardControlValues = Record<string, string>;
type PulseWorkspacePageContext<T extends AuthContext = AuthContext> = Context<T>;

type PulseWorkspacePageData =
  | {
      kind: "error";
      status: ServiceError["status"];
    }
  | {
      kind: "ok";
      baseName: string;
      workspaceProps: PulseWorkspaceProps;
    };

type SelectedSourceData = {
  initialSourceScrapes: Record<string, PulseSourceScrape[]>;
  initialSourceApiKeys: Record<string, ResourceApiKey[]>;
  covered: boolean;
};

type FocusedSignalData = {
  initialFocusedMetricSeries: PulseMetricSeries[];
  initialFocusedEvents: PulseRecordedEvent[];
  initialFocusedStates: PulseCurrentState[];
  initialFocusedHasMore: boolean;
  covered: boolean;
};

type DashboardWidgetData = {
  initialMetricWidgetPoints: Record<string, MetricQueryPoint[]>;
  initialDashboardEvents: Record<string, PulseRecordedEvent[]>;
  initialDashboardStates: Record<string, PulseCurrentState[]>;
  initialDashboardMaps: Record<string, PulseMapSeries[]>;
  covered: boolean;
};

type ResourceInitialData = {
  inventory: PulseInventory;
  inventoryCovered: boolean;
  resourcesCovered: boolean;
  resourceSignalsCovered: boolean;
};

const dashboardControlValues = (config: PulseDashboardConfig, values: DashboardControlValues): DashboardControlValues =>
  Object.fromEntries(
    (config.layout?.controls ?? []).map((control: PulseDashboardControl) => [
      control.variable,
      values[control.variable] ?? control.defaultValue,
    ]),
  );

const resolveDashboardQueryText = (text: string, config: PulseDashboardConfig, values: DashboardControlValues): string => {
  const controls = dashboardControlValues(config, values);
  return text.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, variable: string) =>
    typeof controls[variable] === "string" ? quoteQueryPart(controls[variable]) : match,
  );
};

const widgetQueryText = (
  widget: PulseDashboardEventsWidget | PulseDashboardStatesWidget,
  dashboard: PulseDashboard,
  controlValues: DashboardControlValues,
): string => resolveDashboardQueryText(widget.queryText, dashboard.config, controlValues);

const emptyInventory = (): PulseInventory => ({ resources: [], metrics: [], events: [], states: [], fields: [] });

const dataOr = <T>(result: { ok: boolean; data?: T }, fallback: T): T => (result.ok ? (result.data as T) : fallback);

const activityQueryInput = (query: { q: string; type: MetricType | "" }) => ({
  q: query.q || undefined,
  type: query.type || undefined,
});

const resourceListQueryInput = (searchParams: URLSearchParams) => ({
  q: searchParams.get("q")?.trim() || undefined,
  sourceId: searchParams.get("source")?.trim() || undefined,
  type: searchParams.get("type")?.trim() || undefined,
  limit: 500,
});

const selectedDashboard = (dashboards: PulseDashboard[], dashboardId: string | null): PulseDashboard | null =>
  dashboards.find((dashboard) => dashboard.id === dashboardId) ?? dashboards[0] ?? null;

const selectedSource = (sources: PulseSource[], sourceId: string | null): PulseSource | null =>
  sources.find((source) => source.id === sourceId) ?? null;

const publicOrigin = (rawAppUrl: string | null | undefined, requestOrigin: string): string => {
  const raw = String(rawAppUrl ?? "").trim();
  if (!raw) return requestOrigin;
  const withScheme = /^https?:\/\//i.test(raw)
    ? raw
    : raw.startsWith("localhost") || raw.startsWith("127.") || raw.startsWith("[::1]")
      ? `http://${raw}`
      : `https://${raw}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return requestOrigin;
  }
};

const loadSelectedSourceData = async (baseId: string, user: PulseUser, selectedSource: PulseSource | null): Promise<SelectedSourceData> => {
  if (!selectedSource) return { initialSourceScrapes: {}, initialSourceApiKeys: {}, covered: true };

  const [scrapesResult, apiKeysResult] = await Promise.all([
    pulseService.source.scrapes({ baseId, sourceId: selectedSource.id, user }),
    loadSelectedSourceApiKeys(baseId, user, selectedSource),
  ]);

  return {
    initialSourceScrapes: scrapesResult.ok ? { [selectedSource.id]: scrapesResult.data } : {},
    initialSourceApiKeys: apiKeysResult ? { [selectedSource.id]: apiKeysResult } : {},
    covered: scrapesResult.ok && (selectedSource.kind !== "http_ingest" || apiKeysResult !== null),
  };
};

const loadSelectedSourceApiKeys = async (
  baseId: string,
  user: PulseUser,
  selectedSource: PulseSource,
): Promise<ResourceApiKey[] | null> => {
  if (selectedSource.kind !== "http_ingest") return null;
  const result = await pulseService.source.apiKeys.list({ baseId, sourceId: selectedSource.id, user });
  return result.ok ? result.data : null;
};

const emptyFocusedSignalData = (): FocusedSignalData => ({
  initialFocusedMetricSeries: [],
  initialFocusedEvents: [],
  initialFocusedStates: [],
  initialFocusedHasMore: false,
  covered: true,
});

const hasMoreFocusedRows = (rows: unknown[]): boolean => rows.length > FOCUSED_PAGE_SIZE;

const visibleFocusedRows = <T>(rows: T[]): T[] => rows.slice(0, FOCUSED_PAGE_SIZE);

const loadFocusedMetricSeries = async (
  baseId: string,
  user: PulseUser,
  metric: string,
  q: string | undefined,
): Promise<FocusedSignalData> => {
  const result = await pulseService.query.series(baseId, user, { metric, q, limit: FOCUSED_PAGE_SIZE + 1 });
  if (!result.ok) return { ...emptyFocusedSignalData(), covered: false };
  return {
    initialFocusedMetricSeries: visibleFocusedRows(result.data),
    initialFocusedEvents: [],
    initialFocusedStates: [],
    initialFocusedHasMore: hasMoreFocusedRows(result.data),
    covered: true,
  };
};

const loadFocusedEvents = async (baseId: string, user: PulseUser, kind: string, q: string | undefined): Promise<FocusedSignalData> => {
  const result = await pulseService.query.recentEvents(baseId, user, { kind, q, limit: FOCUSED_PAGE_SIZE + 1 });
  if (!result.ok) return { ...emptyFocusedSignalData(), covered: false };
  return {
    initialFocusedMetricSeries: [],
    initialFocusedEvents: visibleFocusedRows(result.data),
    initialFocusedStates: [],
    initialFocusedHasMore: hasMoreFocusedRows(result.data),
    covered: true,
  };
};

const loadFocusedStates = async (baseId: string, user: PulseUser, key: string, q: string | undefined): Promise<FocusedSignalData> => {
  const result = await pulseService.query.currentStates(baseId, user, { key, q, limit: FOCUSED_PAGE_SIZE + 1 });
  if (!result.ok) return { ...emptyFocusedSignalData(), covered: false };
  return {
    initialFocusedMetricSeries: [],
    initialFocusedEvents: [],
    initialFocusedStates: visibleFocusedRows(result.data),
    initialFocusedHasMore: hasMoreFocusedRows(result.data),
    covered: true,
  };
};

const loadFocusedSignalData = async (
  baseId: string,
  user: PulseUser,
  routeState: WorkspaceRouteState,
  searchParams: URLSearchParams,
): Promise<FocusedSignalData> => {
  if (!routeState.signalId) return emptyFocusedSignalData();
  const q = searchParams.get("q")?.trim() || undefined;
  if (routeState.view === "metric-detail") return loadFocusedMetricSeries(baseId, user, routeState.signalId, q);
  if (routeState.view === "event-detail") return loadFocusedEvents(baseId, user, routeState.signalId, q);
  if (routeState.view === "state-detail") return loadFocusedStates(baseId, user, routeState.signalId, q);
  return emptyFocusedSignalData();
};

const loadDashboardWidgetData = async (
  baseId: string,
  user: PulseUser,
  routeState: WorkspaceRouteState,
  selectedDashboard: PulseDashboard | null,
  controlValues: DashboardControlValues,
): Promise<DashboardWidgetData> => {
  if (!selectedDashboard || (routeState.view !== "dashboard" && routeState.view !== "dashboard-edit")) {
    return {
      initialMetricWidgetPoints: {},
      initialDashboardEvents: {},
      initialDashboardStates: {},
      initialDashboardMaps: {},
      covered: true,
    };
  }

  const metricWidgets = dashboardMetricWidgets(selectedDashboard.config);
  const eventWidgets = dashboardEventsWidgets(selectedDashboard.config);
  const stateWidgets = dashboardStatesWidgets(selectedDashboard.config);
  const mapWidgets = dashboardMapWidgets(selectedDashboard.config);
  const requests: DashboardTextQuery[] = [
    ...metricWidgets.map((widget) => ({
      kind: "query" as const,
      query: resolveDashboardQueryText(metricWidgetQueryText(widget), selectedDashboard.config, controlValues),
    })),
    ...eventWidgets.map((widget) => ({ kind: "query" as const, query: widgetQueryText(widget, selectedDashboard, controlValues) })),
    ...stateWidgets.map((widget) => ({ kind: "query" as const, query: widgetQueryText(widget, selectedDashboard, controlValues) })),
    ...mapWidgets.map((widget: PulseDashboardMapWidget) => ({
      kind: "map" as const,
      query: resolveDashboardQueryText(widget.queryText, selectedDashboard.config, controlValues),
      latitude: widget.latitude,
      longitude: widget.longitude,
      label: widget.label,
      series: widget.series,
      size: widget.size,
    })),
  ];
  const results = await pulseService.query.dashboardTexts({ baseId, requests, user });
  let offset = 0;
  const metricWidgetPointEntries = metricWidgets.map((widget): [string, MetricQueryPoint[], boolean] => {
    const result = results[offset++];
    return [widget.id, result?.ok && result.data.kind === "query" ? result.data.data.points : [], result?.ok === true];
  });
  const eventEntries = eventWidgets.map((widget): [string, PulseRecordedEvent[], boolean] => {
    const result = results[offset++];
    return [widget.id, result?.ok && result.data.kind === "query" ? result.data.data.events : [], result?.ok === true];
  });
  const stateEntries = stateWidgets.map((widget): [string, PulseCurrentState[], boolean] => {
    const result = results[offset++];
    return [widget.id, result?.ok && result.data.kind === "query" ? result.data.data.states : [], result?.ok === true];
  });
  const mapEntries = mapWidgets.map((widget): [string, PulseMapSeries[], boolean] => {
    const result = results[offset++];
    return [widget.id, result?.ok && result.data.kind === "map" ? result.data.data : [], result?.ok === true];
  });

  return {
    initialMetricWidgetPoints: Object.fromEntries(metricWidgetPointEntries.map(([id, data]) => [id, data])),
    initialDashboardEvents: Object.fromEntries(eventEntries.map(([id, data]) => [id, data])),
    initialDashboardStates: Object.fromEntries(stateEntries.map(([id, data]) => [id, data])),
    initialDashboardMaps: Object.fromEntries(mapEntries.map(([id, data]) => [id, data])),
    covered: [...metricWidgetPointEntries, ...eventEntries, ...stateEntries, ...mapEntries].every(([, , ok]) => ok),
  };
};

const exactResourceMatch = (resources: PulseResourceSummary[], ref: string): PulseResourceSummary | null =>
  resources.find((resource) => resource.key === ref || resource.id === ref || resource.label === ref) ?? resources[0] ?? null;

const projectSourceKeyed = <T>(value: Record<string, T[]> | undefined, sourceIds: Map<string, string>): Record<string, T[]> | undefined =>
  value ? Object.fromEntries(Object.entries(value).map(([sourceId, rows]) => [sourceIds.get(sourceId) ?? sourceId, rows])) : undefined;

const projectWorkspaceProps = async (
  props: Partial<PulseWorkspaceProps> & Pick<PulseWorkspaceProps, "initialQueryCoverage">,
): Promise<Partial<PulseWorkspaceProps> & Pick<PulseWorkspaceProps, "initialQueryCoverage">> => {
  const internalSources = props.initialSources ?? [];
  const [sources, dashboards, savedQueries] = await Promise.all([
    projectSources(internalSources),
    projectDashboards(props.initialDashboards ?? []),
    projectSavedQueries(props.initialSavedQueries ?? []),
  ]);
  const sourceIds = new Map(internalSources.map((source, index) => [source.id, sources[index]!.id]));
  return projectPublicRelations({
    ...props,
    initialSources: sources,
    initialSourceScrapes: projectSourceKeyed(props.initialSourceScrapes, sourceIds),
    initialSourceApiKeys: props.initialSourceApiKeys
      ? Object.fromEntries(
          Object.entries(props.initialSourceApiKeys).map(([sourceId, rows]) => [sourceIds.get(sourceId) ?? sourceId, rows]),
        )
      : undefined,
    initialDashboards: dashboards,
    initialSavedQueries: savedQueries,
  });
};

const loadResourceInitialData = async (
  baseId: string,
  user: PulseUser,
  routeState: WorkspaceRouteState,
  searchParams: URLSearchParams,
): Promise<ResourceInitialData> => {
  if (routeState.view === "resource-detail") {
    const ref = routeState.signalId.trim();
    if (!ref) return { inventory: emptyInventory(), inventoryCovered: false, resourcesCovered: true, resourceSignalsCovered: true };
    const resourcesResult = await pulseService.query.resources(baseId, user, { ref, limit: 20 });
    const resources = dataOr(resourcesResult, []);
    const resource = exactResourceMatch(resources, ref);
    if (!resource)
      return {
        inventory: { ...emptyInventory(), resources },
        inventoryCovered: false,
        resourcesCovered: resourcesResult.ok,
        resourceSignalsCovered: true,
      };

    const [metricsResult, statesResult, eventsResult] = await Promise.all([
      pulseService.query.resourceMetrics(baseId, user, { resourceKey: resource.key, limit: 500 }),
      pulseService.query.resourceStates(baseId, user, { resourceKey: resource.key, limit: 500 }),
      pulseService.query.resourceEvents(baseId, user, { resourceKey: resource.key, limit: 500 }),
    ]);

    return {
      inventory: {
        ...emptyInventory(),
        resources,
        metrics: dataOr<PulseResourceMetric[]>(metricsResult, []),
        states: dataOr<PulseCurrentState[]>(statesResult, []),
        events: dataOr<PulseRecordedEvent[]>(eventsResult, []),
      },
      inventoryCovered: false,
      resourcesCovered: resourcesResult.ok,
      resourceSignalsCovered: metricsResult.ok && statesResult.ok && eventsResult.ok,
    };
  }

  if (routeState.view === "resources") {
    const resourcesResult = await pulseService.query.resources(baseId, user, resourceListQueryInput(searchParams));
    return {
      inventory: {
        ...emptyInventory(),
        resources: dataOr(resourcesResult, []),
      },
      inventoryCovered: false,
      resourcesCovered: resourcesResult.ok,
      resourceSignalsCovered: true,
    };
  }

  const inventoryResult = await pulseService.query.inventory(baseId, user);
  return {
    inventory: dataOr(inventoryResult, emptyInventory()),
    inventoryCovered: inventoryResult.ok,
    resourcesCovered: true,
    resourceSignalsCovered: true,
  };
};

export async function loadPulseWorkspacePageData<T extends AuthContext>(c: PulseWorkspacePageContext<T>): Promise<PulseWorkspacePageData> {
  const user = expectUserBackedActor(c);
  const url = new URL(c.req.raw.url);
  const publicBaseId = c.req.param("baseId") ?? "";
  if (!SHORT_ID_REGEX.test(publicBaseId)) return { kind: "error", status: 404 };
  const baseId = await resolvePublicId("bases", publicBaseId);
  if (!baseId) return { kind: "error", status: 404 };
  const publicRouteState = readWorkspacePathState(url.pathname, publicBaseId);
  const routeState: WorkspaceRouteState = { ...publicRouteState };
  if (routeState.sourceId) {
    const sourceId = await resolveBasePublicId("sources", baseId, routeState.sourceId);
    if (!sourceId) return { kind: "error", status: 404 };
    routeState.sourceId = sourceId;
  }
  if (routeState.dashboardId) {
    const dashboardId = await resolveBasePublicId("dashboards", baseId, routeState.dashboardId);
    if (!dashboardId) return { kind: "error", status: 404 };
    routeState.dashboardId = dashboardId;
  }
  const publicResourceQuery = readResourceQueryState(url.search);
  const internalSearchParams = new URLSearchParams(url.searchParams);
  const sourceFilter = internalSearchParams.get("source")?.trim();
  if (sourceFilter) {
    const sourceId = await resolveBasePublicId("sources", baseId, sourceFilter);
    if (sourceId) internalSearchParams.set("source", sourceId);
    else {
      internalSearchParams.delete("source");
      publicResourceQuery.sourceId = "";
    }
  }
  const [basesResult, baseResult, capabilitiesResult] = await Promise.all([
    pulseService.base.list(user),
    pulseService.base.get(baseId, user),
    pulseService.capabilities(),
  ]);

  if (!baseResult.ok) {
    return { kind: "error", status: baseResult.error.status };
  }

  const base = baseResult.data;
  const activityQuery = readActivityQueryState(url.search);
  const dashboardControlValues = readDashboardControlQueryState(url.search);
  const [appUrl, workspaceData] = await Promise.all([
    getSetting<string>("app.url").catch(() => ""),
    loadPulseWorkspaceInitialData({
      user,
      baseId: base.id,
      routeState,
      activityQuery,
      dashboardControlValues,
      searchParams: internalSearchParams,
    }),
  ]);

  const projectedBases = basesResult.ok ? await projectBases(basesResult.data) : [];
  const projected = await projectWorkspaceProps(workspaceData);
  return {
    kind: "ok",
    baseName: base.name,
    workspaceProps: {
      initialBases: projectedBases,
      initialCapabilities: dataOr(capabilitiesResult, null),
      initialBaseId: publicBaseId,
      initialPath: url.pathname,
      initialSearch: url.search,
      initialRouteState: publicRouteState,
      initialActivityQuery: activityQuery,
      initialResourceQuery: publicResourceQuery,
      initialDashboardControlValues: dashboardControlValues,
      initialExplorerPanesLayout: readPulsePanesLayoutCookie(c.req.header("Cookie"), QUERY_EXPLORER_PANES_KEY),
      initialDashboardEditorPanesLayout: readPulsePanesLayoutCookie(c.req.header("Cookie"), DASHBOARD_EDITOR_PANES_KEY),
      initialDateConfig: getDateConfig(c),
      initialNow: new Date().toISOString(),
      initialOrigin: publicOrigin(appUrl, url.origin),
      ...projected,
      initialQueryCoverage: { ...workspaceData.initialQueryCoverage, bases: basesResult.ok },
    },
  };
}

async function loadPulseWorkspaceInitialData(params: {
  user: PulseUser;
  baseId: string;
  routeState: WorkspaceRouteState;
  activityQuery: { q: string; type: MetricType | "" };
  dashboardControlValues: DashboardControlValues;
  searchParams: URLSearchParams;
}): Promise<Partial<PulseWorkspaceProps> & Pick<PulseWorkspaceProps, "initialQueryCoverage">> {
  const activityQuery = activityQueryInput(params.activityQuery);
  const [
    sourcesResult,
    metricsResult,
    resourceData,
    activityMetricsResult,
    dashboardsResult,
    savedQueriesResult,
    eventsResult,
    statesResult,
  ] = await Promise.all([
    pulseService.source.list(params.baseId, params.user),
    pulseService.query.metrics(params.baseId, params.user, {}),
    loadResourceInitialData(params.baseId, params.user, params.routeState, params.searchParams),
    pulseService.query.metrics(params.baseId, params.user, activityQuery),
    pulseService.dashboard.list(params.baseId, params.user),
    pulseService.savedQuery.list(params.baseId, params.user),
    pulseService.query.recentEvents(params.baseId, params.user, { q: activityQuery.q }),
    pulseService.query.currentStates(params.baseId, params.user, { q: activityQuery.q }),
  ]);
  const sources = dataOr(sourcesResult, []);
  const dashboards = dataOr(dashboardsResult, []);
  const dashboard = selectedDashboard(dashboards, params.routeState.dashboardId);
  const source = selectedSource(sources, params.routeState.sourceId);
  const [sourceData, focusedData, widgetData] = await Promise.all([
    loadSelectedSourceData(params.baseId, params.user, source),
    loadFocusedSignalData(params.baseId, params.user, params.routeState, params.searchParams),
    loadDashboardWidgetData(params.baseId, params.user, params.routeState, dashboard, params.dashboardControlValues),
  ]);

  return {
    initialQueryCoverage: {
      activity: activityMetricsResult.ok && eventsResult.ok && statesResult.ok,
      baseData: sourcesResult.ok && metricsResult.ok && dashboardsResult.ok && savedQueriesResult.ok && resourceData.inventoryCovered,
      bases: false,
      dashboard: widgetData.covered,
      focused: focusedData.covered,
      resources: resourceData.resourcesCovered,
      resourceSignals: resourceData.resourceSignalsCovered,
      sourceDetail: sourceData.covered,
    },
    initialSources: sources,
    initialSourceScrapes: sourceData.initialSourceScrapes,
    initialSourceApiKeys: sourceData.initialSourceApiKeys,
    initialMetrics: dataOr(metricsResult, []),
    initialInventory: resourceData.inventory,
    initialActivityMetrics: dataOr(activityMetricsResult, []),
    initialRecentEvents: dataOr(eventsResult, []),
    initialCurrentStates: dataOr(statesResult, []),
    initialFocusedMetricSeries: focusedData.initialFocusedMetricSeries,
    initialFocusedEvents: focusedData.initialFocusedEvents,
    initialFocusedStates: focusedData.initialFocusedStates,
    initialFocusedHasMore: focusedData.initialFocusedHasMore,
    initialDashboards: dashboards,
    initialSavedQueries: dataOr(savedQueriesResult, []),
    initialMetricWidgetPoints: widgetData.initialMetricWidgetPoints,
    initialDashboardEvents: widgetData.initialDashboardEvents,
    initialDashboardStates: widgetData.initialDashboardStates,
    initialDashboardMaps: widgetData.initialDashboardMaps,
  };
}
