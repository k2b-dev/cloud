import { describe, expect, test } from "bun:test";
import type { PulseExplorerQuery } from "../../contracts";
import { compileDashboardDsl } from "../../dashboard-dsl";
import { compilePulseQueryText } from "../../query-dsl";
import {
  compactMetricUnit,
  currentStateQueryText,
  dashboardCellSpan,
  dashboardDslCompileError,
  dashboardDslPreviewIsCurrent,
  dashboardPreviewConfigFromResult,
  dashboardQueryLine,
  dashboardWidgetSnippetFromQuery,
  defaultMetricAggregation,
  emptyDashboardDsl,
  eventKindQueryText,
  formatMetricValue,
  formatValue,
  gaugeMax,
  queryWithDimensionFilter,
  queryWithSourceFilter,
  recordedEventQueryText,
  resourceMetricQueryText,
  shouldSkipDashboardDslPreview,
  sourceCreatedMessage,
  sourceCreateRequest,
  sourceCreateValidationError,
  sourceInitialScrapeFailureMessage,
  sourceInitialScrapeSuccessMessage,
  stateKeyQueryText,
} from "./helpers";

const compileSnippet = (snippet: string) =>
  compileDashboardDsl(
    `dashboard "Test" {
  section "Main" {
    ${snippet
      .split("\n")
      .map((line) => (line.trim() ? `    ${line}` : line))
      .join("\n")}
  }
}`,
    (query) => {
      const compiled = compilePulseQueryText("base", query);
      return compiled.ok ? { ok: true, data: compiled.data } : { ok: false, message: compiled.error.message };
    },
  );

describe("Pulse workspace dashboard snippets", () => {
  test("builds dashboard DSL compile error diagnostics", () => {
    expect(dashboardDslCompileError(new Error("Broken DSL"))).toEqual({
      ok: false,
      diagnostics: [{ severity: "error", message: "Broken DSL", line: 1, column: 1 }],
      config: null,
    });
  });

  test("normalizes dashboard DSL preview guards", () => {
    expect(shouldSkipDashboardDslPreview("", 'dashboard "A" {}')).toBe(true);
    expect(shouldSkipDashboardDslPreview("base-a", "  ")).toBe(true);
    expect(shouldSkipDashboardDslPreview("base-a", 'dashboard "A" {}')).toBe(false);
    expect(
      dashboardDslPreviewIsCurrent({
        currentDashboardId: "dash-a",
        currentRequestId: 2,
        currentText: "dashboard",
        dashboardId: "dash-a",
        requestId: 2,
        text: "dashboard",
      }),
    ).toBe(true);
    expect(
      dashboardDslPreviewIsCurrent({
        currentDashboardId: "dash-b",
        currentRequestId: 2,
        currentText: "dashboard",
        dashboardId: "dash-a",
        requestId: 2,
        text: "dashboard",
      }),
    ).toBe(false);
    expect(dashboardPreviewConfigFromResult({ ok: false, diagnostics: [], config: null })).toBeNull();
  });

  test("builds source create request payloads", () => {
    expect(sourceCreateRequest({ kind: "http_ingest", name: "" })).toEqual({ kind: "http_ingest", name: "Telemetry push" });
    expect(
      sourceCreateRequest({
        kind: "metrics",
        name: " API ",
        endpointUrl: "api.example.test/metrics",
        bearerToken: " secret ",
        scrapeIntervalSeconds: 5,
      }),
    ).toEqual({
      kind: "metrics",
      name: "API",
      endpointUrl: "https://api.example.test/metrics",
      bearerToken: "secret",
      scrapeIntervalSeconds: 10,
    });
    expect(
      sourceCreateRequest({
        kind: "metrics",
        name: "",
        endpointUrl: "http://localhost:9100/metrics",
        scrapeIntervalSeconds: 999_999,
      }),
    ).toEqual({
      kind: "metrics",
      name: "Metrics endpoint",
      endpointUrl: "http://localhost:9100/metrics",
      bearerToken: null,
      scrapeIntervalSeconds: 86_400,
    });
  });

  test("normalizes source creation validation and messages", () => {
    expect(sourceCreateValidationError({ kind: "http_ingest", name: "" })).toBeNull();
    expect(sourceCreateValidationError({ kind: "metrics", name: "API", endpointUrl: "" })).toBe("Endpoint URL is required");
    expect(sourceCreatedMessage("http_ingest")).toBe("HTTP ingest source created");
    expect(sourceCreatedMessage("metrics")).toBe("Metrics source created");
    expect(sourceInitialScrapeSuccessMessage({ metrics: 2, events: 1, states: 0 })).toBe(
      "Metrics source added and scraped: 2 metrics, 1 event, 0 states",
    );
    expect(sourceInitialScrapeFailureMessage(new Error("No route"))).toBe("Source added, initial scrape failed: No route");
    expect(sourceInitialScrapeFailureMessage("bad")).toBe("Source added, initial scrape failed");
  });

  test("builds query text helpers for explorer navigation", () => {
    expect(defaultMetricAggregation("counter")).toBe("rate");
    expect(defaultMetricAggregation("histogram")).toBe("p95");
    expect(defaultMetricAggregation("gauge")).toBe("latest");
    expect(queryWithDimensionFilter("metric cpu latest since 1h", "host", "Mac Book")).toBe(
      'metric cpu latest since 1h where host="Mac Book"',
    );
    expect(queryWithDimensionFilter("metric cpu latest since 1h where region=eu", "host", "Mac Book")).toBe(
      'metric cpu latest since 1h where region=eu, host="Mac Book"',
    );
    expect(queryWithSourceFilter("metric cpu latest since 1h", "source-a")).toBe("metric cpu latest since 1h source source-a");
    expect(queryWithSourceFilter("metric cpu latest since 1h source source-a", "source-b")).toBe(
      "metric cpu latest since 1h source source-a",
    );
    expect(eventKindQueryText("deploy finished", { sourceId: "source-a", resourceKey: "service:api" })).toBe(
      'events "deploy finished" since 24h source source-a resource service:api limit 100',
    );
    expect(stateKeyQueryText("service.online", { sourceId: "source-a", resourceKey: "service:api" })).toBe(
      "states service.online since 10m source source-a resource service:api limit 100",
    );
  });

  test("builds resource scoped query text", () => {
    expect(
      resourceMetricQueryText({
        seriesId: "series-a",
        resourceKey: "container:api",
        resourceId: "container:api",
        resourceType: "container",
        metric: "docker.container.cpu.usage",
        type: "gauge",
        unit: "percent",
        sourceId: "source-a",
        dimensions: { container: "api", compose_service: "api web" },
        lastSeenAt: null,
        latestValue: 12,
        latestSampleAt: null,
      }),
    ).toBe(
      'metric docker.container.cpu.usage latest every 1m since 24h source source-a resource container:api where container=api, compose_service="api web"',
    );

    expect(
      recordedEventQueryText({
        id: "event-a",
        kind: "docker.error",
        ts: "2026-01-01T00:00:00.000Z",
        value: null,
        sourceId: "source-a",
        resourceKey: "container:api",
        resourceType: "container",
        dimensions: { collector: "docker", message: "context deadline exceeded", ignored: "still included" },
        attributes: {},
        payload: {},
        recordedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe(
      'events docker.error since 24h source source-a resource container:api where collector=docker, message="context deadline exceeded", ignored="still included" limit 100',
    );

    expect(
      currentStateQueryText({
        variantKey: "fixture-0",
        key: "docker.container.running",
        value: true,
        sourceId: "source-a",
        resourceKey: "container:api",
        resourceType: "container",
        dimensions: { container: "api" },
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe("states docker.container.running since 10m source source-a resource container:api where container=api limit 100");
  });

  test("creates empty dashboard DSL without starter widgets", () => {
    expect(emptyDashboardDsl("Ops", "Production health")).toBe('dashboard "Ops" {\n  description "Production health"\n}');
    expect(emptyDashboardDsl("Ops")).toBe('dashboard "Ops" {\n}');
  });

  test("auto-splits dashboard rows without explicit spans", () => {
    expect(dashboardCellSpan(undefined, 1)).toBe(12);
    expect(dashboardCellSpan(undefined, 2)).toBe(6);
    expect(dashboardCellSpan(undefined, 3)).toBe(4);
    expect(dashboardCellSpan(undefined, 4)).toBe(3);
    expect(dashboardCellSpan(8, 3)).toBe(8);
  });

  test("formats metric values with readable units", () => {
    expect(formatValue(10)).toBe("10");
    expect(formatMetricValue(100, "percent")).toBe("100%");
    expect(formatMetricValue(61.29, "percentage")).toBe("61.29%");
    expect(formatMetricValue(10, "count")).toBe("10");
    expect(formatMetricValue(199, "count")).toBe("199");
    expect(formatMetricValue(411_210, "seconds")).toBe("4d 18h");
    expect(formatMetricValue(1_536, "bytes")).toBe("1.5 KiB");
  });

  test("formats metric units compactly for charts", () => {
    expect(compactMetricUnit("percent")).toBe("%");
    expect(compactMetricUnit("percentage")).toBe("%");
    expect(compactMetricUnit("bytes")).toBe("B");
    expect(compactMetricUnit("seconds")).toBe("s");
    expect(compactMetricUnit("count")).toBeUndefined();
    expect(gaugeMax("percent", 61)).toBe(100);
  });

  test("normalizes query lines without changing quoted values", () => {
    expect(dashboardQueryLine(" metric app.orders sum\n  every  1h \n where customer=\"ACME  North\" env='prod  blue' ")).toBe(
      "metric app.orders sum every 1h where customer=\"ACME  North\" env='prod  blue'",
    );
  });

  test("copies metric queries as selected visual widgets", () => {
    const query = "metric system.cpu.usage avg every 5m since 24h where host=server";
    const compiled = compilePulseQueryText("base", query);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const snippet = dashboardWidgetSnippetFromQuery(query, compiled.data as PulseExplorerQuery, "gauge");
    expect(snippet).toContain('gauge "system.cpu.usage"');
    expect(compileSnippet(snippet).ok).toBe(true);
  });

  test("copies line visual metric queries as line syntax", () => {
    const query = "metric system.cpu.usage avg every 5m since 24h";
    const compiled = compilePulseQueryText("base", query);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const snippet = dashboardWidgetSnippetFromQuery(query, compiled.data as PulseExplorerQuery, "line");
    expect(snippet).toContain('line "system.cpu.usage"');
    expect(compileSnippet(snippet).ok).toBe(true);
  });

  test("copies event queries as table widgets", () => {
    const query = "events deploy.finished since 24h limit 25";
    const compiled = compilePulseQueryText("base", query);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const snippet = dashboardWidgetSnippetFromQuery(query, compiled.data as PulseExplorerQuery, "line");
    expect(snippet).toContain('table "deploy.finished"');
    expect(compileSnippet(snippet).ok).toBe(true);
  });

  test("copies state queries as table widgets", () => {
    const query = "states service.online since 10m resource_type service limit 50";
    const compiled = compilePulseQueryText("base", query);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const snippet = dashboardWidgetSnippetFromQuery(query, compiled.data as PulseExplorerQuery, "stat");
    expect(snippet).toContain('table "service.online"');
    expect(compileSnippet(snippet).ok).toBe(true);
  });
});
