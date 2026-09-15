import { describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { PulseDashboard, PulseMetricSeries, PulseSource } from "../../contracts";
import type { PulseWorkspaceProps, PulseWorkspaceQueryCoverage, WorkspaceView } from "./types";
import { createPulseWorkspaceQueries } from "./workspace-queries";
import { createWorkspaceDerivedModel } from "./workspace-derived-model";
import { createPulseWorkspaceState } from "./workspace-state";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

const row = (id: string): PulseMetricSeries => ({
  id,
  metric: "requests",
  sourceId: "source-1",
  resourceKey: null,
  resourceType: null,
  dimensions: {},
  lastSeenAt: null,
  latestValue: 1,
  latestSampleAt: null,
});

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const pendingFetch = (): typeof fetch => Object.assign(() => new Promise<Response>(() => {}), { preconnect: globalThis.fetch.preconnect });

const fullCoverage: PulseWorkspaceQueryCoverage = {
  activity: true,
  baseData: true,
  bases: true,
  dashboard: true,
  focused: true,
  resources: true,
  resourceSignals: true,
  sourceDetail: true,
};

const queryDeps = (view: WorkspaceView, overrides: Partial<Parameters<typeof createPulseWorkspaceQueries>[1]> = {}) => ({
  activeView: () => view,
  activitySearch: () => "",
  dashboardControlValues: () => ({}),
  dashboardPreviewConfig: () => null,
  focusedSearch: () => "",
  focusedSignalId: () => "",
  metricTypeFilter: () => "" as const,
  resourceSearch: () => "",
  resourceSourceFilter: () => "",
  resourceTypeFilter: () => "",
  selectedBaseId: () => "base-1",
  selectedDashboardId: () => "",
  selectedMetric: () => "",
  selectedQuerySourceId: () => "",
  selectedResourceKey: () => "",
  selectedSourceId: () => "",
  selectedSourceKind: () => null,
  ...overrides,
});

const queryProps = (overrides: Partial<PulseWorkspaceProps> = {}): PulseWorkspaceProps => ({
  initialBases: [],
  initialCapabilities: null,
  initialQueryCoverage: fullCoverage,
  initialBaseId: "base-1",
  initialRouteState: { view: "resources", dashboardId: "", sourceId: "", signalId: "" },
  initialActivityQuery: { q: "", type: "" },
  initialInventory: { resources: [], metrics: [], events: [], states: [], fields: [] },
  ...overrides,
});

describe("Pulse workspace queries", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("preserves SSR source names while the uncovered inventory loads without leaking them to another base", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = pendingFetch();
    const source: PulseSource = {
      id: "Src001",
      baseId: "base-1",
      name: "Server 1",
      kind: "http_ingest",
      enabled: true,
      endpointUrl: null,
      bearerTokenConfigured: false,
      scrapeIntervalSeconds: 60,
      lastSeenAt: null,
      lastError: null,
      lastErrorAt: null,
      createdAt: "2026-09-15T00:00:00.000Z",
      updatedAt: "2026-09-15T00:00:00.000Z",
    };
    let controls!: ReturnType<typeof createPulseWorkspaceQueries>;
    let selectBase!: (id: string) => void;
    const dispose = render(() => {
      const [selectedBaseId, setSelectedBaseId] = createSignal("base-1");
      selectBase = setSelectedBaseId;
      controls = createPulseWorkspaceQueries(
        queryProps({ initialSources: [source], initialQueryCoverage: { ...fullCoverage, baseData: false } }),
        queryDeps("resources", { selectedBaseId }),
      );
      return dom.document.createTextNode("");
    }, dom.root);
    try {
      expect(controls.sources()).toEqual([source]);
      await flush();
      expect(controls.sources()).toEqual([source]);
      selectBase("base-2");
      expect(controls.sources()).toEqual([]);
    } finally {
      dispose();
      dom.cleanup();
      globalThis.fetch = originalFetch;
    }
  });

  test("shares load-more, aborts it for invalidation, and atomically commits the rebuilt focused chain", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; signal: AbortSignal; response: ReturnType<typeof deferred<Response>> }> = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const response = deferred<Response>();
      requests.push({ url: String(input), signal: init?.signal as AbortSignal, response });
      return response.promise;
    }) as typeof fetch;

    let controls!: ReturnType<typeof createPulseWorkspaceQueries>;
    const dispose = render(() => {
      const [focusedSearch] = createSignal("");
      controls = createPulseWorkspaceQueries(
        queryProps({
          initialBaseId: "base-1",
          initialRouteState: { view: "metric-detail", dashboardId: "", sourceId: "", signalId: "requests" },
          initialResourceQuery: { q: "", sourceId: "", type: "" },
          initialFocusedMetricSeries: [row("initial")],
          initialFocusedHasMore: true,
        }),
        queryDeps("metric-detail", {
          focusedSearch,
          focusedSignalId: () => "requests",
        }),
      );
      return dom.document.createTextNode("");
    }, dom.root);

    await flush();
    expect(requests).toHaveLength(0);
    const first = controls.queries.focused.loadMore();
    const shared = controls.queries.focused.loadMore();
    expect(shared).toBe(first);
    await flush();
    expect(requests[0]!.url).toContain("offset=1");

    const covered = controls.queries.focused.invalidate();
    await flush();
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(requests[1]!.url).toContain("offset=0");
    requests[0]!.response.resolve(Response.json([row("stale")]));
    requests[1]!.response.resolve(Response.json([row("fresh")]));
    await covered;
    expect(controls.focusedMetricSeries().map((item) => item.id)).toEqual(["fresh"]);
    expect(controls.focusedHasMore()).toBe(false);

    dispose();
    dom.cleanup();
    globalThis.fetch = originalFetch;
  });

  test("uses exact SSR sources and reloads only uncovered snapshots", async () => {
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      requests.push(String(input));
      return Response.json([]);
    }) as typeof fetch;

    const renderQueries = (coverage: PulseWorkspaceQueryCoverage) => {
      const dom = createDomTestHarness();
      const dispose = render(() => {
        createPulseWorkspaceQueries(
          queryProps({
            initialQueryCoverage: coverage,
            initialSearch: "?q=cpu&source=source-1&type=server",
            initialRouteState: { view: "resources", dashboardId: "", sourceId: "", signalId: "" },
          }),
          queryDeps("resources", {
            resourceSearch: () => "cpu",
            resourceSourceFilter: () => "source-1",
            resourceTypeFilter: () => "server",
          }),
        );
        return dom.document.createTextNode("");
      }, dom.root);
      return { dom, dispose };
    };

    try {
      const covered = renderQueries(fullCoverage);
      await flush();
      expect(requests).toHaveLength(0);
      covered.dispose();
      covered.dom.cleanup();

      const uncovered = renderQueries({ ...fullCoverage, resources: false });
      await flush();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain("q=cpu");
      expect(requests[0]).toContain("sourceId=source-1");
      expect(requests[0]).toContain("type=server");
      uncovered.dispose();
      uncovered.dom.cleanup();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("hides base data as soon as the selected base changes", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = pendingFetch();
    const [baseId, setBaseId] = createSignal("base-1");
    let controls!: ReturnType<typeof createPulseWorkspaceQueries>;
    const dispose = render(() => {
      controls = createPulseWorkspaceQueries(queryProps(), queryDeps("resources", { selectedBaseId: baseId }));
      return dom.document.createTextNode("");
    }, dom.root);

    try {
      expect(controls.queries.baseData.data()).toBeDefined();
      setBaseId("base-2");
      await flush();
      expect(controls.queries.baseData.data()).toBeUndefined();
      expect(controls.baseData()).toBeUndefined();
    } finally {
      dispose();
      dom.cleanup();
      globalThis.fetch = originalFetch;
    }
  });

  test("hides activity and series data under changed filters", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const requests: Array<ReturnType<typeof deferred<Response>>> = [];
    globalThis.fetch = Object.assign(
      () => {
        const response = deferred<Response>();
        requests.push(response);
        return response.promise;
      },
      { preconnect: globalThis.fetch.preconnect },
    );
    const [activitySearch, setActivitySearch] = createSignal("");
    const [selectedMetric, setSelectedMetric] = createSignal("requests");
    let controls!: ReturnType<typeof createPulseWorkspaceQueries>;
    const dispose = render(() => {
      controls = createPulseWorkspaceQueries(
        queryProps({ initialRouteState: { view: "explorer", dashboardId: "", sourceId: "", signalId: "" } }),
        queryDeps("explorer", { activitySearch, selectedMetric }),
      );
      return dom.document.createTextNode("");
    }, dom.root);

    try {
      await flush();
      requests[0]!.resolve(Response.json([row("old")]));
      for (let attempt = 0; attempt < 10 && !controls.queries.series.data(); attempt++) await flush();
      expect(controls.queries.activity.data()).toBeDefined();
      expect(controls.series().map((item) => item.id)).toEqual(["old"]);

      setActivitySearch("errors");
      setSelectedMetric("latency");
      await flush();
      expect(controls.queries.activity.data()).toBeUndefined();
      expect(controls.queries.series.data()).toBeUndefined();
      expect(controls.series()).toEqual([]);
    } finally {
      dispose();
      dom.cleanup();
      globalThis.fetch = originalFetch;
    }
  });

  test("hides resource data as soon as the selected resource changes", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = pendingFetch();
    const [resourceKey, setResourceKey] = createSignal("");
    let controls!: ReturnType<typeof createPulseWorkspaceQueries>;
    const dispose = render(() => {
      controls = createPulseWorkspaceQueries(queryProps(), queryDeps("resources", { selectedResourceKey: resourceKey }));
      return dom.document.createTextNode("");
    }, dom.root);

    try {
      expect(controls.queries.resources.data()).toBeDefined();
      expect(controls.queries.resourceSignals.data()).toBeDefined();
      setResourceKey("resource-2");
      await flush();
      expect(controls.queries.resources.data()).toBeUndefined();
      expect(controls.queries.resourceSignals.data()).toBeUndefined();
    } finally {
      dispose();
      dom.cleanup();
      globalThis.fetch = originalFetch;
    }
  });

  test("hides focused pages as soon as their source changes", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = pendingFetch();
    const [focusedSearch, setFocusedSearch] = createSignal("");
    let controls!: ReturnType<typeof createPulseWorkspaceQueries>;
    const dispose = render(() => {
      controls = createPulseWorkspaceQueries(
        queryProps({
          initialRouteState: { view: "metric-detail", dashboardId: "", sourceId: "", signalId: "requests" },
          initialFocusedMetricSeries: [row("old")],
          initialFocusedHasMore: true,
        }),
        queryDeps("metric-detail", { focusedSearch, focusedSignalId: () => "requests" }),
      );
      return dom.document.createTextNode("");
    }, dom.root);

    try {
      expect(controls.focusedMetricSeries().map((item) => item.id)).toEqual(["old"]);
      setFocusedSearch("errors");
      await flush();
      expect(controls.queries.focused.pages()).toEqual([]);
      expect(controls.focusedMetricSeries()).toEqual([]);
      expect(controls.focusedHasMore()).toBe(false);
    } finally {
      dispose();
      dom.cleanup();
      globalThis.fetch = originalFetch;
    }
  });

  test("marks a failed dashboard refresh stale and preserves the last complete snapshot", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const metric = JSON.parse(String(init?.body)).query.includes("broken") ? "broken" : "healthy";
      return metric === "broken" ? new Response("failed", { status: 500 }) : Response.json({ points: [{ bucket: "new", value: 2 }] });
    }) as typeof fetch;
    const metricWidget = (id: string, metric: string) => ({
      id,
      kind: "metric" as const,
      title: id,
      visual: "line" as const,
      queryText: `metric ${metric} avg every 5m since 24h`,
      query: { kind: "metric" as const, metric, aggregation: "avg" as const, bucket: "5m", since: "24h" },
    });
    const dashboard: PulseDashboard = {
      id: "dashboard-1",
      baseId: "base-1",
      name: "Operations",
      config: {
        dsl: "",
        layout: {
          version: 1,
          sections: [
            {
              id: "section-1",
              kind: "section",
              title: "Overview",
              rows: [
                {
                  id: "row-1",
                  kind: "row",
                  height: "md",
                  cells: [metricWidget("broken", "broken"), metricWidget("healthy", "healthy")],
                },
              ],
            },
          ],
        },
      },
      publicEnabled: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    let controls!: ReturnType<typeof createPulseWorkspaceQueries>;
    const dispose = render(() => {
      controls = createPulseWorkspaceQueries(
        queryProps({
          initialRouteState: { view: "dashboard", dashboardId: dashboard.id, sourceId: "", signalId: "" },
          initialDashboards: [dashboard],
          initialMetricWidgetPoints: { broken: [{ bucket: "old", value: 1 }], healthy: [{ bucket: "old", value: 1 }] },
        }),
        queryDeps("dashboard", { selectedDashboardId: () => dashboard.id }),
      );
      return dom.document.createTextNode("");
    }, dom.root);

    try {
      await flush();
      expect(controls.metricWidgetPoints().broken).toEqual([{ bucket: "old", value: 1 }]);
      await controls.queries.dashboard.refresh();
      expect(controls.queries.dashboard.error()).toBeTruthy();
      expect(controls.metricWidgetPoints().broken).toEqual([{ bucket: "old", value: 1 }]);
      expect(controls.metricWidgetPoints().healthy).toEqual([{ bucket: "old", value: 1 }]);
    } finally {
      dispose();
      dom.cleanup();
      globalThis.fetch = originalFetch;
    }
  });

  test("does not let an aborted dashboard load replace the current last-good snapshot", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const requests: Array<{ response: ReturnType<typeof deferred<Response>>; signal: AbortSignal }> = [];
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      const response = deferred<Response>();
      requests.push({ response, signal: init?.signal as AbortSignal });
      return response.promise;
    }) as typeof fetch;
    const [controlValues, setControlValues] = createSignal({ "dashboard-1": { range: "old" } });
    const dashboard: PulseDashboard = {
      id: "dashboard-1",
      baseId: "base-1",
      name: "Operations",
      config: {
        dsl: "",
        layout: {
          version: 1,
          controls: [{ id: "range", kind: "range", variable: "range", label: "Range", defaultValue: "old" }],
          sections: [
            {
              id: "section-1",
              kind: "section",
              title: "Overview",
              rows: [
                {
                  id: "row-1",
                  kind: "row",
                  height: "md",
                  cells: [
                    {
                      id: "metric-1",
                      kind: "metric",
                      title: "Requests",
                      visual: "line",
                      queryText: "metric requests avg every 5m since $range",
                      query: { kind: "metric", metric: "requests", aggregation: "avg", bucket: "5m", since: "24h" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      publicEnabled: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    let controls!: ReturnType<typeof createPulseWorkspaceQueries>;
    const dispose = render(() => {
      controls = createPulseWorkspaceQueries(
        queryProps({
          initialRouteState: { view: "dashboard", dashboardId: dashboard.id, sourceId: "", signalId: "" },
          initialDashboards: [dashboard],
          initialDashboardControlValues: { range: "old" },
          initialMetricWidgetPoints: { "metric-1": [{ bucket: "initial", value: 1 }] },
        }),
        queryDeps("dashboard", { dashboardControlValues: controlValues, selectedDashboardId: () => dashboard.id }),
      );
      return dom.document.createTextNode("");
    }, dom.root);

    try {
      await flush();
      const stale = controls.queries.dashboard.refresh();
      await flush();
      setControlValues({ "dashboard-1": { range: "new" } });
      expect(controls.queries.dashboard.data()).toBeUndefined();
      expect(controls.metricWidgetPoints()).toEqual({});
      const fresh = controls.queries.dashboard.refresh();
      await flush();
      expect(requests).toHaveLength(2);
      expect(requests[0]!.signal.aborted).toBe(true);

      requests[1]!.response.resolve(Response.json({ points: [{ bucket: "fresh", value: 2 }] }));
      await fresh;
      requests[0]!.response.resolve(Response.json({ points: [{ bucket: "stale", value: 0 }] }));
      await stale;
      await flush();

      const retry = controls.queries.dashboard.refresh();
      await flush();
      requests[2]!.response.resolve(new Response("failed", { status: 500 }));
      await retry;
      expect(controls.metricWidgetPoints()["metric-1"]).toEqual([{ bucket: "fresh", value: 2 }]);
    } finally {
      dispose();
      dom.cleanup();
      globalThis.fetch = originalFetch;
    }
  });
});

(isServer ? test.skip : test)("unchanged base refresh preserves selected dashboard controls while real edits propagate", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  const dashboard: PulseDashboard = {
    id: "dashboard-1",
    baseId: "base-1",
    name: "Ops",
    config: {
      dsl: "",
      layout: { version: 1, sections: [], controls: [{ id: "range", kind: "range", variable: "period", label: "Range", defaultValue: "1h" }] },
    },
    publicEnabled: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  let responseDashboard = dashboard;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = String(input);
      return Response.json(
        path.endsWith("/dashboards")
          ? [responseDashboard]
          : path.endsWith("/inventory")
            ? { resources: [], metrics: [], events: [], states: [], fields: [] }
            : [],
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  let queries!: ReturnType<typeof createPulseWorkspaceQueries>;
  let model!: ReturnType<typeof createWorkspaceDerivedModel>;
  const props = queryProps({ initialDashboards: [dashboard] });
  const dispose = render(() => {
    const local = createPulseWorkspaceState(props);
    queries = createPulseWorkspaceQueries(props, queryDeps("resources"));
    model = createWorkspaceDerivedModel(props, { ...local, ...queries });
    return dom.document.createTextNode("");
  }, dom.root);
  try {
    const original = model.selectedDashboard();
    expect(original).toBe(dashboard);
    await queries.queries.baseData.refresh();
    expect(model.selectedDashboard()).toBe(original);
    expect(model.selectedDashboard()?.config.layout?.controls?.[0]).toBe(original?.config.layout?.controls?.[0]);
    responseDashboard = { ...dashboard, name: "Changed" };
    await queries.queries.baseData.refresh();
    expect(model.selectedDashboard()?.name).toBe("Changed");
    expect(model.selectedDashboard()).not.toBe(original);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
