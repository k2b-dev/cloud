import { expect, test } from "bun:test";
import { parseRows069, positiveRows069Json, signedRows069Json } from "../../test/chart-rows-069-fixture";
import { barChartLayout, renderBarChartSvg } from "../charts/core";

test("frozen 0.69 signed rows retain source order and diverge around zero in the core", () => {
  const signedRows069 = parseRows069(signedRows069Json);
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
  const signedRows069 = parseRows069(signedRows069Json);
  const spec = { ...signedRows069, data: signedRows069.data.filter((d) => d.value < 0) };
  const svg = renderBarChartSvg({ ...spec, width: 480, height: barChartLayout(spec).height, inspect: true });
  expect(svg).not.toMatch(/NaN|Infinity|k2b-chart-ranked/);
  expect(svg).toContain(">-12</text>");
  expect(svg).toContain(">-4</text>");
  expect(svg.indexOf(">Returns</text>")).toBeLessThan(svg.indexOf(">Correction</text>"));
});

test("frozen positive 0.69 rows preserve category order and legacy drawing options", () => {
  for (const [name, json] of Object.entries(positiveRows069Json)) {
    const spec = parseRows069(json);
    for (const width of [296, 480, 1920]) {
      const svg = renderBarChartSvg({ ...spec, width, height: barChartLayout(spec, width).height, inspect: true });
      expect(svg).not.toMatch(/NaN|Infinity|k2b-chart-ranked/);
      expect([...svg.matchAll(/stdlib-chart-category-label"[^>]*>([^<]*)</g)].map((m) => m[1])).toEqual(["Young", "Adult", "Senior"]);
      expect(svg).toContain('class="stdlib-chart-axis"');
      if (name === "references") {
        expect(svg).toContain('class="stdlib-chart-reference"');
        expect(svg).toContain(">Target</text>");
      }
      if (name === "colorByBar")
        for (const index of [0, 1, 2]) expect(svg).toContain(`class="stdlib-chart-bar stdlib-chart-series-${index}"`);
      if (name === "showValues") {
        expect(svg).not.toContain('class="stdlib-chart-bar-value"');
        expect(svg).toContain('class="stdlib-chart-grid"');
      } else expect(svg.match(/class="stdlib-chart-bar-value"/g)).toHaveLength(3);
      if (name === "categoryLabel") expect(svg).toContain(">Age band</text>");
      if (name === "valueLabel") expect(svg).toContain(">People</text>");
      if (name === "domain" || name === "scale") {
        const fallback = renderBarChartSvg({
          ...spec,
          yAxis: undefined,
          xAxis: { ordered: true },
          width,
          height: barChartLayout(spec, width).height,
        });
        const lengths = (drawing: string) =>
          [...drawing.matchAll(/class="stdlib-chart-bar stdlib-chart-series-0"[^>]*width="([^"]+)"/g)].map((m) => Number(m[1]));
        expect(lengths(svg)).not.toEqual(lengths(fallback));
      }
    }
  }
});

test("explicit legacy false and empty options still use the original row drawing", () => {
  const spec = parseRows069(positiveRows069Json.ordered);
  for (const option of [{ colorByBar: false }, { showValues: true }, { references: [] }]) {
    const svg = renderBarChartSvg({ ...spec, xAxis: undefined, ...option, width: 480, height: 280 });
    expect(svg).not.toContain("k2b-chart-ranked");
  }
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
