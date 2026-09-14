import { describe, expect, test } from "bun:test";
import { fetchPrometheusMetrics, parsePrometheusMetrics } from "./metrics-scraper";

describe("Pulse Prometheus metrics scraper", () => {
  test("keeps declared scalar families and explicit or endpoint target identity", () => {
    const parsed = parsePrometheusMetrics(
      `# TYPE http_requests_total counter
http_requests_total{method="GET",instance="api-1"} 42
# TYPE process_resident_memory_bytes gauge
process_resident_memory_bytes 123.5
`,
      "node:9100",
    );
    expect(parsed).toEqual({
      skippedSamples: 0,
      metrics: [
        {
          name: "http_requests_total",
          value: 42,
          type: "counter",
          resource: { type: "target", id: "api-1" },
          dimensions: { method: "GET", instance: "api-1" },
        },
        {
          name: "process_resident_memory_bytes",
          value: 123.5,
          type: "gauge",
          resource: { type: "target", id: "node:9100" },
          dimensions: {},
        },
      ],
    });
  });
  test("does not reinterpret histogram or summary suffixes as scalar counters", () => {
    const parsed = parsePrometheusMetrics(`# TYPE latency summary
latency{quantile="0.5"} 2
latency_sum -12
latency_count 9
# TYPE duration histogram
duration_bucket{le="1"} 3
duration_sum 2
duration_count 3
undeclared_total 4
# TYPE active gauge
active 0
`);
    expect(parsed.skippedSamples).toBe(7);
    expect(parsed.metrics.map(({ name, type }) => [name, type])).toEqual([["active", "gauge"]]);
  });
  test("reports malformed and nonfinite samples and preserves escaped labels", () => {
    const parsed = parsePrometheusMetrics(`# TYPE value gauge
broken
value NaN
value +Inf
value{note="line\\nquote\\"slash\\\\"} -1.25e3
`);
    expect(parsed.skippedSamples).toBe(3);
    expect(parsed.metrics[0]).toMatchObject({ value: -1250, dimensions: { note: 'line\nquote"slash\\' } });
  });
  test("the timeout covers a body that stalls after its headers", async () => {
    const endpoint = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("# TYPE value gauge\n"));
            },
          }),
        ),
    });
    const start = Date.now();
    try {
      await expect(
        fetchPrometheusMetrics({ endpointUrl: `http://127.0.0.1:${endpoint.port}/metrics`, bearerTokenEncrypted: null }, 100),
      ).rejects.toThrow();
      expect(Date.now() - start).toBeLessThan(2000);
    } finally {
      endpoint.stop(true);
    }
  });
});
