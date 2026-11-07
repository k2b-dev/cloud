import { expect, test } from "bun:test";
import { funnelLayout, renderFunnelSvg } from "../charts/core/funnel";
import { rankedBarLayout, renderBarChartSvg } from "./chart-bar";

test("funnel ratios retain the start and previous step; rises fit the plot", () => {
  const spec = {
    data: [
      { label: "A", value: 10 },
      { label: "B", value: 20 },
      { label: "C", value: 5 },
    ],
  };
  const g = funnelLayout(spec);
  expect(g.steps.map((s) => s.startShare)).toEqual([1, 2, 0.5]);
  expect(g.steps.map((s) => s.previousShare)).toEqual([null, 2, 0.25]);
  expect(g.steps[1]!.width).toBeGreaterThan(g.steps[0]!.width);
  expect(g.center + g.steps[1]!.width / 2).toBeLessThan(g.width - g.right);
  const svg = renderFunnelSvg({ ...spec, width: 480, height: 280, inspect: true });
  expect(svg).toContain("200%");
  expect(svg).toContain("previousPercent");
  expect(() => funnelLayout({ data: [{ label: "bad", value: -1 }] })).toThrow("nonnegative");
});
test("zero denominators and missing funnel steps stay unknown", () => {
  const g = funnelLayout({
    data: [
      { label: "A", value: 0 },
      { label: "B", value: 10 },
      { label: "C", value: null },
      { label: "D", value: 5 },
    ],
  });
  expect(g.steps.map((s) => s.startShare)).toEqual([null, null, null, null]);
  expect(g.steps.map((s) => s.previousShare)).toEqual([null, null, null, null]);
  expect(
    renderFunnelSvg({
      data: [
        { label: "A", value: 0 },
        { label: "B", value: 0 },
      ],
      width: 480,
      height: 280,
    }),
  ).not.toMatch(/NaN|Infinity/);
});
test("ranked rows sort stably, use all observations as denominator and summarize the remainder", () => {
  const spec = {
    layout: "rows" as const,
    share: true,
    limit: 2,
    data: [
      { label: "Small", value: 10 },
      { label: "Large", value: 50 },
      { label: "Medium", value: 30 },
      { label: "Other", value: 10 },
    ],
  };
  const g = rankedBarLayout(spec);
  expect(g.rows.map((r) => r.index)).toEqual([1, 2]);
  expect(g.rows.map((r) => r.share)).toEqual([0.5, 0.3]);
  expect(g.restValue).toBe(20);
  const svg = renderBarChartSvg({ ...spec, width: 480, height: 280, inspect: true });
  expect(svg).toContain("2 more · 20");
  expect(svg).toContain("50%");
  expect(svg).toContain("data-chart-datum=");
  expect(() => rankedBarLayout({ ...spec, limit: 0 })).toThrow("positive integer");
  expect(() => rankedBarLayout({ ...spec, data: [{ label: "bad", value: -1 }] })).toThrow("nonnegative");
  expect(rankedBarLayout({ ...spec, data: [{ label: "zero", value: 0 }] }).rows[0]!.share).toBeNull();
});
