import { expect, test } from "bun:test";
import { charts, type LineOptions } from "../charts/core";

const render = (data: { x: number; y: number }[], options: Omit<LineOptions, "series"> = {}) =>
  charts.line({ series: [{ label: "A & B", data }], inspect: true, smooth: false, ...options });
const paths = (svg: string) => [...svg.matchAll(/<path class="stdlib-chart-line [^"]*" d="([^"]*)"/g)].map((match) => match[1]!);

test("splits adjacent runs while preserving inspection metadata and isolated zero", () => {
  const data = [
    { x: 11, y: 2 },
    { x: 0, y: 1 },
    { x: 1, y: 2 },
    { x: 10, y: 1 },
    { x: 20, y: 0 },
  ];
  const svg = render(data),
    result = render(data, { maxGap: 1 });
  expect(paths(result)).toHaveLength(2);
  expect(paths(result).every((path) => path.match(/M/g)?.length === 1)).toBe(true);
  expect([...result.matchAll(/data-chart-datum="[^"]*"/g)].map((m) => m[0])).toEqual(
    [...svg.matchAll(/data-chart-datum="[^"]*"/g)].map((m) => m[0]),
  );
  expect(result).toContain('fill="var(--stdlib-chart-c1, #2563eb)"');
  expect(paths(svg)).toHaveLength(1);
});

test("single samples remain visible and empty series stay empty", () => {
  expect(render([{ x: 0, y: 0 }], { maxGap: 1 })).toContain('fill="var(--stdlib-chart-c1, #2563eb)"');
  expect(render([], { maxGap: 1 })).not.toContain('data-chart-role="point"');
});

test("smooth and step paths each restart after a gap", () => {
  const data = [
    { x: 0, y: 1 },
    { x: 1, y: 2 },
    { x: 10, y: 2 },
    { x: 11, y: 3 },
  ];
  for (const options of [{ smooth: true }, { step: "middle" as const }]) {
    const runs = paths(render(data, { ...options, maxGap: 1 }));
    expect(runs).toHaveLength(2);
    expect(runs.every((path) => path.match(/M/g)?.length === 1)).toBe(true);
  }
});

test("rejects invalid gap thresholds", () => {
  for (const gap of [0, -1, NaN, Infinity]) expect(() => render([], { maxGap: gap })).toThrow(RangeError);
});

test("keeps series palettes and labels with empty series and more than eight series", () => {
  const result = charts.line({
    inspect: true,
    maxGap: 1,
    series: Array.from({ length: 10 }, (_, i) => ({
      label: `Series ${i}`,
      data:
        i === 3
          ? []
          : [
              { x: 0, y: i },
              { x: 10, y: i + 1 },
            ],
    })),
  });
  expect(paths(result)).toHaveLength(0);
  expect(result.match(/fill="var\(--stdlib-chart-c2, #16a34a\)"/g)).toHaveLength(4);
  expect(result).toContain("Series 9");
});
