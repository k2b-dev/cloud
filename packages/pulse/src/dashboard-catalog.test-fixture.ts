import { type DashboardPanel, DashboardPanelSchema } from "./dashboard-contracts";
import type { DashboardPanelData } from "./dashboard-result";

/** Invented SQL outputs shared by the adapter and dashboard browser guards. */
export const sqlCatalogFixtures = [
  {
    kind: "barGrouped",
    columns: ["category", "first", "second"],
    x: "category",
    rows: [
      ["A", 12, 8],
      ["B", null, 4],
    ],
  },
  {
    kind: "barStacked",
    columns: ["category", "first", "second"],
    x: "category",
    rows: [
      ["A", 12, 8],
      ["B", 3, 4],
    ],
  },
  {
    kind: "barPercent",
    columns: ["category", "first", "second"],
    x: "category",
    rows: [
      ["A", 12, 8],
      ["B", 3, 4],
    ],
  },
  {
    kind: "barCompare",
    columns: ["category", "current", "previous"],
    x: "category",
    rows: [
      ["A", 12, 8],
      ["B", null, 4],
    ],
  },
  {
    kind: "barRows",
    columns: ["category", "value"],
    x: "category",
    rows: [
      ["Incoming", 12],
      ["Outgoing", -8],
      ["Missing", null],
    ],
  },
  {
    kind: "barList",
    columns: ["category", "value"],
    x: "category",
    rows: [
      ["Search", 12],
      ["Direct", 8],
    ],
  },
  {
    kind: "hbar",
    columns: ["category", "first", "second"],
    x: "category",
    rows: [
      ["A", 12, 8],
      ["B", null, 4],
    ],
  },
  {
    kind: "dots",
    columns: ["category", "total", "visits", "contacts"],
    x: "category",
    rows: [
      ["A", 100, 70, 20],
      ["B", 100, 40, null],
    ],
  },
  {
    kind: "funnelStages",
    columns: ["category", "value"],
    x: "category",
    rows: [
      ["Visited", 120],
      ["Contacted", 30],
      ["Ordered", 8],
    ],
  },
  {
    kind: "waterfall",
    columns: ["category", "value"],
    x: "category",
    rows: [
      ["Start", 100],
      ["Incoming", 30],
      ["Outgoing", -10],
      ["End", null],
    ],
  },
  {
    kind: "calendarHeatmap",
    columns: ["day", "value"],
    x: "day",
    rows: [
      ["2026-10-01", 12],
      ["2026-10-02", null],
      ["2026-10-03", 8],
    ],
  },
  {
    kind: "sankey",
    columns: ["source", "target", "value"],
    rows: [
      ["Orders", "Shipping", 30],
      ["Orders", "Pickup", 20],
    ],
  },
  {
    kind: "treemap",
    columns: ["category", "group", "value"],
    x: "category",
    series: "group",
    rows: [
      ["Books", "Shop", 12],
      ["Maps", "Shop", null],
      ["Prints", "Market", 8],
    ],
  },
  {
    kind: "pareto",
    columns: ["category", "booked", "planned"],
    x: "category",
    rows: [
      ["Books", 12, 10],
      ["Prints", 8, 9],
    ],
  },
  {
    kind: "bubble",
    columns: ["label", "group", "x", "y", "size"],
    x: "x",
    series: "group",
    rows: [
      ["Books", "Shop", 12, 8, 4],
      ["Maps", "Shop", null, 8, 4],
      ["Prints", "Market", 8, 10, 3],
    ],
  },
  {
    kind: "radar",
    columns: ["axis", "max", "first", "second"],
    x: "axis",
    rows: [
      ["Speed", 10, 8, 6],
      ["Cost", 10, 6, 8],
      ["Quality", 10, 9, 8],
    ],
  },
  {
    kind: "lineForecast",
    columns: ["time", "value", "forecast", "low", "high"],
    x: "time",
    rows: [
      ["2026-10-01T10:00:00Z", 12, 0, null, null],
      ["2026-10-01T11:00:00Z", null, 0, null, null],
      ["2026-10-01T12:00:00Z", 14, 1, 12, 16],
      ["2026-10-01T13:00:00Z", 15, 1, 13, 18],
    ],
  },
] satisfies { kind: DashboardPanel["kind"]; columns: string[]; x?: string; series?: string; rows: unknown[][] }[];

export const sqlCatalogPanel = (fixture: (typeof sqlCatalogFixtures)[number]): DashboardPanel =>
  DashboardPanelSchema.parse({
    id: fixture.kind,
    title: fixture.kind === "pareto" ? "Orders by category" : fixture.kind,
    sql: "SELECT 1",
    kind: fixture.kind,
    columns: fixture.columns,
    x: "x" in fixture ? fixture.x : undefined,
    series: "series" in fixture ? fixture.series : undefined,
    width: fixture.kind === "pareto" ? "twoThirds" : "third",
  });
export const sqlCatalogData = (fixture: (typeof sqlCatalogFixtures)[number]): DashboardPanelData => ({
  columns: fixture.columns.map((name) => ({
    name,
    type:
      name === "time"
        ? "DateTime('UTC')"
        : name === "day"
          ? "Date"
          : ["category", "group", "label", "axis", "source", "target"].includes(name)
            ? "String"
            : "Float64",
  })),
  rows: fixture.rows,
});
