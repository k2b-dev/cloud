import { expect, test } from "bun:test";
import { hbarLayout, renderHbarLayoutSvg, renderHbarSvg } from "./hbar";
import { type ChartRenderOptions, chartRenderHeight, renderChartSvg } from "./render";
import { prepareChartSnapshot } from "./snapshot";
import { barGauge } from "./svg";
import { renderWaterfallLayoutSvg, renderWaterfallSvg, waterfallLayout } from "./waterfall";

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

test("lazy horizontal drawing reuses its reserved geometry without changing SVG", () => {
  for (const width of [296, 480, 900]) {
    for (const locale of ["en", "de"]) {
      for (const legend of [true, false]) {
        const spec = {
          series: ["Previous subscriptions", "New subscriptions"],
          rows: [
            { group: "North", label: "Long invented account name", values: [200, 30] },
            { group: "South", label: "Missing observations", values: [null, null] },
          ],
          title: "Accounts",
          subtitle: "Invented values",
          legend,
          locale,
          valueFormat: new Intl.NumberFormat(locale).format,
          width,
          height: 280,
          inspect: true,
        };
        const layout = hbarLayout(spec, spec);
        const drawing = renderHbarSvg(spec);
        expect(renderHbarLayoutSvg(spec, layout)).toBe(drawing);
        // The deferred renderer must use its prepared observations, not silently lay out changed input again.
        spec.rows[0]!.values[0] = 999_999;
        expect(renderHbarLayoutSvg(spec, layout)).toBe(drawing);
        expect(renderHbarSvg(spec)).not.toBe(drawing);
        expect(layout.rows[1]!.total).toBeNull();
        expect(layout.height).toBe(280);
      }
    }
  }
});

test("prepared waterfall geometry renders byte-identically across hosts", () => {
  const digest = new Bun.CryptoHasher("sha256");
  for (const width of [296, 480, 900]) {
    for (const responsive of [true, false]) {
      for (const locale of ["en", "de"]) {
        const spec = {
          start: { label: "Opening balance", value: -100 },
          steps: [
            { label: "Sales", value: 240 },
            { label: "Expenses", value: -50 },
            { label: "No change", value: 0 },
          ],
          end: { label: "Closing balance" },
          title: "Invented cash flow",
          subtitle: "Fictional values",
          locale,
          width,
          height: 280,
          inspect: true,
        };
        const geometry = waterfallLayout(spec, spec);
        const svg = renderWaterfallSvg(spec, responsive);
        expect(renderWaterfallLayoutSvg(spec, geometry, responsive)).toBe(svg);
        digest.update(svg);
      }
    }
  }
  // Captured from main before splitting its renderer; keep all SVG bytes unchanged.
  expect(digest.digest("hex")).toBe("0a019d05056573a8f5caeb65984186d5aa6a5c8b354e8f08f1804bcc37898532");
});
