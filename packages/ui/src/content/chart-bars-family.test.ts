import { describe, expect, test } from "bun:test";
import { hbarLayout, renderHbarSvg } from "../charts/core/hbar";
import { renderBarChartSvg, seriesBarLayout } from "./chart-bar";

const series = [
  { label: "Shop", data: [10, 0, null] },
  { label: "Fair", data: [30, 0, 5] },
];
describe("category bars", () => {
  test("stack bases are cumulative; grouped bars each start at zero", () => {
    const stacked = seriesBarLayout({ x: ["A", "B", "C"], series, layout: "stacked" });
    expect(stacked.columns[0]?.current.map((v) => [v.base, v.value])).toEqual([
      [0, 10],
      [10, 30],
    ]);
    expect(seriesBarLayout({ x: ["A", "B", "C"], series }).columns[0]?.current.map((v) => v.base)).toEqual([0, 0]);
    expect(stacked.columns[2]?.current[0]?.value).toBeNull();
  });
  test("100 percent empty totals are gaps, partial gaps remain gaps", () => {
    const normalized = seriesBarLayout({ x: ["A", "B", "C"], series, layout: "stacked", normalize: true });
    expect(normalized.columns[0]?.current.map((v) => v.value)).toEqual([0.25, 0.75]);
    expect(normalized.columns[1]?.current.map((v) => v.value)).toEqual([null, null]);
    expect(normalized.columns[2]?.current.map((v) => v.value)).toEqual([null, 1]);
  });
  test("rejects negative stacks and unaligned comparison arrays", () => {
    expect(() => seriesBarLayout({ x: ["A"], series: [{ label: "Bad", data: [-1] }], layout: "stacked" })).toThrow("nonnegative");
    expect(() => seriesBarLayout({ x: ["A"], series: [{ label: "Bad", data: [] }] })).toThrow("same length");
  });
  test("comparison is left hatched, right current, totals and change retained", () => {
    const svg = renderBarChartSvg({
      x: ["A"],
      series: [{ label: "Now", data: [15] }],
      compare: { label: "Before", data: [10] },
      width: 480,
      height: 280,
      inspect: true,
    });
    expect(svg).toContain('class="k2b-chart-previous"');
    expect(svg).toContain("&quot;key&quot;:&quot;delta&quot;");
    expect(svg).toContain("+50%");
    expect(svg).toContain('data-default="15"');
    expect(svg).toContain('data-default="10"');
    expect(svg).toContain("k2b-chart-category-band");
    expect(svg).not.toMatch(/NaN|Infinity/);
  });
  test("horizontal groups retain original indices, sum segments and suppress cramped values", () => {
    const spec = {
      series: ["Q1", "Q2"],
      rows: [
        { group: "Store", label: "Desks", values: [1, 99] },
        { group: "Web", label: "Lamps", values: [40, 60] },
      ],
    };
    const layout = hbarLayout(spec);
    expect(layout.rows.map((r) => r.total)).toEqual([100, 100]);
    expect(layout.rows[0]?.segments[1]?.x).toBeGreaterThan(layout.left);
    const svg = renderHbarSvg({ ...spec, width: 480, height: 280, inspect: true });
    expect(svg).toContain("Store");
    expect(svg).toContain("Web");
    expect(svg).not.toContain(">1</text>");
    expect(() => hbarLayout({ ...spec, rows: [{ label: "bad", values: [-1, 2] }] })).toThrow("nonnegative");
  });
});

test("dense grouped bars retain positive widths and whole labels inside the frame", () => {
  for (const [count, length] of [
    [3, 60],
    [8, 31],
  ]) {
    const x = Array.from({ length: length! }, (_, i) => `January ${i}`);
    const series = Array.from({ length: count! }, (_, i) => ({ label: `Series ${i}`, data: x.map(() => i + 1) }));
    const svg = renderBarChartSvg({ x, series, width: 480, height: 280, xAxis: { ordered: true } });
    const widths = [...svg.matchAll(/class="stdlib-chart-bar [^"]*"[^>]*width="([^"]*)"/g)].map((m) => Number(m[1]));
    expect(widths).toHaveLength(count! * length!);
    expect(widths.every((w) => w > 0)).toBe(true);
    expect(svg).not.toContain(">Ja</text>");
    expect(svg).not.toContain(">n</text>");
    const ys = [...svg.matchAll(/class="stdlib-chart-tick-label stdlib-chart-category-label"[^>]*y="([^"]*)"/g)].map((m) => Number(m[1]));
    expect(ys.every((y) => y + 16 < 280)).toBe(true);
    expect(ys.length).toBeGreaterThan(0);
  }
});
test("legends are bounded and horizontal bars retain headers and missing totals", () => {
  const spec = { x: ["A"], series: Array.from({ length: 20 }, (_, i) => ({ label: `A very long series name ${i}`, data: [null] })) };
  const g = seriesBarLayout(spec);
  expect(g.top).toBeLessThan(g.bottom);
  expect(g.legendLayout.height).toBeLessThanOrEqual(70);
  expect(g.legendLayout.hidden).toBeGreaterThan(0);
  expect(g.totals).toEqual([null]);
  expect(g.legendLayout.items.every((e) => e.total === null)).toBe(true);
  const svg = renderHbarSvg({
    series: ["A very long series name that must be truncated"],
    rows: [{ label: "Gap", values: [null] }],
    title: "Header",
    subtitle: "Details",
    width: 480,
    height: 280,
    locale: "de",
    inspect: true,
  });
  expect(svg).toContain(">Header</text>");
  expect(svg).toContain(">Details</text>");
  expect(svg).toContain("Gesamt: –");
  expect(svg).not.toContain(">A very long series name that must be truncated</text>");
});
test("comparison gaps and German percent changes retain their semantics", () => {
  const svg = renderBarChartSvg({
    x: ["A", "B", "C"],
    series: [{ label: "Jetzt", data: [9, null, 8] }],
    compare: { label: "Vorher", data: [8, 4, null] },
    width: 480,
    height: 280,
    locale: "de-DE",
    inspect: true,
  });
  expect(svg).toContain("Änderung: +12,5");
  expect(svg).toContain("&quot;key&quot;:&quot;delta&quot;,&quot;value&quot;:&quot;–&quot;");
  expect(svg).not.toMatch(/NaN|Infinity/);
});

test("dense comparison pairs stay inside their category and budget the actual width", () => {
  const spec = {
    x: Array.from({ length: 60 }, (_, i) => `Week ${i + 1}`),
    series: [{ label: "Now", data: Array<number>(60).fill(2) }],
    compare: { label: "Before", data: Array<number>(60).fill(1) },
  };
  const g = seriesBarLayout(spec);
  expect(g.barWidthPx).toBeCloseTo(Math.min(g.slot * 0.32, 26) / g.units);
  const svg = renderBarChartSvg({ ...spec, width: 480, height: 280 });
  const bars = [...svg.matchAll(/class="stdlib-chart-bar stdlib-chart-series-0" x="([^"]*)"[^>]*width="([^"]*)"/g)];
  expect(bars).toHaveLength(120);
  bars.forEach((bar, i) => {
    const category = g.columns[Math.floor(i / 2)]!;
    expect(Number(bar[1])).toBeGreaterThanOrEqual(category.center - g.slot / 2);
    expect(Number(bar[1]) + Number(bar[2])).toBeLessThanOrEqual(category.center + g.slot / 2);
  });
});

test("horizontal legend budget is stable when rows grow the reserved height", () => {
  const spec = {
    series: Array.from({ length: 20 }, (_, i) => `Long channel name ${i}`),
    rows: Array.from({ length: 30 }, (_, i) => ({ label: `Row ${i}`, values: Array(20).fill(1) as number[] })),
  };
  const layout = hbarLayout(spec);
  const rendered = hbarLayout(spec, { width: 480, height: layout.height });
  expect(rendered.legend.height).toBe(layout.legend.height);
  expect(rendered.legend.hidden).toBe(layout.legend.hidden);
  expect(rendered.height).toBe(layout.height);
  expect(renderHbarSvg({ ...spec, width: 480, height: layout.height }).match(/viewBox="([^"]+)"/)?.[1]).toBe(`0 0 480 ${layout.height}`);
});

test("localized inspection titles escape category and series text once", () => {
  const label = "<title>".repeat(2048);
  const svg = renderBarChartSvg({
    x: [label],
    layout: "stacked",
    series: [{ label: "A < B", data: [2] }],
    width: 480,
    height: 280,
    inspect: true,
    locale: "de",
  });
  const rows = renderHbarSvg({ series: ["A < B"], rows: [{ label, values: [2] }], width: 480, height: 280, inspect: true, locale: "de" });
  for (const drawing of [svg, rows]) {
    expect(drawing.match(/<title>/g)).toHaveLength(1);
    expect(drawing).toContain("&lt;title&gt;".repeat(2048));
    expect(drawing).toContain("A &lt; B: 2");
    expect(drawing).toContain("Gesamt: 2");
  }
});
