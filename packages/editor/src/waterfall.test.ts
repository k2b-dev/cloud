import { expect, test } from "bun:test";
import { prepareChartSnapshot } from "@k2b/ui";
import { chartKinds, chartMarks, chartTable, chartTooltip } from "./charts";
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
  expect(table.columns.map((c) => c.label)).toEqual(["Kategorie", "Stand davor", "Rein", "Raus", "Stand danach"]);
});
test("both application and AI JSON boundaries reject null changes and overflow", () => {
  for (const schema of [chartKinds(), chartKinds({ maxSeries: 8, maxValues: 480, maxMarks: 3840 })]) {
    expect(schema.safeParse({ ...spec, steps: [{ label: "Missing", value: null }] }).success).toBe(false);
    expect(schema.safeParse({ ...spec, start: { label: "Big", value: 1e308 }, steps: [{ label: "Big", value: 1e308 }] }).success).toBe(
      false,
    );
    expect(schema.safeParse({ ...spec, end: { label: "Closing", value: 0 } }).success).toBe(false);
    expect(schema.safeParse({ ...spec, steps: [] }).success).toBe(true);
  }
});

test("all hosts expose direction words, unsigned outflow and only a balance for totals", () => {
  const table = chartTable(chartKinds().parse(spec), "de");
  expect(table.rows[0]!.cells).toEqual({ label: "Opening", after: "1.250 €" });
  expect(table.rows[2]!.cells.outflow).toBe("↗ 250 €");
  expect(table.rows[2]!.cells.after).toBe("1.700 €");
  expect(table.rows[2]!.cells.before).toBe("1.950 €");
  expect(chartTooltip(table.columns, table.rows[0]!)).toEqual({ title: "Opening", rows: [{ label: "Stand", value: "1.250 €" }] });
  expect(chartTooltip(table.columns, table.rows[2]!)).toEqual({
    title: "Rent",
    rows: [
      { label: "Raus", value: "↗ 250 €" },
      { label: "Stand danach", value: "1.700 €" },
    ],
  });
});

test("pure snapshots preserve an explicit locale without a component provider", () => {
  const snapshot = prepareChartSnapshot(
    { kind: "waterfall", start: { label: "Opening", value: 1.5 }, steps: [], end: { label: "Closing" }, locale: "de" },
    { key: ({ datum }) => String(datum.index), tooltip: () => ({ rows: [] }) },
  );
  expect(snapshot.svg).toContain("1,5");
});

test("zero steps retain the neutral equals prefix in tables and host tooltips", () => {
  const table = chartTable(chartKinds().parse({ ...spec, steps: [{ label: "Unchanged", value: 0 }] }), "de");
  expect(table.columns.map((column) => column.id)).toEqual(["label", "before", "inflow", "outflow", "after"]);
  expect(table.rows[1]!.cells.inflow).toBe("= 0 €");
  expect(chartTooltip(table.columns, table.rows[1]!).rows).toEqual([
    { label: "Änderung", value: "= 0 €" },
    { label: "Stand danach", value: "1.250 €" },
  ]);
});
