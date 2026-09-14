import { describe, expect, test } from "bun:test";
import { parsePrometheusMetrics } from "./metrics-scraper";

describe("Pulse Prometheus metrics scraper", () => {
  test("parses Prometheus samples with labels, escaped values, and explicit types", () => {
    const metrics = parsePrometheusMetrics(`# HELP http_requests_total Total requests.
# TYPE http_requests_total counter
http_requests_total{method="GET",route="/api",instance="api-1"} 42 1710000000000
# TYPE process_resident_memory_bytes gauge
process_resident_memory_bytes{host="worker-1",note="line\\nquote\\"slash\\\\"} 123.5
`);

    expect(metrics).toEqual([
      {
        name: "http_requests_total",
        value: 42,
        type: "counter",
        resource: { type: "target", id: "api-1" },
        dimensions: { method: "GET", route: "/api", instance: "api-1" },
      },
      {
        name: "process_resident_memory_bytes",
        value: 123.5,
        type: "gauge",
        resource: { type: "target", id: "worker-1" },
        dimensions: { host: "worker-1", note: 'line\nquote"slash\\' },
      },
    ]);
  });

  test("infers histogram and counter samples when the base type line is absent", () => {
    const metrics = parsePrometheusMetrics(`
request_duration_seconds_bucket{le="0.5"} 10
request_duration_seconds_sum 12.75
request_duration_seconds_count 20
jobs_processed_total 99
temperature_celsius 23
`);

    expect(metrics.map((metric) => [metric.name, metric.type])).toEqual([
      ["request_duration_seconds_bucket", "histogram"],
      ["request_duration_seconds_sum", "counter"],
      ["request_duration_seconds_count", "counter"],
      ["jobs_processed_total", "counter"],
      ["temperature_celsius", "gauge"],
    ]);
  });

  test("ignores comments, malformed lines, and non-finite values", () => {
    const metrics = parsePrometheusMetrics(`
# HELP ignored Ignored.
broken
nan_value NaN
infinite_value +Inf
valid_value -1.25e3
`);

    expect(metrics).toEqual([
      {
        name: "valid_value",
        value: -1250,
        type: "gauge",
        resource: null,
        dimensions: {},
      },
    ]);
  });
});
