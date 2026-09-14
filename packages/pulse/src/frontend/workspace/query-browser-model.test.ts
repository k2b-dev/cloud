import { describe, expect, test } from "bun:test";
import type {
  PulseCurrentState,
  PulseInventory,
  PulseMetricSeries,
  PulseMetricSummary,
  PulseRecordedEvent,
  PulseSource,
} from "../../contracts";
import {
  buildBrowseEntities,
  buildBrowseEvents,
  buildBrowseLabels,
  buildBrowseMetrics,
  buildBrowseSources,
  buildBrowseStates,
  filterBrowseSeries,
} from "./query-browser-model";

const matchesAll = () => true;
const matchesTerm =
  (term: string) =>
  (values: Array<string | null | undefined>): boolean =>
    values.some((value) => value?.toLowerCase().includes(term.toLowerCase()));

const source = (overrides: Partial<PulseSource>): PulseSource => ({
  id: "source-a",
  baseId: "base-a",
  kind: "http_ingest",
  name: "Docker",
  enabled: true,
  endpointUrl: null,
  bearerTokenConfigured: false,
  scrapeIntervalSeconds: null,
  lastSeenAt: null,
  lastError: null,
  lastErrorAt: null,
  createdAt: "2026-07-10T10:00:00.000Z",
  updatedAt: "2026-07-10T10:00:00.000Z",
  ...overrides,
});

const metric = (overrides: Partial<PulseMetricSummary>): PulseMetricSummary => ({
  name: "system.cpu.usage",
  unit: "percent",
  type: "gauge",
  seriesCount: 2,
  lastSeenAt: "2026-07-10T10:00:00.000Z",
  ...overrides,
});

const series = (overrides: Partial<PulseMetricSeries>): PulseMetricSeries => ({
  id: "series-a",
  metric: "system.cpu.usage",
  sourceId: "source-a",
  resourceKey: "host:alpha",
  resourceType: "host",
  dimensions: { host: "alpha", service: "api" },
  lastSeenAt: "2026-07-10T10:00:00.000Z",
  latestValue: 42,
  latestSampleAt: "2026-07-10T10:00:00.000Z",
  ...overrides,
});

const event = (overrides: Partial<PulseRecordedEvent>): PulseRecordedEvent => ({
  id: "event-a",
  kind: "deploy.finished",
  ts: "2026-07-10T10:00:00.000Z",
  value: null,
  sourceId: "source-a",
  resourceKey: "host:alpha",
  resourceType: "host",
  dimensions: { host: "alpha", service: "api" },
  attributes: {},
  payload: {},
  recordedAt: "2026-07-10T10:00:00.000Z",
  ...overrides,
});

const state = (overrides: Partial<PulseCurrentState>): PulseCurrentState => ({
  variantKey: "fixture-0",
  key: "service.online",
  value: true,
  sourceId: "source-a",
  resourceKey: "host:alpha",
  resourceType: "host",
  dimensions: { host: "alpha", service: "api" },
  updatedAt: "2026-07-10T10:00:00.000Z",
  ...overrides,
});

const inventory = (overrides: Partial<PulseInventory> = {}): PulseInventory => ({
  resources: [
    {
      key: "host:alpha",
      id: "alpha",
      label: "alpha",
      type: "host",
      sourceIds: ["source-a"],
      metricSeriesCount: 1,
      metricCount: 1,
      eventCount: 0,
      stateCount: 0,
      lastSeenAt: "2026-07-10T10:00:00.000Z",
      dimensions: { host: "alpha" },
    },
  ],
  metrics: [],
  events: [],
  states: [],
  fields: [],
  ...overrides,
});

describe("Pulse query browser model", () => {
  test("builds browse entities from resources and unlisted signal entities", () => {
    const entities = buildBrowseEntities({
      inventory: inventory(),
      series: [series({ resourceKey: "host:beta", dimensions: { host: "beta" } })],
      events: [event({ resourceKey: "host:beta", dimensions: { host: "beta", service: "worker" } })],
      states: [state({ resourceKey: "host:gamma", dimensions: { host: "gamma" } })],
    });

    expect(entities.map((resource) => [resource.id, resource.metricCount, resource.eventCount, resource.stateCount])).toEqual([
      ["host:beta", 1, 1, 0],
      ["host:alpha", 1, 0, 0],
      ["host:gamma", 0, 0, 1],
    ]);
    expect(entities.find((resource) => resource.id === "host:beta")?.sourceIds).toEqual(["source-a"]);
    expect(entities.find((resource) => resource.id === "host:beta")?.dimensions).toEqual({ host: "beta", service: "worker" });
  });

  test("scopes metric rows to selected source and resource", () => {
    const scoped = filterBrowseSeries(
      [
        series({ id: "cpu-alpha", resourceKey: "host:alpha", sourceId: "source-a" }),
        series({ id: "cpu-beta", resourceKey: "host:beta", sourceId: "source-a" }),
        series({ id: "cpu-other-source", resourceKey: "host:alpha", sourceId: "source-b" }),
      ],
      { sourceId: "source-a", resourceKey: "host:alpha" },
    );
    const rows = buildBrowseMetrics({
      metrics: [metric({ name: "system.cpu.usage" }), metric({ name: "system.memory.usage" })],
      scopedSeries: scoped,
      allSeries: scoped,
      selectedEntityDimensions: { host: "alpha" },
      resourceKey: "host:alpha",
      matches: matchesAll,
    });

    expect(scoped.map((item) => item.id)).toEqual(["cpu-alpha"]);
    expect(rows.map((row) => [row.metric.name, row.seriesCount, row.sampleDimensions])).toEqual([
      ["system.cpu.usage", 1, { host: "alpha", service: "api" }],
    ]);
  });

  test("groups browse events and states with scope and search filters", () => {
    const events = buildBrowseEvents(
      [
        event({ id: "deploy-1", kind: "deploy.finished" }),
        event({ id: "deploy-2", kind: "deploy.finished" }),
        event({ id: "alert-1", kind: "alert.opened", dimensions: { host: "alpha", severity: "critical" } }),
        event({ id: "other-source", sourceId: "source-b" }),
      ],
      { sourceId: "source-a", resourceKey: "host:alpha" },
      matchesTerm("deploy"),
    );
    const states = buildBrowseStates(
      [
        state({ key: "service.online" }),
        state({ key: "service.online", resourceKey: "host:beta" }),
        state({ key: "service.version", dimensions: { host: "alpha", version: "1.2.3" } }),
      ],
      { sourceId: "source-a", resourceKey: "host:alpha" },
      matchesTerm("service"),
    );

    expect(events.map((row) => [row.kind, row.count, row.sample.id])).toEqual([["deploy.finished", 2, "deploy-1"]]);
    expect(states.map((row) => [row.key, row.count, row.sample.resourceKey])).toEqual([
      ["service.online", 1, "host:alpha"],
      ["service.version", 1, "host:alpha"],
    ]);
  });

  test("builds source and label summaries for clickable query narrowing", () => {
    const sourceRows = buildBrowseSources({
      sources: [source({ id: "source-a", name: "Docker" }), source({ id: "source-b", name: "Finance" })],
      series: [series({ sourceId: "source-a" }), series({ sourceId: "source-b" })],
      events: [event({ sourceId: "source-a" })],
      states: [state({ sourceId: "source-a" })],
      matches: matchesTerm("docker"),
    });
    const labels = buildBrowseLabels({
      scopedSeries: [
        series({ dimensions: { host: "alpha", service: "api" } }),
        series({ dimensions: { host: "alpha", service: "worker" } }),
      ],
      events: [event({ dimensions: { host: "alpha", severity: "critical" } })],
      states: [state({ dimensions: { host: "beta", service: "api" } })],
      scope: { sourceId: "source-a", resourceKey: "" },
      matches: matchesAll,
    });

    expect(sourceRows.map((row) => [row.source.name, row.metricCount, row.eventCount, row.stateCount])).toEqual([["Docker", 1, 1, 1]]);
    expect(labels.find((group) => group.key === "service")?.values).toEqual([
      { key: "service", value: "api", count: 2 },
      { key: "service", value: "worker", count: 1 },
    ]);
    expect(labels.find((group) => group.key === "host")?.count).toBe(4);
  });
});

test("merges inventory and signal rows by the full resource key", () => {
  const inventory: PulseInventory = {
    resources: [
      {
        key: "host:alpha",
        id: "alpha",
        label: "Alpha",
        type: "host",
        sourceIds: ["source-a"],
        metricCount: 1,
        metricSeriesCount: 1,
        eventCount: 0,
        stateCount: 0,
        lastSeenAt: null,
        dimensions: {},
      },
    ],
    metrics: [],
    events: [],
    states: [],
    fields: [],
  };
  const rows = buildBrowseEntities({ inventory, series: [series({})], events: [], states: [] });
  expect(rows).toHaveLength(1);
  expect(rows[0]?.id).toBe("host:alpha");
});
