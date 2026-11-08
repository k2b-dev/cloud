import { expect, test } from "bun:test";
import { signedRows069 } from "../../ui/test/chart-rows-069-fixture";
import { chartKinds, chartRenderOptions, chartTable, drawChart } from "./charts";
import { notebookChartHeight } from "./markdown/lib/chart-blocks";

test("the frozen 0.69 signed rows description survives editor validation, drawing and tables", () => {
  for (const limits of [undefined, { maxSeries: 8, maxValues: 480, maxMarks: 3840 }]) {
    const input = chartKinds(limits).parse(signedRows069);
    expect(input).toEqual(signedRows069);
    expect(notebookChartHeight(input, "en")).toBeGreaterThan(0);
    expect(drawChart(chartRenderOptions(input, "en"))).toContain('data-bar-layout="rows"');
    expect(chartTable(input, "en").rows.map((row) => row.values.value)).toEqual([-12, 30, -4, 0]);
  }
});

test("ranked-only options never truncate signed data or add ranks and shares to its table", () => {
  const input = chartKinds().parse({ ...signedRows069, share: true, limit: 1, tone: "out" });
  const table = chartTable(input, "en");
  expect(table).toEqual(chartTable(chartKinds().parse(signedRows069), "en"));
  expect(table.rows).toHaveLength(4);
  expect(table.columns.map((column) => column.id)).not.toContain("rank");
  expect(drawChart(chartRenderOptions(input, "en"))).not.toContain("k2b-chart-ranked");
});
