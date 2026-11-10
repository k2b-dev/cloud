import type { DashboardPanel } from "./dashboard-contracts";

/** Saved SQL shapes that predate the additive catalog mappings. */
export const savedChartFixtures: {
  id?: string;
  kind: DashboardPanel["kind"];
  columns: string[];
  x?: string;
  series?: string;
  rows: unknown[][];
}[] = [
  {
    kind: "line",
    columns: ["time", "value"],
    x: "time",
    rows: [
      ["2026-10-01T10:00:00Z", 12],
      ["2026-10-01T11:00:00Z", null],
      ["2026-10-01T12:00:00Z", 8],
    ],
  },
  ...(["bar", "funnel", "pie", "donut", "barGauge"] as const).map((kind) => ({
    kind,
    columns: ["category", "value"],
    x: "category",
    rows: [
      ["A", 12],
      ["A", 8],
      ["B", 4],
    ],
  })),
  {
    id: "bar-series",
    kind: "bar",
    columns: ["category", "host", "value"],
    x: "category",
    series: "host",
    rows: [
      ["Visit", "first", 12],
      ["Visit", "second", null],
      ["Contact", "first", 8],
    ],
  },
  {
    id: "bar-values",
    kind: "bar",
    columns: ["category", "first", "second"],
    x: "category",
    rows: [
      ["Visit", 12, null],
      ["Contact", 8, 4],
    ],
  },
  {
    id: "bar-duplicate-pairs",
    kind: "bar",
    columns: ["category", "host", "value"],
    x: "category",
    series: "host",
    rows: [
      ["Visit", "first", 12],
      ["Visit", "first", 8],
      ["Visit", "second", 4],
    ],
  },
  ...(["histogram", "sparkline"] as const).map((kind) => ({ kind, columns: ["value"], rows: [[1], [null], [2], [4]] })),
  { kind: "gauge", columns: ["value"], rows: [[42]] },
  {
    kind: "boxplot",
    columns: ["category", "value"],
    x: "category",
    rows: [
      ["A", 1],
      ["A", 2],
      ["A", 5],
      ["B", 4],
      ["B", 8],
    ],
  },
  {
    kind: "scatter",
    columns: ["x", "value"],
    x: "x",
    rows: [
      [1, 2],
      [2, null],
      [3, 4],
    ],
  },
  {
    kind: "heatmap",
    columns: ["x", "row", "value"],
    x: "x",
    series: "row",
    rows: [
      ["A", "North", 1],
      ["B", "North", null],
      ["A", "South", 3],
    ],
  },
  ...(["area", "areaPercent"] as const).map((kind) => ({
    kind,
    columns: ["category", "first", "second"],
    x: "category",
    rows: [
      ["A", 12, 8],
      ["B", null, 4],
      ["C", 3, 2],
    ],
  })),
];
