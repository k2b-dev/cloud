import { expect, test } from "bun:test";
import { signedRows069 } from "../../test/chart-rows-069-fixture";
import { barChartLayout, renderBarChartSvg } from "../charts/core";

test("frozen 0.69 signed rows retain source order and diverge around zero in the core", () => {
  for (const width of [296, 480, 1920]) {
    const { layout, height } = barChartLayout(signedRows069, width);
    expect(layout).toBe("rows");
    const svg = renderBarChartSvg({ ...signedRows069, width, height, inspect: true });
    expect(svg).not.toMatch(/NaN|Infinity|k2b-chart-ranked/);
    expect([...svg.matchAll(/stdlib-chart-category-label"[^>]*>([^<]*)</g)].map((m) => m[1])).toEqual(
      signedRows069.data.map((d) => d.label),
    );
    const baseline = Number(svg.match(/class="stdlib-chart-axis" x1="([^"]+)"/)?.[1]);
    expect(Number.isFinite(baseline)).toBe(true);
    const bars = [...svg.matchAll(/class="stdlib-chart-bar stdlib-chart-series-0" x="([^"]+)"[^>]*width="([^"]+)"/g)];
    expect(bars).toHaveLength(signedRows069.data.length);
    for (const [index, bar] of bars.entries()) {
      const { value } = signedRows069.data[index]!;
      const x = Number(bar[1]),
        length = Number(bar[2]);
      expect(length).toBeGreaterThanOrEqual(0);
      expect(value < 0 ? x + length : x).toBeCloseTo(baseline, 1);
      if (value < 0) expect(x).toBeLessThan(baseline);
      else if (value === 0) expect(length).toBe(0);
      else expect(length).toBeGreaterThan(0);
    }
  }
});

test("entirely negative rows retain their source order and finite geometry", () => {
  const spec = { ...signedRows069, data: signedRows069.data.filter((d) => d.value < 0) };
  const svg = renderBarChartSvg({ ...spec, width: 480, height: barChartLayout(spec).height, inspect: true });
  expect(svg).not.toMatch(/NaN|Infinity|k2b-chart-ranked/);
  expect(svg).toContain(">-12</text>");
  expect(svg).toContain(">-4</text>");
  expect(svg.indexOf(">Returns</text>")).toBeLessThan(svg.indexOf(">Correction</text>"));
});

test("nonnegative ranked rows remain byte-identical to main 7126f02737", () => {
  // Captured before the fix: full SVG bytes, including styles, titles, inspection metadata and gaps.
  const hashes = [
    "8ed709c4fc937ace276b834977fb2286d711d4d90e1d8cb39e6a11c420224c62",
    "a821cd645739109bfba734984a0854d6170038b9b08306fd066ff0b13a06b638",
    "b94de11ee0cdc7ca2537af52046882a1984ba8c25d20f807171b071548b6d80f",
    "9c9bb5339256384c4dc54140e5068f7e3292f2ffe22ffad8cc97fc667e67c85d",
    "d170ed03beaf8fb4fa621f5ac8ce82d61d7be1f431c46078fd9289eb8fe7c56d",
    "53271fc4e5778b7eeea3b2f16dfafb1d4925cb3cef7ee53ac5b8a46f64fcca70",
  ];
  let index = 0;
  for (const width of [296, 480, 1920])
    for (const inspect of [false, true]) {
      const svg = renderBarChartSvg({
        layout: "rows",
        title: "Costs",
        share: true,
        limit: 2,
        tone: "out",
        data: [
          { label: "Small", value: 10 },
          { label: "Large", value: 50 },
          { label: "Medium", value: 30 },
          { label: "Gap", value: NaN },
        ],
        width,
        height: 280,
        inspect,
      });
      expect(new Bun.CryptoHasher("sha256").update(svg).digest("hex")).toBe(hashes[index++]!);
    }
});
