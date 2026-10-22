import { expect, test } from "bun:test";
import { dashboardRangeSearch } from "./dashboard-client";
import { dashboardCategories, dashboardLine, dashboardSections, readDashboardRange } from "./dashboard-data";
import { dashboardTestDashboard, dashboardTestKinds, dashboardTestPanelResult } from "./dashboard-test-fixtures";

test("custom ranges require both valid ordered endpoints and serialize without changing instants", () => {
  expect(readDashboardRange("/?range=7d&from=wrong&to=2026-10-22")).toEqual({ range: "7d" });
  expect(readDashboardRange("/?range=30d&from=2026-10-22&to=2026-10-01")).toEqual({ range: "30d" });
  const range = { range: "90d" as const, from: "2026-10-01T08:00:00.000Z", to: "2026-10-05T09:00:00.000Z" };
  expect(readDashboardRange(`/?${dashboardRangeSearch(range)}`)).toEqual(range);
});
test("section order and explicit half/third widths survive without folding stat tiles into charts", () => {
  const groups = dashboardSections(dashboardTestDashboard.definition.panels);
  expect(groups.map((group) => [group.name, group.panels.length])).toEqual([
    ["Traefik", 3],
    ["Server", 3],
  ]);
  expect(groups.flatMap((group) => group.panels).every((panel) => panel.width === "third")).toBe(true);
});
test("section presentation comes only from stored metadata and stays absent when unspecified", () => {
  const groups = dashboardSections(dashboardTestDashboard.definition.panels);
  expect(groups.map(({ name, icon, color, description }) => ({ name, icon, color, description }))).toEqual([
    { name: "Traefik", icon: "ti ti-router", color: "#14b8a6", description: "Quelle Traefik · Raster 5 Min." },
    { name: "Server", icon: "ti ti-server-2", color: "#8b5cf6", description: "2 Quellen · Raster 5 Min." },
  ]);
  expect(
    dashboardSections(dashboardTestKinds.definition.panels).every(
      (group) => group.icon === undefined && group.color === undefined && group.description === undefined,
    ),
  ).toBe(true);
});
test("line adaptation retains missing observations, uses named time and series columns, and never clips valid results", () => {
  const panel = { ...dashboardTestDashboard.definition.panels[4]!, series: "host", columns: ["host", "time", "value"] };
  const chart = dashboardLine(
    panel,
    {
      columns: [
        { name: "host", type: "String" },
        { name: "time", type: "DateTime('UTC')" },
        { name: "value", type: "Float64" },
      ],
      rows: [
        ["demo-web", "2026-10-20T10:00:00Z", 10],
        ["demo-web", "2026-10-20T11:00:00Z", null],
        ["demo-web", "2026-10-20T12:00:00Z", 12],
        ["demo-db", "2026-10-20T10:00:00Z", "8"],
        ["demo-db", "2026-10-20T11:00:00Z", 9],
      ],
    },
    "de",
  );
  expect(chart.series.map((series) => [series.label, series.data.length])).toEqual([
    ["demo-web", 2],
    ["demo-db", 2],
  ]);
  expect(chart.maxGap).toBe(5400000);
  expect(chart.series[0]!.data[0]!.y).toBe(10);
});
test("funnel and bar values use named columns with complete source order", () => {
  const panel = dashboardTestKinds.definition.panels[2]!;
  const result = dashboardTestPanelResult(panel);
  expect(dashboardCategories(panel, result.lastGood!.data, "de")).toEqual([
    { label: "Besuch", value: 1200 },
    { label: "Kontaktseite", value: 310 },
    { label: "Anfrage", value: 28 },
  ]);
});

test("bar preserves every numeric output while funnel rejects ambiguous or invalid stages", () => {
  const panel = { ...dashboardTestKinds.definition.panels[2]!, kind: "bar" as const, x: "stage" };
  const data = {
    columns: [
      { name: "stage", type: "String" },
      { name: "first", type: "Float64" },
      { name: "second", type: "Float64" },
    ],
    rows: [["Visit", 10, 8]],
  };
  expect(dashboardCategories(panel, data, "en")).toEqual([
    { label: "Visit · first", value: 10 },
    { label: "Visit · second", value: 8 },
  ]);
  expect(() => dashboardCategories({ ...panel, kind: "funnel" }, data, "en")).toThrow("PANEL_RESULT_INVALID");
  expect(() => dashboardCategories(panel, { ...data, rows: [["Visit", "invalid", 8]] }, "en")).toThrow("PANEL_RESULT_INVALID");
  expect(() =>
    dashboardCategories({ ...panel, kind: "funnel" }, { columns: data.columns.slice(0, 2), rows: [["Visit", -1]] }, "en"),
  ).toThrow("PANEL_RESULT_INVALID");
});

test("alarm references retain their threshold and localized numeric caption", () => {
  const panel = { ...dashboardTestDashboard.definition.panels[4]!, threshold: 2.5, unit: "%" };
  const result = dashboardTestPanelResult(panel);
  expect(dashboardLine(panel, result.lastGood!.data, "de").references).toEqual([{ value: 2.5, label: "Alarm 2,5 %" }]);
  expect(dashboardLine({ ...panel, threshold: undefined }, result.lastGood!.data, "en").references).toEqual([]);
});
