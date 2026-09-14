import { describe, expect, test } from "bun:test";
import type { PulseCurrentState, PulseMetricSeries, PulseMetricSummary, PulseRecordedEvent, PulseSource } from "../contracts";
import {
  buildReferenceEntityChips,
  buildReferenceEventQuery,
  buildReferenceEventRows,
  buildReferenceMetricQuery,
  buildReferenceMetricRows,
  buildReferenceSourceChips,
  buildReferenceStateQuery,
  buildReferenceStateRows,
  quotePulseQueryValue,
} from "./query-reference-inventory";

const sourceA: PulseSource = {
  id: "source-a",
  baseId: "base",
  kind: "http_ingest",
  name: "Docker",
  enabled: true,
  endpointUrl: null,
  bearerTokenConfigured: false,
  scrapeIntervalSeconds: null,
  lastSeenAt: null,
  lastError: null,
  lastErrorAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const sourceB: PulseSource = {
  ...sourceA,
  id: "source-b",
  name: "MacBook",
};

const metrics: PulseMetricSummary[] = [
  { name: "docker.container.cpu.usage", type: "gauge", unit: "percent", seriesCount: 2, lastSeenAt: "2026-01-01T00:02:00.000Z" },
  { name: "system.memory.usage", type: "gauge", unit: "percent", seriesCount: 1, lastSeenAt: "2026-01-01T00:03:00.000Z" },
];

const series: PulseMetricSeries[] = [
  {
    id: "series-1",
    metric: "docker.container.cpu.usage",
    sourceId: "source-a",
    resourceKey: "container:api",
    resourceType: "container",
    dimensions: { container: "api", compose_project: "cloud" },
    lastSeenAt: "2026-01-01T00:02:00.000Z",
    latestValue: 42,
    latestSampleAt: "2026-01-01T00:02:00.000Z",
  },
  {
    id: "series-2",
    metric: "docker.container.cpu.usage",
    sourceId: "source-a",
    resourceKey: "container:worker",
    resourceType: "container",
    dimensions: { container: "worker", compose_project: "cloud" },
    lastSeenAt: "2026-01-01T00:01:00.000Z",
    latestValue: 12,
    latestSampleAt: "2026-01-01T00:01:00.000Z",
  },
  {
    id: "series-3",
    metric: "system.memory.usage",
    sourceId: "source-b",
    resourceKey: "host:macbook",
    resourceType: "host",
    dimensions: { host: "Valentins Laptop" },
    lastSeenAt: "2026-01-01T00:03:00.000Z",
    latestValue: 68,
    latestSampleAt: "2026-01-01T00:03:00.000Z",
  },
];

const events: PulseRecordedEvent[] = [
  {
    id: "event-1",
    kind: "docker.container.error",
    ts: "2026-01-01T00:01:00.000Z",
    value: null,
    sourceId: "source-a",
    resourceKey: "container:api",
    resourceType: "container",
    dimensions: { container: "api" },
    attributes: {},
    payload: {},
    recordedAt: "2026-01-01T00:01:00.000Z",
  },
  {
    id: "event-2",
    kind: "docker.container.error",
    ts: "2026-01-01T00:04:00.000Z",
    value: null,
    sourceId: "source-a",
    resourceKey: "container:worker",
    resourceType: "container",
    dimensions: { container: "worker" },
    attributes: {},
    payload: {},
    recordedAt: "2026-01-01T00:04:00.000Z",
  },
];

const states: PulseCurrentState[] = [
  {
    variantKey: "fixture-0",
    key: "docker.container.running",
    value: true,
    sourceId: "source-a",
    resourceKey: "container:api",
    resourceType: "container",
    dimensions: { container: "api" },
    updatedAt: "2026-01-01T00:02:00.000Z",
  },
  {
    variantKey: "fixture-1",
    key: "docker.container.running",
    value: false,
    sourceId: "source-a",
    resourceKey: "container:worker",
    resourceType: "container",
    dimensions: { container: "worker" },
    updatedAt: "2026-01-01T00:05:00.000Z",
  },
];

describe("Pulse query reference inventory", () => {
  test("quotes only query values that need it", () => {
    expect(quotePulseQueryValue("api")).toBe("api");
    expect(quotePulseQueryValue("Valentins Laptop")).toBe('"Valentins Laptop"');
    expect(quotePulseQueryValue('host "quoted"')).toBe('"host \\"quoted\\""');
  });

  test("builds source and resource chips from all inventory kinds", () => {
    expect(buildReferenceSourceChips({ sources: [sourceA, sourceB], series, events, states })).toMatchObject([
      { id: "source-a", label: "Docker", count: 6 },
      { id: "source-b", label: "MacBook", count: 1 },
    ]);
    expect(buildReferenceEntityChips({ series, events, states })[0]).toMatchObject({
      id: "container:api",
      hint: "container",
      count: 3,
    });
  });

  test("filters metric rows by scope and keeps the selected sample dimensions", () => {
    const rows = buildReferenceMetricRows({
      metrics,
      series,
      sourcesById: new Map([sourceA, sourceB].map((source) => [source.id, source])),
      filters: { sourceId: "source-a", resourceKey: "container:api" },
      query: "cpu",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "docker.container.cpu.usage", visibleSeriesCount: 1 });
    expect(buildReferenceMetricQuery(rows[0]!, { sourceId: "source-a", resourceKey: "container:api" })).toBe(
      "metric docker.container.cpu.usage avg every 5m since 24h source source-a resource container:api where container=api, compose_project=cloud",
    );
  });

  test("groups event and state rows and generates scoped copy queries", () => {
    const sourcesById = new Map([sourceA].map((source) => [source.id, source]));
    const filters = { sourceId: "source-a", resourceKey: "container:api" };
    const resourceType = "container";

    const eventRows = buildReferenceEventRows({ events, sourcesById, filters, query: "" });
    const stateRows = buildReferenceStateRows({ states, sourcesById, filters, query: "" });

    expect(eventRows).toMatchObject([{ kind: "docker.container.error", count: 1, lastSeenAt: "2026-01-01T00:01:00.000Z" }]);
    expect(stateRows).toMatchObject([{ key: "docker.container.running", count: 1, lastSeenAt: "2026-01-01T00:02:00.000Z" }]);
    expect(buildReferenceEventQuery(eventRows[0]!, filters, resourceType)).toBe(
      "events docker.container.error since 7d source source-a resource container:api resource_type container limit 100",
    );
    expect(buildReferenceStateQuery(stateRows[0]!, filters, resourceType)).toBe(
      "states docker.container.running source source-a resource container:api resource_type container limit 100",
    );
  });
});
