import { describe, expect, test } from "bun:test";
import { parseNetworkAllowlist } from "@k2b/cloud/shared";
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
      skippedSummaries: 0,
      refusedHistograms: [],
      sampleCount: 2,
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
      expect(
        await fetchPrometheusMetrics({ endpointUrl: `http://127.0.0.1:${endpoint.port}/metrics`, bearerTokenEncrypted: null }, 100, {
          allowlist: parseNetworkAllowlist(["127.0.0.0/8"]),
        }),
      ).toMatchObject({ ok: false, error: { message: "Metrics scrape timed out after 15 seconds" } });
      expect(Date.now() - start).toBeLessThan(2000);
    } finally {
      endpoint.stop(true);
    }
  });
});

const histogram = (buckets: string, count = 3, sum = 2) => `# TYPE duration histogram
${buckets}
duration_sum{method="GET"} ${sum}
duration_count{method="GET"} ${count}`;
test("#4 histogram buckets retain canonical le and all three components are counters", () => {
  const parsed = parsePrometheusMetrics(histogram('duration_bucket{method="GET",le="1.000"} 1\nduration_bucket{method="GET",le="+Inf"} 3'));
  expect(parsed.refusedHistograms).toEqual([]);
  expect(parsed.metrics).toHaveLength(4);
  expect(parsed.metrics.map((s) => s.type)).toEqual(Array(4).fill("counter"));
  expect(parsed.metrics[0]?.dimensions?.le).toBe("1");
  expect(parsed.metrics[1]?.dimensions?.le).toBe("+Inf");
});
test.each([
  ["missing_inf", 'duration_bucket{method="GET",le="1"} 1', 3, 2],
  ["not_cumulative", 'duration_bucket{method="GET",le="1"} 4\nduration_bucket{method="GET",le="+Inf"} 3', 3, 2],
  ["count_mismatch", 'duration_bucket{method="GET",le="+Inf"} 3', 2, 2],
  ["negative_sum", 'duration_bucket{method="GET",le="+Inf"} 3', 3, -1],
] as const)("#4 %s refuses every sample of the family", (reason, buckets, count, sum) => {
  const parsed = parsePrometheusMetrics(histogram(buckets, count, sum) + "\n# TYPE safe gauge\nsafe 1");
  expect(parsed.metrics.map((m) => m.name)).toEqual(["safe"]);
  expect(parsed.refusedHistograms).toEqual([{ family: "duration", reason }]);
});
test("#4 histogram validation is per label group and diagnostics are bounded", () => {
  const parsed = parsePrometheusMetrics(
    histogram('duration_bucket{method="GET",le="+Inf"} 3') + '\nduration_bucket{method="POST",le="1"} 0',
  );
  expect(parsed.metrics).toEqual([]);
  expect(parsed.refusedHistograms).toEqual([{ family: "duration", reason: "missing_inf" }]);
  const many = Array.from({ length: 21 }, (_, i) => `# TYPE h${i} histogram\nh${i}_bucket{le="1"} 0`).join("\n");
  expect(parsePrometheusMetrics(many).refusedHistograms).toHaveLength(20);
});
test("#12 exact/prefix filters select families before the sample budget", () => {
  const parsed = parsePrometheusMetrics(
    "# TYPE excluded gauge\n" +
      "excluded 1\n".repeat(50001) +
      "\n# TYPE up gauge\nup 1\n# TYPE node_cpu_seconds_total counter\nnode_cpu_seconds_total 2\n" +
      histogram('duration_bucket{method="GET",le="+Inf"} 3'),
    undefined,
    ["up", "node_*", "duration"],
  );
  expect(parsed.sampleCount).toBe(5);
  expect(parsed.metrics.map((m) => m.name)).toEqual(["up", "node_cpu_seconds_total", "duration_bucket", "duration_sum", "duration_count"]);
});
