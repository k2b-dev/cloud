import { expect, test } from "bun:test";
import { chartSnapshot, explorerChart } from "./analytics-chart";
import { ExplorerData } from "./runtime/analytics-contracts";
import { ChartOptions } from "./runtime/chart-schema";

const examples = [
  { kind: "bar", data: [{ label: "A", value: 2 }] },
  { kind: "pie", data: [{ label: "A", value: 2 }] },
  { kind: "donut", data: [{ label: "A", value: 2 }] },
  { kind: "line", series: [{ data: [{ x: 1, y: 2 }] }] },
  { kind: "scatter", series: [{ data: [{ x: 1, y: 2 }] }] },
  { kind: "sparkline", data: [1, 2] },
  { kind: "histogram", data: [1, 2, 3], bins: [0, 2, 4] },
  { kind: "boxplot", groups: [{ label: "A", values: [1, 2, 3, 4, 5] }] },
  { kind: "gauge", value: 4 },
  { kind: "barGauge", data: [{ label: "A", value: 4 }] },
  { kind: "stat", label: "Count", value: 4 },
  { kind: "heatmap", data: [{ x: "A", y: "B", value: 4 }] },
  { kind: "map", series: [{ data: [{ latitude: 48, longitude: 10 }] }] },
  { kind: "stateTimeline", rows: [{ label: "A", intervals: [{ from: 1, to: 3, state: "on" }] }] },
];
test("host prepares all fourteen kinds without accepting worker SVG", () => {
  for (const input of examples) {
    const chart = chartSnapshot({ options: ChartOptions.parse(input) }, "en-US");
    expect(chart.svg).toContain("<svg");
    expect(chart.marks.length).toBeGreaterThan(0);
  }
});
test("derived bins map to summary rows with stable selections", () => {
  const options = ChartOptions.parse({ kind: "histogram", data: [1, 2, 3], bins: [0, 2, 4] });
  const plain = chartSnapshot({ options }, "en-US");
  const marks = plain.marks.map((mark, index) => ({
    role: mark.datum.role,
    index: mark.datum.index,
    key: `bin:${index}`,
    rowKey: `bin:${index}`,
  }));
  const data = ExplorerData.parse({
    rowKey: "id",
    rows: [
      { id: "bin:0", count: 1 },
      { id: "bin:1", count: 2 },
    ],
    chart: { options, marks },
  });
  expect(explorerChart(data, [], "en-US").chart.marks.map((mark) => mark.rowKey)).toEqual(["bin:0", "bin:1"]);
  expect(() => chartSnapshot({ options, marks: marks.slice(0, 1) }, "en-US")).toThrow("mapping");
});
test("declarative mapping shares exact values and rejects silent missing numeric data", () => {
  const data = ExplorerData.parse({
    rowKey: "id",
    rows: [{ id: "a", name: "A", amount: 10 }],
    chart: { kind: "bar", category: "name", value: "amount" },
  });
  const chart = explorerChart(
    data,
    [{ key: "amount", label: "Revenue", sortable: true, format: { type: "currency", currency: "EUR" } }],
    "en-US",
  );
  expect(chart.chart.marks[0]?.tooltip.rows).toEqual([{ label: "Revenue", value: "€10.00" }]);
  expect(() => explorerChart({ ...data, rows: [{ id: "a", amount: null }] }, [], "en-US")).toThrow();
});

test("monthly line labels render in source order and invalid mappings fail before a browser mounts", () => {
  const input = {
    rowKey: "id",
    rows: [
      { id: "jan", month: "January", amount: 10 },
      { id: "feb", month: "February", amount: 20 },
    ],
    chart: { kind: "line", x: "month", y: "amount" },
  };
  const data = ExplorerData.parse(input);
  const result = explorerChart(data, [{ key: "month", label: "Month", sortable: false }], "en-US");
  expect(result.chart.svg).toContain("January");
  expect(result.chart.svg).toContain("February");
  expect(result.chart.marks.map((mark) => mark.rowKey)).toEqual(["jan", "feb"]);
  expect(() => ExplorerData.parse({ ...input, chart: { ...input.chart, kind: "scatter" } })).toThrow("finite numbers");
  expect(() => ExplorerData.parse({ ...input, rows: [{ id: "bad", month: "January", amount: null }] })).toThrow("finite numbers");
  expect(() => ExplorerData.parse({ ...input, rows: [...input.rows, { id: "mixed", month: 3, amount: 30 }] })).toThrow("without mixing");
});
