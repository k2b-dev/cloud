import { expect, test } from "bun:test";
import { charts } from "@k2b/stdlib";
import { z } from "zod";
import { cloudAiChartRenderOptions } from "./chart-block";
import { type CloudAiExplorerView, cloudAiExplorerControls, cloudAiExplorerState, cloudAiViewTable, parseCloudAiView } from "./view-block";

const view: CloudAiExplorerView = {
  view: "explorer",
  title: "Inventory",
  columns: [
    { id: "product", type: "text" },
    { id: "status", type: "text" },
    { id: "year", type: "text" },
    { id: "price", type: "number", format: { style: "currency", currency: "EUR" } },
    { id: "stock", type: "number" },
  ],
  rows: [
    { product: "A", status: "open", year: "2025", price: 10, stock: 2 },
    { product: "B", status: "paid", year: "2025", price: 20, stock: 3 },
    { product: "A", status: "open", year: "2026", price: 30, stock: 4 },
    { product: "B", status: "paid", year: "2026", price: 40, stock: 5 },
    { product: "C", status: "open", year: "2026", price: null, stock: 6 },
    { product: "D", status: "paid", year: "2026", price: 50, stock: null },
  ],
  views: [
    { id: "bar", label: "Stock", kind: "bar", x: "product", y: "stock" },
    { id: "line", label: "Trend", kind: "line", x: "price", y: "stock", series: "status" },
    { id: "scatter", label: "Price and stock", kind: "scatter", x: "price", y: "stock", series: "status" },
    { id: "heatmap", label: "Cells", kind: "heatmap", x: "product", y: "status", value: "stock" },
  ],
  controls: { filter: "status", step: "year" },
};
test("controls retain first-seen order and select the last step", () => {
  expect(parseCloudAiView(view)).toEqual(view);
  expect(cloudAiExplorerControls(view, "en")).toEqual({
    steps: [
      { key: "0", label: "2025" },
      { key: "1", label: "2026" },
    ],
    series: [
      { key: "0", label: "open", color: 0 },
      { key: "1", label: "paid", color: 1 },
    ],
    initial: { step: "1" },
  });
  expect(cloudAiExplorerControls({ ...view, controls: undefined }, "en").initial).toEqual({});
});
test("filtering removes rows everywhere and retains empty palette slots", () => {
  const state = cloudAiExplorerState(view, { step: "1", visibleKeys: ["1"] }, "en");
  expect(state.rows).toEqual([3, 5]);
  for (const chart of Object.values(state.charts)) expect(chart.marks.flat()).toEqual([3]);
  const input = state.charts.line!.input;
  if (input.kind !== "line") throw new Error("Expected line");
  expect(input.series[0]).toEqual({ label: "open", data: [] });
  expect(input.series[1]?.data).toEqual([{ x: 40, y: 5 }]);
  expect(state.charts.line!.legend).toEqual([{ label: "paid", color: 1, style: "solid" }]);
  expect(cloudAiExplorerState(view, { visibleKeys: [] }, "en").rows).toEqual([]);
  expect(cloudAiExplorerState(view, {}, "en").rows).toHaveLength(6);
});
test("comparison uses slot plus eight and keeps both steps in dataset order", () => {
  const compare = {
    ...view,
    views: view.views.filter((chart) => chart.kind === "line" || chart.kind === "scatter"),
    controls: { ...view.controls, compare: true },
  };
  const state = cloudAiExplorerState(compare, { step: "1", referenceStep: "0", visibleKeys: ["1"] }, "en");
  expect(state.rows).toEqual([1, 3, 5]);
  const input = state.charts.line!.input;
  if (input.kind !== "line") throw new Error("Expected line");
  expect(input.series).toHaveLength(10);
  expect(input.series[1]?.label).toBe("paid · 2026");
  expect(input.series[9]).toEqual({ label: "paid · 2025", role: "reference", data: [{ x: 20, y: 3 }] });
  expect(state.charts.line!.marks[9]).toEqual([1]);
  expect(state.charts.line!.legend).toEqual([
    { label: "paid · 2026", color: 1, style: "solid" },
    { label: "paid · 2025", color: 1, style: "dashed", reference: true },
  ]);
});
test("domains and formats use the whole dataset across steps and filters", () => {
  const first = cloudAiExplorerState(view, { step: "0" }, "en");
  const last = cloudAiExplorerState(view, { step: "1", visibleKeys: ["1"] }, "en");
  for (const id of ["bar", "line", "scatter", "heatmap"]) {
    const a = first.charts[id]!.input,
      b = last.charts[id]!.input;
    if ("yAxis" in a && "yAxis" in b) expect(a.yAxis).toEqual(b.yAxis);
    if ("xAxis" in a && "xAxis" in b && a.kind !== "bar" && b.kind !== "bar") {
      expect(a.xAxis).toEqual(b.xAxis);
      expect(a.xAxis?.format).toEqual({ style: "currency", currency: "EUR" });
    }
    if (a.kind === "bar") expect(a.yAxis?.domain?.[0]).toBe(0);
    if (a.kind === "heatmap" && b.kind === "heatmap") expect([a.min, a.max]).toEqual([b.min, b.max]);
  }
});

test("numeric x axes span the observations exactly while value axes round to nice ends", () => {
  const exact: CloudAiExplorerView = {
    ...view,
    rows: [
      { year: "2025", status: "open", price: 11, stock: 2.3 },
      { year: "2026", status: "paid", price: 49, stock: 5.7 },
    ],
    views: view.views.filter((chart) => chart.kind === "line" || chart.kind === "scatter"),
  };
  for (const request of [{ step: "0" }, { step: "1", visibleKeys: ["1"] }])
    for (const chart of Object.values(cloudAiExplorerState(exact, request, "en").charts)) {
      if (chart.input.kind !== "line" && chart.input.kind !== "scatter") throw new Error("Expected point chart");
      expect(chart.input.xAxis?.domain).toEqual([11, 49]);
      expect(chart.input.yAxis?.domain).toEqual([2, 6]);
    }
});
test("control and category labels share the table's localized cell text", () => {
  const numeric: CloudAiExplorerView = {
    ...view,
    controls: { step: "price" },
    rows: [view.rows[0]!, view.rows[1]!],
    views: [{ id: "bar", label: "Stock", kind: "bar", x: "price", y: "stock" }],
  };
  const table = cloudAiViewTable(numeric, "de-DE");
  expect(cloudAiExplorerControls(numeric, "de-DE").steps.map((step) => step.label)).toEqual(table.rows.map((row) => row.cells.price!));
  const bar = cloudAiExplorerState(numeric, {}, "de-DE").charts.bar!.input;
  if (bar.kind !== "bar") throw new Error("Expected bar");
  expect(bar.data.map((item) => item.label)).toEqual(table.rows.map((row) => row.cells.price!));
});
const DatumSchema = z.object({
  index: z.number(),
  seriesIndex: z.number().optional(),
  values: z.array(z.object({ key: z.string(), value: z.union([z.number(), z.string()]) })),
});
test.each(["bar", "line", "scatter", "heatmap"])("every drawn %s mark resolves to its dataset row, including hidden series", (id) => {
  const spec = view.views.find((chart) => chart.id === id)!;
  const point = id === "line" || id === "scatter";
  const single = { ...view, views: [spec], controls: { ...view.controls, compare: point } };
  const state = cloudAiExplorerState(single, { step: "1", ...(point ? { referenceStep: "0", visibleKeys: ["1"] } : {}) }, "en");
  const chart = state.charts[id]!;
  const options = cloudAiChartRenderOptions(chart.input, "en", { legend: "outside" });
  const svg =
    options.kind === "bar"
      ? charts.bar({ ...options, inspect: true })
      : options.kind === "line"
        ? charts.line({ ...options, inspect: true })
        : options.kind === "scatter"
          ? charts.scatter({ ...options, inspect: true })
          : options.kind === "heatmap"
            ? charts.heatmap({ ...options, inspect: true })
            : "";
  const marks = [...svg.matchAll(/data-chart-datum="([^"]*)"/g)].map((match) =>
    DatumSchema.parse(
      JSON.parse(
        match[1]!
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">"),
      ),
    ),
  );
  expect(marks).toHaveLength(point ? 2 : 3);
  expect(marks.map((mark) => chart.marks[mark.seriesIndex ?? 0]![mark.index]!).sort()).toEqual(chart.marks.flat().sort());
  for (const mark of marks) {
    const index = chart.marks[mark.seriesIndex ?? 0]![mark.index]!;
    expect(state.rows).toContain(index);
    const row = view.rows[index]!;
    const values = Object.fromEntries(mark.values.map(({ key, value }) => [key, value]));
    if (id === "line" || id === "scatter") expect(values).toMatchObject({ x: row.price, y: row.stock });
    else {
      if (typeof row.stock !== "number") throw new Error("Expected stock value");
      expect(values.value).toBe(row.stock);
    }
    if (id === "heatmap") expect(values).toMatchObject({ x: row.product, y: row.status });
  }
});
test("multiple y columns keep their slots and null cells produce no points", () => {
  const multi: CloudAiExplorerView = {
    ...view,
    views: [{ id: "multi", label: "Measures", kind: "scatter", x: "price", y: ["stock", "price"] }],
  };
  const chart = cloudAiExplorerState(multi, { step: "1" }, "en").charts.multi!;
  expect(chart.marks).toEqual([
    [2, 3],
    [2, 3, 5],
  ]);
  expect(chart.legend.map((entry) => entry.label)).toEqual(["stock", "price"]);
});
