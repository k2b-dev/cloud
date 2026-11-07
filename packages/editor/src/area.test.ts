import { expect, test } from "bun:test";
import { prepareChartSnapshot } from "@k2b/ui";
import { chartKinds, chartMarks, chartRenderOptions, chartTable, chartTooltip } from "./charts";
import { notebookChartHeight, renderNotebookChartFigure } from "./markdown/lib/chart-blocks";

const spec = {
  kind: "area",
  title: "Sales mix",
  layout: "stacked",
  normalize: true,
  x: ["Jan", "Feb", "Mar"],
  series: [
    { label: "Recurring", data: [30, 0, null] },
    { label: "One-off", data: [70, 0, 10] },
  ],
};
test("portable normalized area preserves amount and share in every table row", () => {
  const input = chartKinds().parse(spec),
    table = chartTable(input, "de");
  expect(chartMarks(input)).toBe(6);
  expect(notebookChartHeight(input, "de")).toBe(280);
  expect(table.rows).toHaveLength(2);
  expect(table.rows.map((r) => r.values.value)).toEqual([30, 70]);
  expect(table.rows.map((r) => r.values.percent)).toEqual([30, 70]);
  expect(table.columns.map((c) => c.label)).toContain("Anteil");
});
test("both JSON policies reject negative stacks and length mismatches but accept null gaps", () => {
  for (const schema of [chartKinds(), chartKinds({ maxSeries: 8, maxValues: 480, maxMarks: 3840 })]) {
    expect(schema.safeParse(spec).success).toBe(true);
    expect(schema.safeParse({ ...spec, series: [{ label: "Bad", data: [1, -2, 3] }] }).success).toBe(false);
    expect(schema.safeParse({ ...spec, series: [{ label: "Bad", data: [1] }] }).success).toBe(false);
  }
});

test("server snapshots retain the request locale for normalized shares", () => {
  const input = chartKinds().parse(spec);
  const snapshot = prepareChartSnapshot(chartRenderOptions(input, "de"), {
    key: ({ datum }) => `${datum.seriesIndex}:${datum.index}`,
    tooltip: () => ({ rows: [] }),
  });
  expect(snapshot.marks[0]?.datum.values.find((field) => field.key === "percent")?.formatted).toBe("30,0 %");
});

test("area tooltip has the same category, share and amount in every host", () => {
  const input = chartKinds().parse(spec),
    table = chartTable(input, "de");
  expect(chartTooltip(table.columns, table.rows[0]!, input.kind)).toEqual({
    title: "Jan",
    rows: [{ label: "Recurring", value: "30,0 % · 30" }],
  });
});

test("absolute zeros and numeric categories keep the same tooltip text as the renderer", () => {
  const input = chartKinds().parse({ ...spec, normalize: false, x: [2023, 2024, 2025] });
  const table = chartTable(input, "de");
  expect(table.rows).toHaveLength(4);
  expect(table.rows[0]!.cells.x).toBe("2023");
  expect(chartTooltip(table.columns, table.rows[0]!, input.kind).title).toBe("2023");
  expect(table.rows.filter((r) => r.values.x === 2024).map((r) => r.cells.value)).toEqual(["0", "0"]);
});

test("Notebook line legends keep their existing names without area cursor values", () => {
  const line = chartKinds().parse({
    kind: "line",
    title: "Requests",
    legend: true,
    series: [
      {
        label: "Requests",
        data: [
          { x: 1, y: 2 },
          { x: 2, y: 3 },
        ],
      },
    ],
  });
  const html = renderNotebookChartFigure(line, "de");
  expect(html).toContain("Requests");
  expect(html).not.toContain("data-chart-legend-value");
});
