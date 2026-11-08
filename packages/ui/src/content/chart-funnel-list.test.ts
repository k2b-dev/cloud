import { expect, test } from "bun:test";
import { funnelLayout, renderFunnelLayoutSvg, renderFunnelSvg } from "../charts/core/funnel";
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

test("funnel and ranked list inspection titles serialize labels once", () => {
  const data = [{ label: "<title>".repeat(2048), value: 2 }];
  for (const svg of [
    renderFunnelSvg({ data, width: 480, height: 280, inspect: true }),
    renderBarChartSvg({ data, layout: "rows", width: 480, height: 280, inspect: true }),
  ]) {
    expect(svg.match(/<title>/g)).toHaveLength(1);
    expect(svg).toContain("&lt;title&gt;".repeat(2048));
  }
});

test("ranked flow tones use the shared mark tokens with a neutral fallback", () => {
  for (const tone of ["in", "out"] as const) {
    const svg = renderBarChartSvg({ data: [{ label: "Amount", value: 5 }], layout: "rows", tone, width: 480, height: 280 });
    expect(svg).toContain(`var(--k2b-flow-${tone}-mark,var(--stdlib-chart-c1,#3b82f6))`);
  }
});

test("prepared funnel drawings match direct rendering across widths, locales and gaps", () => {
  for (const width of [296, 480, 1920])
    for (const locale of ["en", "de"]) {
      const spec = {
        width,
        height: 280,
        locale,
        inspect: true,
        title: "Journey",
        subtitle: "Invented observations",
        valueFormat: (n: number) => new Intl.NumberFormat(locale).format(n),
        data: [
          { label: "Start", value: 0 },
          { label: "Rise", value: 20 },
          { label: "Gap", value: null },
          { label: "Return", value: 5 },
        ],
      };
      expect(renderFunnelLayoutSvg(spec, funnelLayout(spec, spec))).toBe(renderFunnelSvg(spec));
    }
});

test("ranked missing rows and an all-missing remainder stay gaps", () => {
  const spec = {
    layout: "rows" as const,
    share: true,
    limit: 1,
    data: [
      { label: "Observed", value: 10 },
      { label: "Unknown", value: NaN },
    ],
  };
  expect(rankedBarLayout(spec).restValue).toBeNull();
  expect(renderBarChartSvg({ ...spec, width: 480, height: 280 })).toContain("1 more · –");
});
