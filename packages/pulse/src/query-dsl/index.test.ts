import { describe, expect, test } from "bun:test";
import { compilePulseQueryText, durationToInterval, tokenizeQueryText } from ".";

const baseId = "00000000-0000-4000-8000-000000000000";
const sourceId = "Src001";

describe("Pulse query DSL", () => {
  test("tokenizes quoted filters", () => {
    expect(tokenizeQueryText('events deploy.finished where service="web app", env=prod')).toEqual([
      "events",
      "deploy.finished",
      "where",
      "service=web app",
      ",",
      "env=prod",
    ]);
  });

  test("compiles metric queries with source, resource, and dimensions", () => {
    const result = compilePulseQueryText(
      baseId,
      `metric docker.container.cpu.usage avg every 1m since 6h source ${sourceId} resource container:app-core resource_type container where env=prod`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      kind: "metric",
      baseId,
      metric: "docker.container.cpu.usage",
      aggregation: "avg",
      bucket: "1m",
      since: "6h",
      sourceId,
      resourceKey: "container:app-core",
      resourceType: "container",
      dimensions: { env: "prod" },
    });
  });

  test("compiles resource grouping and cross-series reduction", () => {
    const result = compilePulseQueryText(
      baseId,
      "metric docker.container.network.rx rate every 5m reduce sum group by resource since 24h where interface=eth0",
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        kind: "metric",
        aggregation: "rate",
        reduce: "sum",
        groupBy: "resource",
        dimensions: { interface: "eth0" },
      },
    });
  });

  test("compiles events and states queries", () => {
    const events = compilePulseQueryText(baseId, "events deploy.finished since 24h resource app-core limit 50");
    const states = compilePulseQueryText(baseId, "states service.online resource app-core resource_type service limit 10");
    expect(events.ok).toBe(true);
    expect(states.ok).toBe(true);
    if (events.ok) expect(events.data).toMatchObject({ kind: "events", event: "deploy.finished", resourceKey: "app-core", limit: 50 });
    if (states.ok)
      expect(states.data).toMatchObject({
        kind: "states",
        state: "service.online",
        resourceKey: "app-core",
        resourceType: "service",
        limit: 10,
      });
  });

  test("compiles SQL event aggregations with bounded grouping", () => {
    expect(compilePulseQueryText(baseId, "events page.viewed count every 1h since 7d where channel=qr group by campaign, country")).toEqual(
      {
        ok: true,
        data: {
          kind: "events",
          baseId,
          event: "page.viewed",
          since: "7d",
          sourceId: null,
          resourceKey: null,
          resourceType: null,
          dimensions: { channel: "qr" },
          aggregation: "count",
          bucket: "1h",
          groupBy: ["campaign", "country"],
          limit: 500,
        },
      },
    );
    expect(compilePulseQueryText(baseId, "events page.viewed unique actor every 1d since 30d")).toMatchObject({
      ok: true,
      data: { aggregation: "unique_actor", bucket: "1d" },
    });
  });

  test("rejects excessive lookback windows", () => {
    const result = compilePulseQueryText(baseId, "metric docker.container.cpu.usage avg every 1h since 365d");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("compact durations");
  });

  test("keeps duration conversion aligned with parser duration limits", () => {
    expect(durationToInterval("5m")).toBe("5 minutes");
    expect(durationToInterval("0m")).toBeNull();
    expect(durationToInterval("365d")).toBeNull();
  });

  test("reports empty and unterminated query text distinctly", () => {
    const empty = compilePulseQueryText(baseId, "   ");
    const unterminated = compilePulseQueryText(baseId, 'events deploy.finished where service="api');

    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.message).toBe("Query is empty");
    expect(unterminated.ok).toBe(false);
    if (!unterminated.ok) expect(unterminated.error.message).toBe("Query has an unterminated quote");
  });

  test("rejects pre-V1 resource type aliases", () => {
    for (const query of [
      "states service.online resource app-core resource-type service limit 10",
      "states service.online resource app-core entitytype service limit 10",
    ]) {
      const result = compilePulseQueryText(baseId, query);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("Unexpected token");
    }
  });

  test("allows filters before later clauses", () => {
    const result = compilePulseQueryText(baseId, "events deploy.finished where env=prod, region=eu since 6h limit 25");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ kind: "events", since: "6h", limit: 25, dimensions: { env: "prod", region: "eu" } });
  });

  test("rejects duplicate clauses and excessive row limits", () => {
    for (const [query, message] of [
      ["metric system.cpu.usage avg every 1m every 5m", 'Clause "every" may only be used once'],
      ["metric system.cpu.usage avg reduce sum reduce avg", 'Clause "reduce" may only be used once'],
      ["events deploy.finished since 1h since 2h", 'Clause "since" may only be used once'],
      ["states service.online limit 1001", "Limit cannot exceed 1000 rows"],
      ["events deploy.finished where limit 10", "Where requires at least one key=value filter"],
    ] as const) {
      const result = compilePulseQueryText(baseId, query);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toBe(message);
    }
  });

  test("rejects duplicate event aggregation options and oversized groups", () => {
    expect(compilePulseQueryText(baseId, "events page.viewed count every 1h every 5m")).toMatchObject({
      ok: false,
      error: { message: 'Clause "every" may only be used once' },
    });
    expect(compilePulseQueryText(baseId, "events page.viewed count group by a, b, c, d, e")).toMatchObject({
      ok: false,
      error: { message: "Group by cannot exceed 4 dimension keys" },
    });
  });
});

test("rejects removed entity clauses", () => {
  for (const clause of ["entity host:alpha", "entity_type host"]) {
    expect(compilePulseQueryText(baseId, `metric load avg every 5m since 1h ${clause}`).ok).toBe(false);
  }
});
