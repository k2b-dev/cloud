import { expect, test } from "bun:test";
import { type ChartRenderOptions, chartRenderHeight, renderChartSvg } from "./render";
import { prepareChartSnapshot } from "./snapshot";
import { barGauge } from "./svg";

test("bar gauge content height is opt-in and follows rows and headers", () => {
  for (const count of [0, 1, 3, 12]) {
    for (const header of [{}, { title: "Quota" }, { subtitle: "Invented data" }]) {
      const spec = {
        kind: "barGauge",
        data: Array.from({ length: count }, (_, i) => ({ label: `Account ${i}`, value: i })),
        ...header,
      } satisfies ChartRenderOptions;
      const contentHeight = Math.max(80, (spec.title || spec.subtitle ? 42 : 16) + count * 28 + 14);
      expect(chartRenderHeight(spec, { contentHeight: true })).toBe(contentHeight);
      expect(chartRenderHeight(spec)).toBe(Math.max(280, contentHeight));
      const compact = renderChartSvg(spec, 480, contentHeight);
      expect(compact).toContain(`viewBox="0 0 480 ${contentHeight}"`);
      // The existing raw renderer already has the same intrinsic row height.
      expect(barGauge({ ...spec, width: 480 })).toContain(`viewBox="0 0 480 ${contentHeight}"`);
      // Explicit height still determines the drawing, independently of the sizing policy.
      expect(renderChartSvg(spec, 480, 280)).toContain('viewBox="0 0 480 280"');
    }
  }
});

test("snapshot hosts opt into compact bar gauges without changing default snapshots", () => {
  const spec = {
    kind: "barGauge" as const,
    data: [
      { label: "CPU", value: 65 },
      { label: "Memory", value: 72 },
    ],
  };
  const inspection = { key: ({ datum }: import("./inspection").ChartSelection) => String(datum.index), tooltip: () => ({ rows: [] }) };
  const legacy = prepareChartSnapshot(spec, inspection);
  const compact = prepareChartSnapshot(spec, inspection, { contentHeight: true });
  expect(legacy.height).toBe(280);
  expect(compact.height).toBe(86);
  expect(compact.svg).toContain('viewBox="0 0 480 86"');
  expect(compact.marks).toEqual(legacy.marks);
});
