import { expect, test } from "bun:test";
import { charts } from "@k2b/stdlib";
import { lineGapsSvg } from "./chart-line-gaps";

const render = (data: { x: number; y: number }[]) => charts.line({ series: [{ label: "A & B", data }], inspect: true, smooth: false });
const paths = (svg: string) => [...svg.matchAll(/<path class="stdlib-chart-line [^"]*" d="([^"]*)"/g)].map((match) => match[1]!);

test("splits adjacent runs while preserving inspection metadata and isolated zero", () => {
  const svg = render([
    { x: 11, y: 2 },
    { x: 0, y: 1 },
    { x: 1, y: 2 },
    { x: 10, y: 1 },
    { x: 20, y: 0 },
  ]);
  const result = lineGapsSvg(svg, 1, { smooth: false });
  expect(paths(result)[0]!.match(/M/g)).toHaveLength(2);
  expect([...result.matchAll(/data-chart-datum="[^"]*"/g)].map((m) => m[0])).toEqual(
    [...svg.matchAll(/data-chart-datum="[^"]*"/g)].map((m) => m[0]),
  );
  expect(result).toContain('fill="var(--stdlib-chart-c1)"');
  expect(paths(svg)[0]!.match(/M/g)).toHaveLength(1);
});

test("single samples remain visible and empty series stay empty", () => {
  expect(lineGapsSvg(render([{ x: 0, y: 0 }]), 1, {})).toContain('fill="var(--stdlib-chart-c1)"');
  expect(lineGapsSvg(render([]), 1, {})).not.toContain('data-chart-role="point"');
});

test("smooth and step paths each restart after a gap", () => {
  const svg = render([
    { x: 0, y: 1 },
    { x: 1, y: 2 },
    { x: 10, y: 2 },
    { x: 11, y: 3 },
  ]);
  for (const options of [{}, { step: "middle" as const }]) {
    expect(paths(lineGapsSvg(svg, 1, options))[0]!.match(/M/g)).toHaveLength(2);
  }
});

test("rejects invalid gap thresholds", () => {
  for (const gap of [0, -1, NaN, Infinity]) expect(() => lineGapsSvg(render([]), gap, {})).toThrow(RangeError);
});

test("keeps series palettes and labels with empty series and more than eight series", () => {
  const svg = charts.line({
    inspect: true,
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
  const result = lineGapsSvg(svg, 1, {});
  expect(paths(result).every((path) => path.trim() === "")).toBe(true);
  expect(result.match(/fill="var\(--stdlib-chart-c2\)"/g)).toHaveLength(4);
  expect(result).toContain("Series 9");
});
