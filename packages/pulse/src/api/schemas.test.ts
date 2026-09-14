import { describe, expect, test } from "bun:test";
import {
  BaseSchema,
  DashboardSnapshotSchema,
  EventMapQueryTextSchema,
  IngestBatchSchema,
  MetricQuerySchema,
  ResourceEventQuerySchema,
  ResourceListQuerySchema,
  ResourceMetricQuerySchema,
  ResourceStateQuerySchema,
  UpdateBaseSchema,
} from "./schemas";

describe("Pulse ingest API limits", () => {
  test("accepts explicit resources for every ingest signal kind", () => {
    const resource = { type: "host", id: "server-01", label: "server-01" };
    const result = IngestBatchSchema.safeParse({
      metrics: [{ name: "system.cpu.usage", value: 42, resource }],
      events: [{ kind: "system.rebooted", resource }],
      states: [{ key: "system.online", value: true, resource }],
    });

    expect(result.success).toBe(true);
  });

  test("rejects explicit resources whose composite public ref would exceed the platform limit", () => {
    const result = IngestBatchSchema.safeParse({
      metrics: [{ name: "system.cpu.usage", value: 42, resource: { type: "service", id: "a".repeat(498) } }],
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe("Resource key cannot exceed 505 characters");
  });

  test("rejects per-signal source IDs because the endpoint owns source attribution", () => {
    const result = IngestBatchSchema.safeParse({
      metrics: [{ name: "system.cpu.usage", value: 42, sourceId: "019185c8-7cc1-7000-8000-000000000001" }],
    });

    expect(result.success).toBe(false);
  });

  test("accepts the documented external maximum", () => {
    const result = IngestBatchSchema.safeParse({
      metrics: Array.from({ length: 500 }, (_, index) => ({ name: `metric.${index}`, value: index })),
      events: Array.from({ length: 500 }, (_, index) => ({ kind: `event.${index}` })),
      states: Array.from({ length: 500 }, (_, index) => ({ key: `state.${index}`, value: index })),
    });
    expect(result.success).toBe(true);
  });

  test("rejects a collection above the external maximum", () => {
    const result = IngestBatchSchema.safeParse({
      metrics: Array.from({ length: 501 }, (_, index) => ({ name: `metric.${index}`, value: index })),
    });
    expect(result.success).toBe(false);
  });

  test("accepts high-cardinality event attributes without treating them as dimensions", () => {
    const result = IngestBatchSchema.safeParse({
      events: [
        {
          kind: "page.viewed",
          actorId: "visitor:unique",
          sessionId: "session:unique",
          dimensions: { campaign: "summer", country: "DE" },
          attributes: {
            url: "https://example.com/pricing?request=unique",
            request_id: "high-cardinality-value",
          },
          sensitive: { ip: "203.0.113.42", geo: { city: "Berlin", asn: 680 } },
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  test("accepts the three explicit V1 retention classes", () => {
    expect(UpdateBaseSchema.safeParse({ rawRetentionDays: 30, rollupRetentionDays: 365, sensitiveRetentionHours: 24 }).success).toBe(true);
    expect(UpdateBaseSchema.safeParse({ retentionDays: 30 }).success).toBe(false);
  });
});

describe("Pulse event map API limits", () => {
  test("accepts public field selectors and rejects malformed or sensitive selectors", () => {
    const input = {
      baseId: "Base01",
      query: "events qr.opened since 24h",
      latitude: { role: "attribute", path: "geo.latitude" },
      longitude: { role: "dimension", path: "longitude" },
      size: "count",
    };

    expect(EventMapQueryTextSchema.safeParse(input).success).toBe(true);
    expect(
      EventMapQueryTextSchema.safeParse({
        ...input,
        latitude: { role: "attribute", path: "geo..latitude" },
      }).success,
    ).toBe(false);
    expect(
      EventMapQueryTextSchema.safeParse({
        ...input,
        latitude: { role: "sensitive", path: "geo.latitude" },
      }).success,
    ).toBe(false);
  });
});

describe("Pulse public resource IDs", () => {
  test("accepts the full observed resource key budget across REST readers", () => {
    const resourceKey = "r".repeat(505);
    expect(ResourceListQuerySchema.safeParse({ ref: resourceKey }).success).toBe(true);
    expect(ResourceMetricQuerySchema.safeParse({ resourceKey }).success).toBe(true);
    expect(ResourceEventQuerySchema.safeParse({ resourceKey }).success).toBe(true);
    expect(ResourceStateQuerySchema.safeParse({ resourceKey }).success).toBe(true);
  });

  test("accepts short control-plane IDs and rejects legacy UUIDs", () => {
    expect(
      BaseSchema.safeParse({
        id: "Base01",
        name: "Operations",
        description: null,
        rawRetentionDays: 30,
        rollupRetentionDays: 365,
        sensitiveRetentionHours: 24,
        createdBy: null,
        deletionStartedAt: null,
        deletionFailedAt: null,
        deletionError: null,
        dataClearStartedAt: null,
        dataClearCompletedAt: null,
        dataClearFailedAt: null,
        dataClearError: null,
        createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(BaseSchema.safeParse({ id: crypto.randomUUID() }).success).toBe(false);
    expect(
      MetricQuerySchema.safeParse({
        baseId: crypto.randomUUID(),
        metric: "cpu.usage",
        aggregation: "avg",
        bucket: "5m",
        since: "1h",
      }).success,
    ).toBe(false);
  });

  test("requires a short dashboard ID in public snapshots", () => {
    const snapshot = {
      dashboard: { id: "Dash01", name: "Operations", config: { layout: null } },
      points: {},
      events: {},
      states: {},
      maps: {},
    };

    expect(DashboardSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(
      DashboardSnapshotSchema.safeParse({
        ...snapshot,
        dashboard: { ...snapshot.dashboard, id: crypto.randomUUID() },
      }).success,
    ).toBe(false);
  });
});

test("rejects historical identity fields instead of silently dropping them", () => {
  for (const field of ["entityId", "entityType", "resourceKey", "resourceType"]) {
    expect(IngestBatchSchema.safeParse({ metrics: [{ name: "load", value: 1, [field]: "old" }] }).success).toBe(false);
    expect(IngestBatchSchema.safeParse({ events: [{ kind: "view", [field]: "old" }] }).success).toBe(false);
    expect(IngestBatchSchema.safeParse({ states: [{ key: "online", value: true, [field]: "old" }] }).success).toBe(false);
  }
  expect(IngestBatchSchema.safeParse({ metrics: [{ name: "load", value: 1, resource: { type: "a:b", id: "c" } }] }).success).toBe(false);
});

test("metric API accepts exact periods and rejects partial or mixed windows", () => {
  const query = {
    baseId: "abc123",
    metric: "load",
    aggregation: "avg",
    bucket: "1h",
    dimensions: {},
    from: "2026-09-01T00:00:00Z",
    to: "2026-09-02T00:00:00Z",
  };
  expect(MetricQuerySchema.safeParse(query).success).toBe(true);
  expect(MetricQuerySchema.safeParse({ ...query, since: "1d" }).success).toBe(false);
  expect(MetricQuerySchema.safeParse({ ...query, to: undefined }).success).toBe(false);
  expect(MetricQuerySchema.safeParse({ ...query, from: "2026-09-01" }).success).toBe(false);
});
