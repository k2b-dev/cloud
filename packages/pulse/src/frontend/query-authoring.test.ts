import { describe, expect, test } from "bun:test";
import type { SuggestContext, Suggestion } from "@k2b/ui";
import {
  buildPulseQuery,
  buildPulseQueryCompletions,
  defaultPulseQuery,
  pulseDashboardDslHighlight,
  pulseQueryHighlight,
} from "./query-authoring";

const suggest = async (query: string, ctx: SuggestContext): Promise<readonly Suggestion[]> => {
  const completion = buildPulseQueryCompletions({
    metrics: [
      { name: "system.cpu.usage", type: "gauge", unit: "percent", seriesCount: 1, lastSeenAt: null },
      { name: "http.requests.total", type: "counter", unit: "count", seriesCount: 1, lastSeenAt: null },
    ],
    events: [
      {
        id: "event-1",
        kind: "deploy.finished",
        ts: "2026-01-01T00:00:00.000Z",
        value: null,
        sourceId: "source-a",
        resourceKey: "service:api",
        resourceType: "service",
        dimensions: { host: "macbook", region: "eu" },
        attributes: {},
        payload: {},
        recordedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    states: [
      {
        variantKey: "fixture-0",
        key: "service.online",
        value: true,
        sourceId: "source-a",
        resourceKey: "service:api",
        resourceType: "service",
        dimensions: { host: "macbook", environment: "prod" },
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    sources: [
      {
        id: "00000000-0000-4000-8000-000000000000",
        baseId: "base",
        kind: "http_ingest",
        name: "MacBook",
        enabled: true,
        endpointUrl: null,
        bearerTokenConfigured: false,
        scrapeIntervalSeconds: null,
        lastSeenAt: null,
        lastError: null,
        lastErrorAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    series: [
      {
        id: "series-1",
        metric: "system.cpu.usage",
        sourceId: "source-a",
        resourceKey: "host:macbook",
        resourceType: "host",
        dimensions: { host: "macbook", region: "eu" },
        lastSeenAt: null,
        latestValue: 42,
        latestSampleAt: null,
      },
    ],
    fields: [
      {
        sourceId: "source-a",
        scope: "event",
        signalName: "page.viewed",
        role: "dimension",
        key: "campaign",
        valueType: "string",
        observedCount: 100,
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      },
      {
        sourceId: "source-a",
        scope: "state",
        signalName: "campaign.active",
        role: "dimension",
        key: "campaign",
        valueType: "string",
        observedCount: 1,
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  })[0]!;

  return Promise.resolve(completion.suggest(query, ctx, new AbortController().signal));
};

describe("Pulse query authoring", () => {
  test("builds metric queries with quoted dimension values", () => {
    expect(
      buildPulseQuery({
        metric: "sales.orders",
        aggregation: "increase",
        bucket: "1h",
        since: "7d",
        sourceId: "source-a",
        dimensions: { channel: "web shop", region: "eu" },
      }),
    ).toBe('metric sales.orders increase every 1h since 7d source source-a where channel="web shop", region=eu');
  });

  test("chooses sensible default aggregations by metric type", () => {
    expect(defaultPulseQuery([{ name: "requests.total", type: "counter", unit: "count", seriesCount: 1, lastSeenAt: null }])).toContain(
      " rate ",
    );
    expect(defaultPulseQuery([{ name: "duration", type: "gauge", unit: "seconds", seriesCount: 1, lastSeenAt: null }])).toContain(" avg ");
    expect(defaultPulseQuery([{ name: "memory.usage", type: "gauge", unit: "percent", seriesCount: 1, lastSeenAt: null }])).toContain(
      " avg ",
    );
  });

  test("suggests signals and filters from inventory data", async () => {
    await expect(suggest("sys", { fullText: "metric sys", caret: 10, tokenStart: 7 })).resolves.toContainEqual(
      expect.objectContaining({ text: "system.cpu.usage", hint: "gauge · percent" }),
    );
    await expect(suggest("dep", { fullText: "events dep", caret: 10, tokenStart: 7 })).resolves.toContainEqual(
      expect.objectContaining({ text: "deploy.finished", hint: "event kind" }),
    );
    await expect(suggest("serv", { fullText: "states serv", caret: 11, tokenStart: 7 })).resolves.toContainEqual(
      expect.objectContaining({ text: "service.online", hint: "state key" }),
    );
    await expect(suggest("ho", { fullText: "metric system.cpu.usage avg where ho", caret: 36, tokenStart: 34 })).resolves.toContainEqual(
      expect.objectContaining({ text: "host=", hint: "1 values", expansion: "host=macbook" }),
    );
    await expect(suggest("page", { fullText: "events page", caret: 11, tokenStart: 7 })).resolves.toContainEqual(
      expect.objectContaining({ text: "page.viewed", hint: "event kind" }),
    );
    await expect(suggest("camp", { fullText: "events page.viewed where camp", caret: 29, tokenStart: 25 })).resolves.toContainEqual(
      expect.objectContaining({ text: "campaign=", hint: "dimension" }),
    );
  });

  test("suggests event aggregations and grouping keys", async () => {
    const aggregation = await suggest("", { fullText: "events deploy.finished ", caret: 23, tokenStart: 23 });
    expect(aggregation.map((item) => item.label)).toContain("count");
    expect(aggregation.map((item) => item.label)).toContain("unique");

    const identity = await suggest("", { fullText: "events deploy.finished unique ", caret: 30, tokenStart: 30 });
    expect(identity.map((item) => item.label)).toEqual(["actor", "session"]);
  });

  test("highlights query DSL and escapes user text", () => {
    const html = pulseQueryHighlight('metric system.cpu.usage avg every 5m where host="a<b"');

    expect(html).toContain('<span class="text-blue-600 dark:text-blue-300">metric</span>');
    expect(html).toContain('<span class="text-emerald-700 dark:text-emerald-300">avg</span>');
    expect(html).toContain("&lt;");
  });

  test("highlights dashboard DSL keywords separately from plain query DSL", () => {
    const html = pulseDashboardDslHighlight('dashboard "Ops" { gauge "CPU" { query metric system.cpu.usage latest since 1h } }');

    expect(html).toContain('<span class="text-blue-600 dark:text-blue-300">dashboard</span>');
    expect(html).toContain('<span class="text-blue-600 dark:text-blue-300">gauge</span>');
    expect(html).toContain('<span class="text-emerald-700 dark:text-emerald-300">latest</span>');
  });

  test("highlights event map dashboard syntax", () => {
    const html = pulseDashboardDslHighlight('map "Scans" { latitude attribute geo.latitude longitude attribute geo.longitude size count }');

    expect(html).toContain('<span class="text-blue-600 dark:text-blue-300">map</span>');
    expect(html).toContain('<span class="text-blue-600 dark:text-blue-300">latitude</span>');
    expect(html).toContain('<span class="text-blue-600 dark:text-blue-300">attribute</span>');
    expect(html).toContain('<span class="text-blue-600 dark:text-blue-300">count</span>');
  });

  test("highlights multiline dashboard markdown without dropping content", () => {
    const html = pulseDashboardDslHighlight('markdown "Notes" {\n"""\n## <Status>\n"""\n}');

    expect(html).toContain("&lt;Status&gt;");
    expect(html).toContain('<span class="text-amber-700 dark:text-amber-300">&quot;&quot;&quot;');
  });
});
