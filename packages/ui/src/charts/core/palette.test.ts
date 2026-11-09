import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chartFixtures } from "../../../test/charts/fixtures";
import { chartRenderHeight, renderChartSvg } from "./index";
import { chartSvgWithUiPalette } from "./palette";
import { charts } from "./svg";

const css = readFileSync(new URL("../../base/base.css", import.meta.url), "utf8");
const palette = [...css.matchAll(/--stdlib-chart-c([1-8]): (#[0-9a-f]{6});/g)].map((match) => match[2]!);

test.each(Object.values(chartFixtures))("$kind standalone palette matches base.css without changing its drawing", (spec) => {
  expect(palette).toHaveLength(8);
  const original = renderChartSvg(spec, 480, chartRenderHeight(spec));
  const svg = chartSvgWithUiPalette(original);
  const definitions = [...svg.matchAll(/--stdlib-chart-c([1-8]): (#[0-9a-f]{6});/g)];
  // Area supplies inline numeric fallbacks; waterfall uses semantic money colors.
  expect(definitions).toHaveLength(spec.kind === "area" || spec.kind === "waterfall" ? 0 : 8);
  for (const [, index, color] of definitions) expect(color).toBe(palette[Number(index) - 1]);
  for (const [, index, color] of svg.matchAll(/var\(--stdlib-chart-c([1-8]),\s*(#[0-9a-f]{3,8})\)/g))
    expect(color).toBe(palette[Number(index) - 1]);
  // Every mark and its inert interaction contract is retained verbatim.
  const geometry = /\b(?:d|points|x|y|x1|y1|x2|y2|cx|cy|r|width|height|transform|data-chart-datum)="[^"]*"/g;
  expect(svg.match(geometry)).toEqual(original.match(geometry));
  expect(chartSvgWithUiPalette(svg)).toBe(svg);
});

test("all fourteen raw renderer kinds carry the UI defaults on explicit conversion", () => {
  for (const [kind, render] of Object.entries(charts)) {
    const fixture = chartFixtures[kind as keyof typeof charts];
    // Raw heatmap and timeline have their original contracts; the dispatcher has richer adapters.
    const spec = kind === "heatmap" ? { data: [{ x: "Mon", y: "AM", value: 1 }] } : fixture;
    const svg = chartSvgWithUiPalette((render as (spec: unknown) => string)({ ...spec, width: 480, height: 280 }));
    palette.forEach((color, index) => expect(svg, kind).toContain(`--stdlib-chart-c${index + 1}: ${color};`));
  }
});

test("palette conversion preserves semantic colors, custom thresholds and escaped labels", () => {
  const svg = charts.gauge({ value: 3, thresholds: [{ value: 10, color: "#123456" }], label: "<style>not CSS</style>" });
  const converted = chartSvgWithUiPalette(svg);
  expect(converted).toContain("#123456");
  expect(converted).toContain("&lt;style&gt;not CSS&lt;/style&gt;");
  expect(converted).toContain(".stdlib-chart-stat-delta-down { fill: #ef4444;");
});
