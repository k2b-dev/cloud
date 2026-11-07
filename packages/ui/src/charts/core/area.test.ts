import { expect, test } from "bun:test";
import { areaLayout, renderAreaSvg } from "./area";

const size = { width: 480, height: 280 };
const spec = {
  layout: "stacked" as const,
  x: ["Jan", "Feb", "Mar", "Apr"],
  series: [
    { label: "Subscriptions", data: [30, 20, null, 0] },
    { label: "One-off", data: [70, 20, 10, 0] },
  ],
};
test("absolute layers accumulate; normalized layers end at one and retain source amounts", () => {
  const absolute = areaLayout(spec, size),
    normalized = areaLayout({ ...spec, normalize: true }, size);
  expect(absolute.layers[1]![0]).toEqual({ index: 0, amount: 70, share: 0.7, lower: 30, upper: 100 });
  expect(normalized.layers[1]![0]).toEqual({ index: 0, amount: 70, share: 0.7, lower: 0.3, upper: 1 });
  expect(normalized.layers[1]![1]!.upper).toBe(1);
});
test("null and zero-sum columns are gaps, never zeros or fabricated shares", () => {
  const g = areaLayout({ ...spec, normalize: true }, size);
  expect(g.totals).toEqual([100, 40, null, null]);
  expect(g.layers.map((l) => l.slice(2))).toEqual([
    [null, null],
    [null, null],
  ]);
  const svg = renderAreaSvg({ ...spec, normalize: true, ...size, inspect: true });
  expect(svg.match(/data-chart-datum=/g)).toHaveLength(4);
  expect(svg.match(/<polygon/g)).toHaveLength(2);
  expect(svg).not.toMatch(/NaN|Infinity/);
});
test("invalid lengths, negative stacks and overflowing sums fail before drawing", () => {
  expect(() => areaLayout({ ...spec, series: [{ label: "Bad", data: [1] }] }, size)).toThrow();
  expect(() => areaLayout({ ...spec, series: [{ label: "Bad", data: [1, -1, 0, 0] }] }, size)).toThrow();
  expect(() =>
    areaLayout(
      {
        layout: "stacked",
        x: ["Jan"],
        series: [
          { label: "A", data: [1e308] },
          { label: "B", data: [1e308] },
        ],
      },
      size,
    ),
  ).toThrow();
});
test("separated spans have distinct SVG paths and portable paint; shares use the chosen locale", () => {
  const svg = renderAreaSvg({
    layout: "stacked",
    normalize: true,
    x: [1, 2, 3, 4, 5],
    series: [{ label: "A", data: [1, 2, null, 2, 1] }],
    ...size,
    inspect: true,
    locale: "de",
  });
  expect(svg.match(/<polygon/g)).toHaveLength(2);
  expect(svg).toContain('fill="color-mix(in srgb, var(--stdlib-chart-c1,');
  expect(svg).toContain("100,0 %");
});

test("pure-host legends carry final values and remain bounded for many series", () => {
  const svg = renderAreaSvg({
    layout: "stacked",
    x: [1, 2],
    series: Array.from({ length: 40 }, (_, i) => ({ label: `Source ${i}`, data: [1, 2] })),
    ...size,
    inspect: true,
  });
  expect(svg.match(/<g><title>/g)).toHaveLength(4);
  expect(svg).toContain("+37");
  expect(svg).toContain('data-chart-legend-value data-series-index="0" data-field="value" data-default="2"');
});

test("measured wide hosts reserve tick space in CSS pixels", () => {
  const spec = { layout: "stacked" as const, x: [1, 2], series: [{ label: "Sales", data: [10, 20] }] };
  const size = { width: 900, height: 280 };
  expect(areaLayout({ ...spec, displayWidth: 900 }, size).left).toBeLessThan(100);
  expect(areaLayout({ ...spec, displayWidth: 900 }, size).left).toBeLessThan(areaLayout(spec, size).left);
});

test("absolute zero columns stay inspectable while zero normalized columns are gaps", () => {
  const absolute = areaLayout(spec, size);
  expect(absolute.totals).toEqual([100, 40, null, 0]);
  expect(absolute.layers[0]![3]).toEqual({ index: 3, amount: 0, share: 0, lower: 0, upper: 0 });
  const zero = { layout: "stacked" as const, x: [2023], series: [{ label: "A", data: [0] }] };
  expect(renderAreaSvg({ ...zero, ...size, inspect: true }).match(/data-chart-datum=/g)).toHaveLength(1);
  expect(renderAreaSvg({ ...zero, normalize: true, ...size, inspect: true })).not.toContain("data-chart-datum=");
});

test("single and isolated observations have a visible band and a top edge", () => {
  for (const data of [[3], [null, 3, null]]) {
    const svg = renderAreaSvg({ layout: "stacked", x: data.map((_, i) => i), series: [{ label: "A", data }], ...size });
    const polygon = /<polygon[^>]*points="([^"]+)"/.exec(svg)![1]!;
    const xs = polygon.split(" ").map((p) => Number(p.split(",")[0]));
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(1);
    expect(svg).toContain('stroke-width="1.5"');
    expect(svg).toContain('stroke="none"');
  }
  expect(areaLayout({ layout: "stacked", x: [1], series: [{ label: "A", data: [1] }] }, size).top).toBe(36);
});
