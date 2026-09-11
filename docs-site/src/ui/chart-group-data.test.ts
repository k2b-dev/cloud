import { expect, test } from "bun:test";
import { initialGroupRequest, linkedChartSnapshot, parseGroupRequest } from "./chart-group-data";
import { comparisonValues } from "./chart-group-demo-model";

test("comparison keeps every chart aligned and renders reference marks on the server", () => {
  const result = linkedChartSnapshot({ ...initialGroupRequest, step: "17", referenceStep: "08" });
  for (const chart of Object.values(result.charts)) {
    expect(chart.chart.marks).toHaveLength(16);
    expect(chart.chart.marks.filter((m) => m.reference)).toHaveLength(8);
    expect(chart.chart.svg.match(/data-chart-reference="true"/g)).toHaveLength(8);
    expect(chart.chart.svg).toContain("Current 17:00");
    expect(chart.chart.svg).toContain("Reference 08:00");
    expect(chart.rows).toHaveLength(8);
    expect(new Set(chart.chart.marks.map((mark) => mark.rowKey)).size).toBe(8);
  }
  expect(result.charts.latency!.chart.marks.map((m) => m.key)).toEqual(result.charts.requests!.chart.marks.map((m) => m.key));
});
test("shared filters can hide every series and missing/zero references do not invent values", () => {
  const empty = linkedChartSnapshot({ ...initialGroupRequest, visibleKeys: [], referenceStep: "08" });
  expect(Object.values(empty.charts).map((c) => c.rows.length)).toEqual([0, 0]);
  const missing = linkedChartSnapshot({ ...initialGroupRequest, step: "17", referenceStep: "11" });
  const row = missing.charts.latency!.rows.find((r) => r.key === "uncached:25")!;
  expect(row.reference).toBeNull();
  expect(missing.charts.latency!.chart.svg).toContain("No reference value");
  expect(comparisonValues(35, 0)).toEqual({ delta: 35, percent: null });
  expect(comparisonValues(null, 5)).toEqual({ delta: null, percent: null });
  expect(comparisonValues(15, 10)).toEqual({ delta: 5, percent: 50 });
});
test("demo request parser only accepts the bounded series and time domain", () => {
  expect(parseGroupRequest(new URL("http://local/?step=17&reference=08&series=cached"))).toEqual({
    step: "17",
    referenceStep: "08",
    visibleKeys: ["cached"],
  });
  for (const query of ["step=99", "step=08&reference=99", "step=08&series=unknown", "step=08&series=cached&series=cached"]) {
    expect(parseGroupRequest(new URL(`http://local/?${query}`))).toBeNull();
  }
});

test("zero request observations render an explicit value label and remain a single selectable row", () => {
  const data = linkedChartSnapshot({ ...initialGroupRequest, referenceStep: "08" }).charts.requests;
  expect(data.rows.find((row) => row.key === "cached:10")?.current).toBe(0);
  expect(data.chart.marks.filter((mark) => mark.rowKey === "cached:10")).toHaveLength(2);
  expect(data.chart.svg.match(/<text class="stdlib-chart-bar-value"[^>]*>0<\/text>/g)).toHaveLength(2);
});
