import { expect, test } from "bun:test";
import { chartKinds, drawChart } from "@k2b/editor/charts";
import { sqlCatalogData, sqlCatalogFixtures, sqlCatalogPanel } from "./dashboard-catalog.test-fixture";
import { DASHBOARD_MAX_MARKS, DashboardPanelSchema } from "./dashboard-contracts";
import { dashboardChartDescription, dashboardChartRenderOptions, dashboardProducedMarks } from "./dashboard-description";
import { projectDashboardPanel } from "./dashboard-result";

const clock = { locale: "en", timeZone: "Europe/Berlin" };
const sqlResult = (data: { columns: { name: string; type: string }[]; rows: unknown[][] }) => ({
  ...data,
  truncated: false,
  rowCount: data.rows.length,
  stats: { elapsedMs: 1, readRows: data.rows.length, readBytes: 1 },
});
for (const fixture of sqlCatalogFixtures) {
  test(`${fixture.kind}: SQL projection becomes a valid portable description and drawing`, () => {
    const panel = sqlCatalogPanel(fixture),
      data = sqlCatalogData(fixture);
    expect(projectDashboardPanel(panel, sqlResult(data))).toEqual(data);
    const description = dashboardChartDescription(panel, data, clock);
    expect(chartKinds().safeParse(description).success).toBe(true);
    expect(JSON.parse(JSON.stringify(description))).toEqual(description);
    const svg = drawChart(dashboardChartRenderOptions(panel, data, clock));
    expect(svg).toContain("<svg");
    expect(svg).toContain("data-chart-datum=");
    expect([...svg.matchAll(/data-chart-datum=/g)].length).toBeLessThanOrEqual(DASHBOARD_MAX_MARKS);
  });
}

const fixtureFor = (kind: (typeof sqlCatalogFixtures)[number]["kind"]) => sqlCatalogFixtures.find((fixture) => fixture.kind === kind)!;
const projectRows = (kind: (typeof sqlCatalogFixtures)[number]["kind"], rows: unknown[][]) => {
  const fixture = fixtureFor(kind);
  return projectDashboardPanel(sqlCatalogPanel(fixture), sqlResult({ ...sqlCatalogData(fixture), rows }));
};
test("aligned bars retain category order, series identities and explicit or absent null gaps", () => {
  const panel = DashboardPanelSchema.parse({
    id: "aligned",
    title: "Aligned",
    kind: "bar",
    columns: ["category", "group", "value"],
    x: "category",
    series: "group",
    sql: "SELECT 1",
  });
  const data = {
    columns: panel.columns.map((name) => ({ name, type: "String" })),
    rows: [
      ["B", "North", 5],
      ["A", "South", 8],
      ["A", "North", null],
    ],
  };
  expect(dashboardChartDescription(panel, data, clock)).toEqual({
    kind: "bar",
    title: "Aligned",
    layout: "grouped",
    x: ["B", "A"],
    series: [
      { label: "North", data: [5, null] },
      { label: "South", data: [null, 8] },
    ],
  });
  expect(() => projectDashboardPanel(panel, sqlResult({ ...data, rows: [...data.rows, ["B", "North", 4]] }))).toThrow("duplicate");
});
test("new SQL entry fields are strict and invalid result semantics fail visibly", () => {
  for (const fixture of sqlCatalogFixtures) {
    const panel = sqlCatalogPanel(fixture);
    expect(DashboardPanelSchema.safeParse({ ...panel, callback: "ignored?" }).success).toBe(false);
    if (!["sankey"].includes(fixture.kind)) expect(DashboardPanelSchema.safeParse({ ...panel, x: undefined }).success).toBe(false);
    if (panel.x) expect(DashboardPanelSchema.safeParse({ ...panel, series: panel.x }).success).toBe(false);
  }
  for (const kind of ["barStacked", "barPercent", "hbar", "barList", "funnelStages"] as const)
    expect(() => projectRows(kind, kind === "barList" || kind === "funnelStages" ? [["A", -1]] : [["A", -1, 4]])).toThrow();
  expect(() =>
    projectRows("waterfall", [
      ["Start", 10],
      ["End", 10],
    ]),
  ).toThrow("null total");
  expect(() => projectRows("calendarHeatmap", [["2026-02-30", 1]])).toThrow();
  expect(() =>
    projectRows("calendarHeatmap", [
      ["2026-10-01", 1],
      ["2026-10-01", 2],
    ]),
  ).toThrow("unique");
  expect(() =>
    projectRows("sankey", [
      ["A", "B", 1],
      ["B", "A", 1],
    ]),
  ).toThrow();
  expect(() => projectRows("sankey", [["A", "B", null]])).toThrow("positive");
  expect(() => projectRows("treemap", [["A", "Group", -1]])).toThrow();
  expect(() => projectRows("pareto", [["A", 1, null]])).toThrow();
  expect(() => projectRows("bubble", [["A", "Group", 1, 2, -1]])).toThrow();
  expect(() =>
    projectRows("radar", [
      ["A", 10, 1, null],
      ["B", 10, 2, 2],
      ["C", 10, 2, 2],
    ]),
  ).toThrow("every axis");
  expect(() =>
    projectRows("radar", [
      ["A", 10, 11, 1],
      ["B", 10, 2, 2],
      ["C", 10, 2, 2],
    ]),
  ).toThrow();
});
test("forecast SQL retains null gaps and rejects ambiguous flags and invalid bounds", () => {
  const fixture = fixtureFor("lineForecast"),
    panel = sqlCatalogPanel(fixture);
  const description = dashboardChartDescription(panel, sqlCatalogData(fixture), clock);
  expect(description).toMatchObject({
    kind: "line",
    xAxis: { format: { date: "minute" } },
    series: [{ data: [{ y: 12 }, { y: null }, { y: 14 }, { y: 15 }] }],
    forecast: {
      from: Date.parse("2026-10-01T12:00:00Z"),
      band: [
        [12, 16],
        [13, 18],
      ],
    },
  });
  const options = dashboardChartRenderOptions(panel, sqlCatalogData(fixture), clock);
  if (options.kind !== "line") throw new Error("Expected forecast line");
  expect(options.xAxis?.format).toBeUndefined();
  expect(options.timeAxis).toEqual(clock);
  expect(drawChart(options)).toContain(">14:00</text>");
  expect(() =>
    projectRows("lineForecast", [
      ["2026-10-01T10:00:00Z", 12, 1, 10, 14],
      ["2026-10-01T11:00:00Z", 12, 0, null, null],
    ]),
  ).toThrow("suffix");
  expect(() => projectRows("lineForecast", [["2026-10-01T10:00:00Z", 12, 1, 14, 10]])).toThrow();
  expect(DashboardPanelSchema.safeParse({ ...panel, columns: panel.columns.filter((name) => name !== "high") }).success).toBe(false);
});
test("produced dots include the remainder; comparisons, series, points and missing inputs keep host budgets", () => {
  for (const [kind, expected] of [
    ["barGrouped", 3],
    ["barCompare", 3],
    ["hbar", 3],
    ["dots", 100],
    ["pareto", 6],
    ["radar", 6],
    ["sankey", 5],
  ] as const) {
    const fixture = fixtureFor(kind),
      panel = sqlCatalogPanel(fixture),
      data = sqlCatalogData(fixture);
    const input = chartKinds().parse(dashboardChartDescription(panel, data, clock));
    expect(dashboardProducedMarks(input, drawChart(dashboardChartRenderOptions(panel, data, clock)))).toBe(expected);
  }
  expect(() =>
    projectRows(
      "dots",
      Array.from({ length: 38 }, (_, index) => [`C${index}`, 100, 70, 20]),
    ),
  ).not.toThrow();
  expect(() =>
    projectRows(
      "dots",
      Array.from({ length: 39 }, (_, index) => [`C${index}`, 100, 70, 20]),
    ),
  ).toThrow("3,840");
  expect(() =>
    projectRows(
      "dots",
      Array.from({ length: 480 }, (_, index) => [`C${index}`, 100, index === 0 ? 70 : null, index === 0 ? 20 : null]),
    ),
  ).not.toThrow();
  expect(() =>
    projectRows(
      "barCompare",
      Array.from({ length: 481 }, (_, index) => [`C${index}`, 1, null]),
    ),
  ).toThrow("480 points");
  expect(() =>
    projectRows(
      "sankey",
      Array.from({ length: 481 }, (_, index) => ["Start", `N${index}`, 1]),
    ),
  ).toThrow("480 points");
  expect(() =>
    projectRows(
      "treemap",
      Array.from({ length: 9 }, (_, index) => ["A", `G${index}`, 1]),
    ),
  ).toThrow("8 series");
  expect(() =>
    projectRows(
      "bubble",
      Array.from({ length: 481 }, () => ["A", "Group", null, 1, 1]),
    ),
  ).toThrow("480 points");
  expect(() => projectRows("dots", [["A", 100, 20, 40]])).toThrow("subset");
});
