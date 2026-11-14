import { expect, test } from "bun:test";
import { chartKinds, chartRenderOptions, chartRows, chartSvgMarks, chartTable, chartTooltip, drawChart } from "./charts";
import { notebookChartHeight } from "./markdown/lib/chart-blocks";

const schema = chartKinds();
const bubble = {
  kind: "bubble",
  title: "Campaigns",
  locale: "de-DE",
  groups: ["North"],
  xLabel: "Besuche",
  yLabel: "Öffnungen",
  sizeLabel: "Kontakte",
  averages: true,
  data: [{ label: "Brief A", group: "North", x: 1200, y: 2400, size: 3600 }],
} as const;
const radar = {
  kind: "radar",
  title: "Score",
  axes: ["Quality", "Speed", "Cost"],
  max: 5,
  unit: "points",
  series: [
    { label: "A", data: [1, 2, 3] },
    { label: "B", data: [4, 3, 2] },
  ],
} as const;
test("bubble JSON passes named coordinates, group and area measure identically to tooltip/table", () => {
  const input = schema.parse(bubble),
    options = chartRenderOptions(input, "en", { width: 900 });
  expect(options.kind).toBe("bubble");
  if (options.kind !== "bubble") throw Error("kind");
  expect(options.displayWidth).toBe(900);
  expect(options.locale).toBe("de-DE");
  const rows = chartRows(input, "en");
  const mark = chartSvgMarks(drawChart(options))[0]!;
  const row = rows.add(mark);
  const tip = chartTooltip(rows.columns(), row);
  expect(tip.title).toBe("Brief A");
  expect(tip.rows).toEqual([
    { label: "Bereich", value: "North" },
    { label: "Besuche", value: "1.200" },
    { label: "Öffnungen", value: "2.400" },
    { label: "Kontakte", value: "3.600" },
  ]);
  expect(schema.safeParse({ ...bubble, locale: "de_DE" }).success).toBe(false);
  expect(schema.safeParse({ ...bubble, data: [{ ...bubble.data[0], size: -1 }] }).success).toBe(false);
  expect(schema.safeParse({ ...bubble, data: [{ ...bubble.data[0], group: "missing" }] }).success).toBe(false);
});
test("radar table has one axis row, same-unit series values and complete series labels", () => {
  const input = schema.parse(radar);
  const table = chartTable(input, "en");
  expect(table.rows).toHaveLength(3);
  expect(table.columns.map((c) => c.label)).toEqual(["Axis", "A", "B"]);
  expect(chartTooltip(table.columns, table.rows[0]!)).toEqual({
    title: "Quality",
    rows: [
      { label: "A", value: "1 / 5 points" },
      { label: "B", value: "4 / 5 points" },
    ],
  });
  for (const patch of [
    { axes: ["A", "B"] },
    { max: 0 },
    { series: [{ label: "A", data: [1, 2, 6] }] },
    { series: [{ label: "A", data: [1, 2] }] },
  ])
    expect(schema.safeParse({ ...radar, ...patch }).success).toBe(false);
});

test("notebook frames reserve the same 280-unit drawing as the core", () => {
  expect(notebookChartHeight(schema.parse(bubble), "en")).toBe(280);
  expect(notebookChartHeight(schema.parse(radar), "en")).toBe(280);
});
