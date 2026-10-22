import { expect, test } from "bun:test";
import { MetricFiltersSchema, parseMetricFilterInput, SourceConfigSchema } from "./metric-filters";

test("#12 filter syntax, count and serialized config size use shared limits", () => {
  expect(parseMetricFilterInput(" node_*,up\n:requests_total \n")).toEqual(["node_*", "up", ":requests_total"]);
  for (const entry of ["*", "node*cpu", "node_**", "node.cpu", "9node", "a".repeat(129)])
    expect(MetricFiltersSchema.safeParse([entry]).success).toBe(false);
  expect(MetricFiltersSchema.safeParse(["node_*", ":requests_total", "a".repeat(128)]).success).toBe(true);
  expect(MetricFiltersSchema.safeParse(Array(101).fill("up")).success).toBe(false);
  expect(SourceConfigSchema.safeParse({ metricFilters: Array(100).fill("a".repeat(128)) }).success).toBe(true);
  expect(SourceConfigSchema.safeParse({ extra: "a".repeat(16 * 1024) }).success).toBe(false);
});
