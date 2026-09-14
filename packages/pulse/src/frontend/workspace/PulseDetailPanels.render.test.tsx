import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type {
  PulseCurrentState,
  PulseMetricSeries,
  PulseRecordedEvent,
  PulseResourceMetric,
  PulseResourceSummary,
  PulseSource,
} from "../../contracts";
import type { ResourceDetailSelection } from "./ResourceDetailView";

const ssrRoot = mkdtempSync(join(tmpdir(), "pulse-detail-panel-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: ssrRoot });
Bun.plugin(plugin());
process.once("exit", () => rmSync(ssrRoot, { recursive: true, force: true }));

const { FocusedEventDetail, FocusedMetricSeriesDetail, FocusedStateDetail } = await import("./FocusedSignalDetails");
const { default: ResourceDetailView, ResourceSignalDetail } = await import("./ResourceDetailView");
const { default: SourceDetailView } = await import("./SourceDetailView");

const now = "2026-08-09T10:00:00.000Z";
const dateContext = { timeZone: "UTC", locale: "en", firstDayOfWeek: 1, now } as const;
const sourceNames = () => new Map([["source-1", "Node exporter"]]);

const source: PulseSource = {
  id: "source-1",
  baseId: "base-1",
  kind: "metrics",
  name: "Node exporter",
  enabled: true,
  endpointUrl: "https://metrics.example.test",
  bearerTokenConfigured: true,
  scrapeIntervalSeconds: 60,
  lastSeenAt: now,
  lastError: null,
  lastErrorAt: null,
  createdAt: now,
  updatedAt: now,
};

const metricSeries: PulseMetricSeries = {
  id: "series-1",
  metric: "system.cpu.usage",
  sourceId: source.id,
  resourceKey: "node-1",
  resourceType: "host",
  dimensions: { cpu: "0" },
  lastSeenAt: now,
  latestValue: 42,
  latestSampleAt: now,
};

const state: PulseCurrentState = {
  variantKey: "fixture-0",
  key: "system.online",
  value: true,
  sourceId: source.id,
  resourceKey: "node-1",
  resourceType: "host",
  dimensions: { region: "eu" },
  updatedAt: now,
};

const event: PulseRecordedEvent = {
  id: "event-1",
  kind: "system.restarted",
  ts: now,
  value: 1,
  sourceId: source.id,
  resourceKey: "node-1",
  resourceType: "host",
  dimensions: { region: "eu" },
  attributes: {},
  payload: { reason: "upgrade" },
  recordedAt: now,
};

const resourceMetric: PulseResourceMetric = {
  seriesId: "resource-series-1",
  resourceKey: "host:node-1",
  resourceId: "node-1",
  resourceType: "host",
  metric: "system.cpu.usage",
  type: "gauge",
  unit: "%",
  sourceId: source.id,
  dimensions: { cpu: "0" },
  lastSeenAt: now,
  latestValue: 42,
  latestSampleAt: now,
};

const resource: PulseResourceSummary = {
  key: "host:node-1",
  id: "node-1",
  label: "Node 1",
  type: "host",
  sourceIds: [source.id],
  metricSeriesCount: 1,
  metricCount: 1,
  eventCount: 1,
  stateCount: 1,
  lastSeenAt: now,
  dimensions: { region: "eu" },
};

describe("Pulse detail panels", () => {
  test("renders resource signal navigation as controlled tabs instead of panes", () => {
    const selection: ResourceDetailSelection = {
      activeTab: () => "metrics",
      setActiveTab: () => {},
      selectedMetric: () => null,
      selectedState: () => null,
      selectedEvent: () => null,
      selectMetric: () => {},
      selectState: () => {},
      selectEvent: () => {},
      close: () => {},
      open: () => false,
    };
    const html = renderToString(() =>
      createComponent(ResourceDetailView, {
        resource,
        metrics: [resourceMetric],
        states: [state],
        events: [event],
        dateContext,
        sourceNameById: sourceNames,
        selection,
        openSource: () => {},
        openMetricQuery: () => {},
        openMetricVariants: () => {},
        openStateQuery: () => {},
        openStateVariants: () => {},
        openEventQuery: () => {},
        openEventVariants: () => {},
      }),
    );

    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Resource signals"');
    expect(html).toContain("Metrics 1");
    expect(html).not.toContain("data-k2b-panes");
  });

  test("renders source identity, actions, facts, and specialized scrape content in one detail body", () => {
    const html = renderToString(() =>
      createComponent(SourceDetailView, {
        source,
        published: { resources: 1, metricVariants: 2, states: 3, events: 4 },
        origin: "https://cloud.example.test",
        dateContext,
        loading: false,
        scrapes: [],
        apiKeys: [],
        scrapeColumns: [{ id: "status", header: "Status" }],
        renderScrapeCell: () => null,
        copySetupText: () => {},
        openSourceResources: () => {},
        editSource: () => {},
        toggleSource: () => {},
        close: () => {},
        scrape: () => {},
        removeSource: () => {},
        createApiKey: async () => {
          throw new Error("not used");
        },
        revokeApiKey: async () => {},
      }),
    );

    expect(html.match(/k2b-detail-panel__body/g)).toHaveLength(1);
    expect(html).toContain("Node exporter");
    expect(html).toContain("Close source details");
    expect(html).toContain("Scrape history");
    expect(html).toContain("No scrapes recorded yet.");
    expect(html).toContain("Danger zone");
    expect(html.indexOf("Edit")).toBeLessThan(html.indexOf("Pause"));
    expect(html.indexOf("Pause")).toBeLessThan(html.indexOf("Resources"));
    expect(html.indexOf("Resources")).toBeLessThan(html.indexOf("Scrape"));
    expect(html).not.toContain("detail-stack");
    expect(html).not.toContain("detail-row");
    expect(html).not.toContain("detail-header");
  });

  test("renders focused metric, state, and event variants with source actions and structured context", () => {
    const shared = {
      sourceId: source.id,
      sourceNameById: sourceNames,
      dateContext,
      openSource: () => {},
      openQuery: () => {},
      close: () => {},
    };
    const html = renderToString(() => [
      createComponent(FocusedMetricSeriesDetail, {
        ...shared,
        item: metricSeries,
        metricName: metricSeries.metric,
        metricUnit: "%",
      }),
      createComponent(FocusedStateDetail, { ...shared, state }),
      createComponent(FocusedEventDetail, { ...shared, event }),
    ]);

    expect(html.match(/k2b-detail-panel__body/g)).toHaveLength(3);
    expect(html.match(/Open query/g)).toHaveLength(3);
    expect(html.match(/Open source/g)).toHaveLength(3);
    expect(html).toContain("Metric variant");
    expect(html).toContain("State variant");
    expect(html).toContain("Event row");
    expect(html).toContain("Payload");
    expect(html).not.toContain("detail-stack");
    expect(html).not.toContain("detail-row");
    expect(html).not.toContain("detail-header");
  });

  test("keeps inactive resource signal details mounted while only the active branch is visible", () => {
    const selection: ResourceDetailSelection = {
      activeTab: () => "metrics",
      setActiveTab: () => {},
      selectedMetric: () => resourceMetric,
      selectedState: () => state,
      selectedEvent: () => event,
      selectMetric: () => {},
      selectState: () => {},
      selectEvent: () => {},
      close: () => {},
      open: () => true,
    };
    const html = renderToString(() =>
      createComponent(ResourceSignalDetail, {
        resource,
        metrics: [resourceMetric],
        states: [state],
        events: [event],
        dateContext,
        sourceNameById: sourceNames,
        selection,
        openSource: () => {},
        openMetricQuery: () => {},
        openMetricVariants: () => {},
        openStateQuery: () => {},
        openStateVariants: () => {},
        openEventQuery: () => {},
        openEventVariants: () => {},
      }),
    );

    expect(html.match(/k2b-detail-panel__body/g)).toHaveLength(3);
    expect(html.match(/class="hidden"/g)).toHaveLength(2);
    expect(html).toContain("Close metric details");
    expect(html).toContain("Close state details");
    expect(html).toContain("Close event details");
    expect(html.match(/All variants/g)).toHaveLength(3);
    expect(html).not.toContain("detail-stack");
    expect(html).not.toContain("detail-row");
    expect(html).not.toContain("detail-header");
  });
});
