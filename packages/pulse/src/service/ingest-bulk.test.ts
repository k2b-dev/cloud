import { describe, expect, test } from "bun:test";
import { prepareIngestBatch } from "./ingest-bulk";

describe("Pulse bulk ingest preparation", () => {
  test("binds signal variants to the authenticated source", () => {
    const sourceId = "11111111-1111-4111-8111-111111111111";
    const prepared = prepareIngestBatch(
      {
        metrics: [
          {
            name: "system.cpu.usage",
            value: 42,
            resource: { type: "host", id: "alpha", label: "Alpha" },
            dimensions: { host: "alpha" },
          },
        ],
        events: [
          {
            kind: "deploy.finished",
            resource: { type: "host", id: "alpha", label: "Alpha" },
            attributes: { request_id: "request-1", location: { city: "Berlin" } },
            sensitive: { ip: "203.0.113.42" },
          },
        ],
        states: [
          {
            key: "system.online",
            value: true,
            resource: { type: "host", id: "alpha", label: "Alpha" },
          },
        ],
      },
      sourceId,
    );

    expect(prepared.metrics[0]?.seriesKey).toMatch(/^[a-f0-9]{64}$/);
    expect(prepared.resources).toHaveLength(1);
    expect(prepared.resources[0]).toEqual(
      expect.objectContaining({
        key: "host:alpha",
        id: "alpha",
        type: "host",
        label: "Alpha",
      }),
    );
    expect(prepared.events[0]?.attributes).toEqual({ request_id: "request-1", location: { city: "Berlin" } });
    expect(prepared.events[0]?.sensitive).toEqual({ ip: "203.0.113.42" });
  });

  test("does not materialize event identities as resources without an explicit resource", () => {
    const prepared = prepareIngestBatch(
      {
        events: [
          {
            kind: "page.viewed",
            actorId: "visitor:high-cardinality",
            sessionId: "session:high-cardinality",
            attributes: { url: "https://example.com/pricing?request=unique" },
          },
        ],
      },
      "11111111-1111-4111-8111-111111111111",
    );

    expect(prepared.resources).toEqual([]);
    expect(prepared.events[0]?.resourceKey).toBeNull();
  });

  test("uses explicit metric and state resources instead of dimension inference", () => {
    const prepared = prepareIngestBatch(
      {
        metrics: [
          {
            name: "docker.container.cpu.usage",
            value: 12,
            resource: { type: "docker-container", id: "host-a:app", label: "app" },
            dimensions: { host: "host-a", container: "app", container_id: "volatile-id" },
          },
        ],
        states: [
          {
            key: "docker.container.running",
            value: true,
            resource: { type: "docker-container", id: "host-a:app", label: "app" },
            dimensions: { host: "host-a", container: "app", container_id: "volatile-id" },
          },
        ],
      },
      "11111111-1111-4111-8111-111111111111",
    );

    expect(prepared.metrics[0]?.resourceKey).toBe("docker-container:host-a:app");
    expect(prepared.states[0]?.resourceKey).toBe("docker-container:host-a:app");
    expect(prepared.resources).toHaveLength(1);
    expect(prepared.resources[0]?.label).toBe("app");
  });

  test("catalogs event dimensions, attributes, and sensitive fields without storing their values", () => {
    const prepared = prepareIngestBatch(
      {
        events: [
          {
            kind: "page.viewed",
            dimensions: { campaign: "summer" },
            attributes: { request_id: "request-1", geo: { city: "Berlin" } },
            sensitive: { ip: "203.0.113.42" },
          },
          {
            kind: "page.viewed",
            dimensions: { campaign: "winter" },
            attributes: { request_id: "request-2", geo: { city: "Hamburg" } },
            sensitive: { ip: "198.51.100.9" },
          },
        ],
      },
      "11111111-1111-4111-8111-111111111111",
    );

    expect(prepared.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "dimension", key: "campaign", valueType: "string", observedCount: 2 }),
        expect.objectContaining({ role: "attribute", key: "request_id", valueType: "string", observedCount: 2 }),
        expect.objectContaining({ role: "attribute", key: "geo", valueType: "object", observedCount: 2 }),
        expect.objectContaining({ role: "sensitive", key: "ip", valueType: "string", observedCount: 2 }),
      ]),
    );
    expect(JSON.stringify(prepared.fields)).not.toContain("request-1");
    expect(JSON.stringify(prepared.fields)).not.toContain("Berlin");
    expect(JSON.stringify(prepared.fields)).not.toContain("203.0.113.42");
  });

  test("deduplicates resource and field metadata for large set-based writes", () => {
    const prepared = prepareIngestBatch(
      {
        metrics: Array.from({ length: 1_000 }, (_, index) => ({
          name: `system.metric.${index % 10}`,
          value: index,
          resource: { type: "host", id: "alpha" },
          dimensions: { host: "alpha", region: "eu" },
        })),
      },
      "11111111-1111-4111-8111-111111111111",
    );

    expect(prepared.metrics).toHaveLength(1_000);
    expect(prepared.resources).toHaveLength(1);
    expect(prepared.fields).toHaveLength(20);
    expect(prepared.fields).toContainEqual(
      expect.objectContaining({
        scope: "metric",
        signalName: "system.metric.0",
        role: "dimension",
        key: "host",
        observedCount: 100,
      }),
    );
  });
});

test("uses one collision-safe variant identity and never infers generic resources", () => {
  const resources = [{ type: "host", id: "same" }, { type: "service", id: "same" }, { type: "host", id: "other" }, null];
  const batch = {
    metrics: resources.map((resource) => ({ name: "load", value: 1, resource, dimensions: { host: "inference-must-not-happen" } })),
    states: resources.map((resource) => ({ key: "online", value: true, resource, dimensions: { host: "inference-must-not-happen" } })),
  };
  const first = prepareIngestBatch(batch, "source-a");
  const second = prepareIngestBatch(batch, "source-b");
  expect(new Set([...first.metrics, ...second.metrics].map((row) => row.seriesKey)).size).toBe(8);
  expect(first.metrics.map((row) => row.seriesKey)).toEqual(first.states.map((row) => row.variantKey));
  expect(first.metrics[3]?.resourceKey).toBeNull();
  expect(first.resources).toHaveLength(3);
  const renamed = prepareIngestBatch(
    { metrics: [{ ...batch.metrics[0]!, resource: { type: "host", id: "same", label: "Renamed" } }] },
    "source-a",
  );
  expect(renamed.metrics[0]?.seriesKey).toBe(first.metrics[0]?.seriesKey);
});
