import { expect, test } from "bun:test";
import { parseRows069, positiveRows069Json, signedRows069Json } from "../../ui/test/chart-rows-069-fixture";
import { chartKinds, chartRenderOptions, chartTable, drawChart } from "./charts";
import { notebookChartHeight } from "./markdown/lib/chart-blocks";

test("the frozen 0.69 signed rows description survives editor validation, drawing and tables", () => {
  const signedRows069 = parseRows069(signedRows069Json);
  for (const limits of [undefined, { maxSeries: 8, maxValues: 480, maxMarks: 3840 }]) {
    const input = chartKinds(limits).parse(signedRows069);
    expect(input).toEqual(signedRows069);
    expect(notebookChartHeight(input, "en")).toBeGreaterThan(0);
    expect(drawChart(chartRenderOptions(input, "en"))).toContain('data-bar-layout="rows"');
    expect(chartTable(input, "en").rows.map((row) => row.values.value)).toEqual([-12, 30, -4, 0]);
  }
});

test("ranked-only options explain that signed data cannot use shares, limits or tone", () => {
  for (const option of [{ share: true }, { share: false }, { limit: 1 }, { tone: "out" }, { tone: "in" }]) {
    expect(() => chartKinds().parse({ ...parseRows069(signedRows069Json), ...option })).toThrow(
      "Share, limit and tone need nonnegative values.",
    );
  }
});

test("frozen positive 0.69 rows preserve their order and options through the editor", () => {
  for (const json of Object.values(positiveRows069Json)) {
    const input = chartKinds().parse(JSON.parse(json));
    const svg = drawChart(chartRenderOptions(input, "en"));
    expect(svg).not.toContain("k2b-chart-ranked");
    expect(chartTable(input, "en").rows.map((row) => row.values.value)).toEqual([20, 50, 30]);
  }
  const input = chartKinds().parse({ ...parseRows069(positiveRows069Json.ordered), limit: 1 });
  expect(chartTable(input, "en").rows).toHaveLength(3);
  expect(chartTable(input, "en").columns.map((column) => column.id)).not.toContain("rank");
});
