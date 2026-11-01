import { expect, test } from "bun:test";
import { DashboardDefinitionSchema, DashboardPanelSchema, dashboardWindow } from "./dashboard-contracts";
import { projectDashboardPanel } from "./dashboard-result";
import type { SqlRows } from "./store/sql-run";

const rows = (columns: SqlRows["columns"], data: unknown[][], truncated = false): SqlRows => ({
  columns,
  rows: data,
  truncated,
  rowCount: data.length,
  stats: { elapsedMs: 1, readRows: data.length, readBytes: 1 },
});
test("dashboard projection exposes only selected columns and rejects ambiguous, truncated and excessive results", () => {
  const panel = DashboardPanelSchema.parse({
    id: "count",
    title: "Visits",
    kind: "number",
    sql: "SELECT 42 AS visits",
    columns: ["visits"],
  });
  const columns = [
    { name: "visits", type: "UInt64" },
    { name: "private", type: "String" },
  ];
  expect(projectDashboardPanel(panel, rows(columns, [[42, "hidden"]]))).toEqual({ columns: [columns[0]!], rows: [[42]] });
  expect(() => projectDashboardPanel(panel, rows(columns, [[42, "hidden"]], true))).toThrow("truncated");
  expect(() => projectDashboardPanel(panel, rows([columns[0]!, columns[0]!], [[42, 43]]))).toThrow("Expected one");
  expect(() => projectDashboardPanel(panel, rows(columns, [[42], [43]]))).toThrow("one aggregate");
  expect(() => projectDashboardPanel(panel, rows(columns, [["n/a"]]))).toThrow("finite numbers");
});
test("charts refuse more than eight series or 480 points without clipping", () => {
  const panel = DashboardPanelSchema.parse({
    id: "rate",
    title: "Traffic",
    kind: "line",
    sql: "SELECT 1",
    columns: ["at", "host", "value"],
    x: "at",
    series: "host",
  });
  const columns = [
    { name: "at", type: "DateTime64(3, 'UTC')" },
    { name: "host", type: "String" },
    { name: "value", type: "Float64" },
  ];
  expect(() =>
    projectDashboardPanel(
      panel,
      rows(
        columns,
        Array.from({ length: 9 }, (_, i) => ["2026-10-22 12:00:00.000", String(i), 1]),
      ),
    ),
  ).toThrow("8 series");
  expect(() =>
    projectDashboardPanel(
      panel,
      rows(
        columns,
        Array.from({ length: 481 }, () => ["2026-10-22 12:00:00.000", "host", 1]),
      ),
    ),
  ).toThrow("480 points");
  expect(projectDashboardPanel(panel, rows(columns, [["2026-10-22 12:00:00.000", "host", null]])).rows).toHaveLength(1);
  expect(() => projectDashboardPanel(panel, rows(columns, [["invalid", "host", 1]]))).toThrow("invalid value");
});
test("dashboard windows use a deterministic shared grid and retain sub-minute custom windows", () => {
  const now = new Date("2026-10-22T12:00:45Z");
  expect(dashboardWindow({ range: "24h" }, now)).toEqual({
    from: "2026-10-21T12:00:00.000Z",
    to: "2026-10-22T12:00:00.000Z",
    bucket: "3m",
  });
  const window = dashboardWindow({ from: "2026-10-22T12:00:10Z", to: "2026-10-22T12:00:20Z" }, now);
  expect(Date.parse(window.to)).toBeGreaterThan(Date.parse(window.from));
  expect(() => dashboardWindow({ from: "2026-10-22T12:00:20Z", to: "2026-10-22T12:00:10Z" }, now)).toThrow("end must be after");
});

test("number panels retain a typed trend and presentation without silently dropping invalid points", () => {
  const panel = DashboardPanelSchema.parse({
    id: "visits",
    title: "Visits",
    kind: "number",
    sql: "SELECT 1",
    x: "at",
    columns: ["at", "value", "unit", "detail", "detailTone"],
  });
  const columns = [
    { name: "at", type: "DateTime64(3, 'UTC')" },
    { name: "value", type: "UInt64" },
    ...["unit", "detail", "detailTone"].map((name) => ({ name, type: "String" })),
  ];
  const data = [
    ["2026-10-22 12:00:00.000", 42, "visits", "+12%", "success"],
    ["2026-10-22 13:00:00.000", 50, "visits", "+20%", "success"],
  ];
  expect(projectDashboardPanel(panel, rows(columns, data)).rows).toEqual(data);
  for (const invalid of [null, "", "9007199254740993"])
    expect(() => projectDashboardPanel(panel, rows(columns, [[data[0]![0], invalid, "", "", ""]]))).toThrow();
  expect(() => projectDashboardPanel(panel, rows(columns, [["invalid", 1, "", "", ""]]))).toThrow();
  expect(() =>
    projectDashboardPanel(
      panel,
      rows(
        columns,
        Array.from({ length: 481 }, () => data[0]!),
      ),
    ),
  ).toThrow("480 rows");
  expect(() => DashboardPanelSchema.parse({ ...panel, columns: ["at", "value", "other"] })).toThrow("exactly one");
});

test("grouped bars apply the point budget per series", () => {
  const panel = DashboardPanelSchema.parse({
    id: "bars",
    title: "Paths",
    kind: "bar",
    sql: "SELECT 1",
    x: "path",
    series: "host",
    columns: ["path", "host", "count"],
  });
  const columns = [
    { name: "path", type: "String" },
    { name: "host", type: "String" },
    { name: "count", type: "UInt64" },
  ];
  const data = ["a", "b"].flatMap((host) => Array.from({ length: 300 }, (_, i) => [`/${i}`, host, i]));
  expect(projectDashboardPanel(panel, rows(columns, data)).rows).toHaveLength(600);
  expect(() =>
    projectDashboardPanel(
      panel,
      rows(
        columns,
        Array.from({ length: 481 }, (_, i) => [`/${i}`, "a", i]),
      ),
    ),
  ).toThrow("480 points");
});

test("section presentation is explicit and consistent across its panels", () => {
  const panel = {
    id: "requests",
    title: "Requests",
    section: "Traffic",
    sectionIcon: "ti ti-router",
    sectionColor: "#14b8a6",
    sectionDescription: "Website backend",
    kind: "table",
    sql: "SELECT 1 AS requests",
    columns: ["requests"],
  };
  expect(DashboardDefinitionSchema.safeParse({ panels: [panel, { ...panel, id: "requests2" }] }).success).toBe(true);
  expect(
    DashboardDefinitionSchema.safeParse({ panels: [panel, { ...panel, id: "requests2", sectionDescription: "Different source" }] }).success,
  ).toBe(false);
  expect(DashboardPanelSchema.safeParse({ ...panel, sectionColor: "url(https://invalid.example)" }).success).toBe(false);
});
