import { expect, test } from "bun:test";
import { chartKinds, chartMarks, chartRenderOptions, chartTable, drawChart } from "./charts";

const schema = chartKinds();
test("portable funnels reject negative values and preserve rising, zero and missing observations", () => {
  const spec = {
    kind: "funnel",
    title: "Conversion",
    data: [
      { label: "A", value: 0 },
      { label: "B", value: 20 },
      { label: "C", value: null },
      { label: "D", value: 30 },
    ],
  };
  const input = schema.parse(spec);
  expect(chartMarks(input)).toBe(4);
  const table = chartTable(input, "en");
  expect(table.rows[1]!.cells.startPercent).toBe("–");
  expect(table.columns.find((c) => c.id === "startPercent")?.numeric).toBe(true);
  expect(table.rows[2]!.cells.value).toBe("–");
  expect(table.rows[3]!.values.value).toBe(30);
  expect(schema.safeParse({ ...spec, data: [{ label: "bad", value: -1 }] }).success).toBe(false);
});
test("portable ranked rows validate options and keep every source row in the table", () => {
  const spec = {
    kind: "bar",
    title: "Costs",
    layout: "rows",
    share: true,
    limit: 1,
    tone: "out",
    format: { style: "currency", currency: "EUR" },
    data: [
      { label: "A", value: 10 },
      { label: "B", value: 30 },
      { label: "C", value: 20 },
    ],
  };
  const input = schema.parse(spec);
  expect(chartMarks(input)).toBe(3);
  expect(chartRenderOptions(input, "de")).toMatchObject({ share: true, limit: 1, tone: "out" });
  expect(chartTable(input, "de").rows).toHaveLength(3);
  expect(chartTable(input, "de")).toEqual(chartTable(schema.parse({ ...spec, limit: undefined }), "de"));
  expect(drawChart(chartRenderOptions(input, "de"))).toContain("2 weitere");
  expect(schema.safeParse({ ...spec, layout: "columns" }).success).toBe(false);
  expect(schema.safeParse({ ...spec, limit: 0 }).success).toBe(false);
  expect(schema.safeParse({ ...spec, data: [{ label: "bad", value: -2 }] }).success).toBe(false);
});
