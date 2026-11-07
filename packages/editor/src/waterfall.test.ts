import { expect, test } from "bun:test";
import { chartKinds, chartMarks, chartTable } from "./charts";
import { notebookChartHeight } from "./markdown/lib/chart-blocks";

const spec = {
  kind: "waterfall",
  title: "Autumn cash",
  start: { label: "Opening", value: 1250 },
  steps: [
    { label: "Receipts", value: 700 },
    { label: "Rent", value: -250 },
  ],
  end: { label: "Closing" },
  format: { style: "currency", currency: "EUR", decimals: 0 },
};
test("waterfall JSON shares all rows and exact running balances with Chat, Notebooks and cloud.chart", () => {
  const input = chartKinds().parse(spec);
  expect(input.kind).toBe("waterfall");
  expect(notebookChartHeight(input, "de")).toBe(280);
  expect(chartMarks(input)).toBe(4);
  const table = chartTable(input, "de");
  expect(table.rows.map((r) => r.values.after ?? r.values.balance)).toEqual([1250, 1950, 1700, 1700]);
  expect(table.rows[2]!.cells.after).toContain("1.700");
  expect(table.columns.map((c) => c.label)).toEqual(["Kategorie", "Stand", "Rein", "Stand danach", "Raus"]);
});
test("both application and AI JSON boundaries reject null changes and overflow", () => {
  for (const schema of [chartKinds(), chartKinds({ maxSeries: 8, maxValues: 480, maxMarks: 3840 })]) {
    expect(schema.safeParse({ ...spec, steps: [{ label: "Missing", value: null }] }).success).toBe(false);
    expect(schema.safeParse({ ...spec, start: { label: "Big", value: 1e308 }, steps: [{ label: "Big", value: 1e308 }] }).success).toBe(
      false,
    );
    expect(schema.safeParse({ ...spec, end: {label: "Closing", value: 0} }).success).toBe(false);
    expect(schema.safeParse({ ...spec, steps: [] }).success).toBe(true);
  }
});

test("all hosts expose direction words, unsigned outflow and only a balance for totals", () => {
  const table=chartTable(chartKinds().parse(spec), "de");
  expect(table.rows[0]!.cells).toEqual({label:"Opening",balance:"1.250 €"});
  expect(table.rows[2]!.cells.outflow).toBe("↗ 250 €");
  expect(table.rows[2]!.cells.after).toBe("1.700 €");
});
