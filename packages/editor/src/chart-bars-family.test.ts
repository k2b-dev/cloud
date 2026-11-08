import { expect, test } from "bun:test";
import type { ChartDescription, ChartInput } from "@k2b/ui/charts";
import { chartKinds } from "./chart-schema";
import { chartMarks, chartRenderOptions, chartTable } from "./charts";
import { notebookChartHeight } from "./markdown/lib/chart-blocks";

const schema = chartKinds();
const base = {
  kind: "bar",
  title: "Orders",
  x: ["A", "B"],
  series: [
    { label: "Shop", data: [10, 0] },
    { label: "Fair", data: [30, null] },
  ],
};
test("portable bars validate dimensions, stack signs and comparison shape", () => {
  expect(schema.safeParse({ ...base, layout: "stacked" }).success).toBe(true);
  expect(schema.safeParse({ ...base, layout: "stacked", series: [{ label: "Bad", data: [-1, 2] }] }).success).toBe(false);
  expect(schema.safeParse({ ...base, x: ["A"] }).success).toBe(false);
  expect(schema.safeParse({ ...base, compare: { label: "Before", data: [1, 2] } }).success).toBe(false);
  expect(schema.safeParse({ ...base, normalize: true }).success).toBe(false);
  expect(
    schema.safeParse({ ...base, series: [{ label: "Shop", data: [1, 2] }], compare: { label: "Before", data: [null, 1] } }).success,
  ).toBe(true);
});
test("portable adapters preserve series, gaps, table numbers and actual mark budgets", () => {
  const input = schema.parse({ ...base, layout: "stacked", normalize: true });
  expect(chartMarks(input)).toBe(4);
  expect(chartRenderOptions(input, "en")).toMatchObject({ series: base.series, normalize: true });
  const table = chartTable(input, "en");
  expect(table.rows[0]?.values["series:0"]).toBe(10);
  expect(table.rows[0]?.values["series:1"]).toBe(30);
  expect(table.rows[1]?.cells["series:1"]).toBe("–");
});
test("portable horizontal bars reject mismatched or negative segments", () => {
  const spec = { kind: "hbar", title: "Orders", series: ["Q1", "Q2"], rows: [{ label: "Desks", group: "Shop", values: [10, 20] }] };
  expect(schema.safeParse(spec).success).toBe(true);
  expect(chartMarks(schema.parse(spec))).toBe(2);
  expect(chartTable(schema.parse(spec), "en").rows[0]?.values["series:1"]).toBe(20);
  expect(schema.safeParse({ ...spec, rows: [{ label: "bad", values: [1] }] }).success).toBe(false);
  expect(schema.safeParse({ ...spec, rows: [{ label: "bad", values: [-1, 2] }] }).success).toBe(false);
});

test("all-null totals are gaps and localized total headers agree with inspection", () => {
  const input = schema.parse({ ...base, x: ["Gap"], series: [{ label: "Shop", data: [null] }], layout: "stacked" });
  const table = chartTable(input, "de");
  expect(table.columns.find((c) => c.id === "total")?.label).toBe("Gesamt");
  expect(table.rows[0]?.cells.total).toBe("–");
  expect(schema.safeParse({ ...base, layout: "nested" }).success).toBe(false);
  expect(schema.safeParse({ ...base, xAxis: { ordered: true } }).success).toBe(true);
});

test("Notebook horizontal rows reserve their growing drawing height", () => {
  const input = schema.parse({
    kind: "hbar",
    title: "Rows",
    series: ["Count"],
    rows: Array.from({ length: 20 }, (_, i) => ({ label: `Row ${i}`, values: [i] })),
  });
  expect(notebookChartHeight(input, "en")).toBeGreaterThan(600);
});

test("unlimited editor bars support an empty state while AI-limited bars require data", () => {
  const empty = { kind: "bar", title: "Orders", data: [] };
  expect(schema.safeParse(empty).success).toBe(true);
  const limited = chartKinds({ maxSeries: 8, maxValues: 480, maxMarks: 1000 }).safeParse(empty);
  expect(limited.success).toBe(false);
  if (!limited.success) expect(limited.error.issues.some((issue) => issue.path[0] === "data")).toBe(true);
});

test("shared portable descriptions accept aligned bars and horizontal null gaps", () => {
  const descriptions = [
    {
      kind: "bar",
      title: "Opens",
      x: ["Jan", "Feb"],
      series: [{ label: "Current", data: [12, null] }],
      layout: "grouped",
      compare: { label: "Previous", data: [null, 8] },
      xAxis: { ordered: true },
    },
    { kind: "hbar", title: "Orders", series: ["Online", "Shop"], rows: [{ group: "Furniture", label: "Desks", values: [12, null] }] },
  ] satisfies ChartDescription[];
  const inputs: ChartInput[] = descriptions.map((description) => schema.parse(description));
  expect(inputs[0]).toMatchObject({ data: [], compare: { data: [null, 8] } });
  expect(inputs[1]).toMatchObject({ rows: [{ values: [12, null] }] });
});
