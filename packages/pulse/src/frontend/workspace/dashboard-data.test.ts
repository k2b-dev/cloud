import { expect, test } from "bun:test";
import { charts } from "@k2b/ui/charts/core";
import { DashboardDefinitionSchema, DashboardSaveSchema } from "../../dashboard-contracts";
import { dashboardRangeSearch } from "./dashboard-client";
import {
  dashboardCategories,
  dashboardLine,
  dashboardLineExplorer,
  dashboardSections,
  dashboardTopNumbers,
  readDashboardRange,
} from "./dashboard-data";
import { dashboardTestDashboard, dashboardTestKinds, dashboardTestPanelResult } from "./dashboard-test-fixtures";

const berlin = { locale: "de", timeZone: "Europe/Berlin" };

test("custom ranges require both valid ordered endpoints and serialize without changing instants", () => {
  expect(readDashboardRange("/?range=7d&from=wrong&to=2026-10-22")).toEqual({ range: "7d" });
  expect(readDashboardRange("/?range=30d&from=2026-10-22&to=2026-10-01")).toEqual({ range: "30d" });
  const range = { range: "90d" as const, from: "2026-10-01T08:00:00.000Z", to: "2026-10-05T09:00:00.000Z" };
  expect(readDashboardRange(`/?${dashboardRangeSearch(range)}`)).toEqual(range);
});
test("section order and explicit half/third widths survive without folding stat tiles into charts", () => {
  const groups = dashboardSections(dashboardTestDashboard.definition.panels);
  expect(groups.map((group) => [group.name, group.numbers.length, group.panels.length])).toEqual([
    ["Traefik", 0, 3],
    ["Server", 0, 3],
  ]);
  expect(dashboardTopNumbers(dashboardTestDashboard.definition.panels).map((panel) => panel.id)).toEqual([
    "requests-now",
    "errors-now",
    "latency-now",
    "hosts-now",
  ]);
  expect(groups.flatMap((group) => group.panels).every((panel) => panel.width === "third")).toBe(true);
});
test("a number with a section joins that section's key figures; one without stays in the top row", () => {
  const [requests, errors, latency, disk, ...charts] = dashboardTestDashboard.definition.panels;
  // Saved before key figures moved into sections: the numbers carry section fields that were never checked.
  // The display fixtures carry a parameter their SQL does not use; the stored contract rejects that, so drop it here.
  const definition = DashboardDefinitionSchema.parse({
    panels: [
      { ...requests!, section: "Traefik", sectionIcon: "ti ti-world", sectionColor: "#000000" },
      { ...errors!, section: "Traefik" },
      latency,
      { ...disk!, section: "Speicher", sectionIcon: "ti ti-database", sectionDescription: "nur Zahlen" },
      ...charts,
      { ...charts[0]!, id: "wide", width: "twoThirds" },
    ].map((panel) => ({ ...panel, params: {} })),
  });
  expect(dashboardTopNumbers(definition.panels).map((panel) => panel.id)).toEqual(["latency-now"]);
  const groups = dashboardSections(definition.panels);
  expect(
    groups.map((group) => ({
      name: group.name,
      numbers: group.numbers.map((panel) => panel.id),
      panels: group.panels.map((panel) => panel.id),
      icon: group.icon,
      description: group.description,
    })),
  ).toEqual([
    // The section reads its presentation from its first chart, not from the number that happens to come first.
    {
      name: "Traefik",
      numbers: ["requests-now", "errors-now"],
      panels: ["req", "e5", "p95", "wide"],
      icon: "ti ti-router",
      description: "Quelle Traefik · Raster 5 Min.",
    },
    // A section of numbers only takes its presentation from its first number.
    { name: "Speicher", numbers: ["hosts-now"], panels: [], icon: "ti ti-database", description: "nur Zahlen" },
    { name: "Server", numbers: [], panels: ["cpu", "disk", "hosts"], icon: "ti ti-server-2", description: "2 Quellen · Raster 5 Min." },
  ]);
  expect(definition.panels.at(-1)!.width).toBe("twoThirds");
});
test("the published website example stays valid and keeps its numbers on top", async () => {
  const example = DashboardSaveSchema.parse(await Bun.file(new URL("../../../examples/website-dashboard.json", import.meta.url)).json());
  expect(dashboardTopNumbers(example.definition.panels).map((panel) => panel.id)).toEqual(["views", "sessions", "contacts"]);
  expect(dashboardSections(example.definition.panels).map((group) => [group.name, group.numbers.length, group.panels.length])).toEqual([
    ["Traffic", 0, 4],
  ]);
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
    berlin,
  );
  expect(chart.series.map((series) => [series.label, series.data.length])).toEqual([
    ["demo-web", 2],
    ["demo-db", 2],
  ]);
  expect(chart.maxGap).toBe(5400000);
  expect(chart.series[0]!.data[0]!.y).toBe(10);
});
test("a day bucket that starts before the window widens the axis instead of failing the chart", () => {
  // toStartOfDay(ts, :base_tz) over the default 24 hours returns yesterday 00:00 Berlin, before :from.
  const panel = { ...dashboardTestDashboard.definition.panels[4]!, series: undefined, columns: ["tag", "besucher", "aufrufe"], x: "tag" };
  const window = { from: "2026-11-05T14:30:00.000Z", to: "2026-11-06T14:30:00.000Z" };
  const chart = dashboardLine(
    panel,
    {
      columns: [
        { name: "tag", type: "DateTime('Europe/Berlin')" },
        { name: "besucher", type: "UInt64" },
        { name: "aufrufe", type: "UInt64" },
      ],
      rows: [
        ["2026-11-05 00:00:00", "12", "40"],
        ["2026-11-06 00:00:00", "7", "19"],
      ],
    },
    berlin,
    window,
  );
  expect(chart.xAxis?.domain).toEqual([Date.parse("2026-11-04T23:00:00.000Z"), Date.parse(window.to)]);
  const { kind: _kind, maxGap: _maxGap, tooltip: _tooltip, ...options } = chart;
  expect(() => charts.line({ ...options, width: 480, height: 200 })).not.toThrow();
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
  expect(dashboardLine(panel, result.lastGood!.data, berlin).references).toEqual([{ value: 2.5, label: "Alarm 2,5 %" }]);
  expect(
    dashboardLine({ ...panel, threshold: undefined }, result.lastGood!.data, { locale: "en", timeZone: "Europe/Berlin" }).references,
  ).toEqual([]);
});

test("a line panel becomes explorer data: one row per drawn point, the series legend, and the widened window", () => {
  const panel = dashboardTestDashboard.definition.panels.find((item) => item.id === "req")!;
  const result = dashboardTestPanelResult(panel);
  const explorer = dashboardLineExplorer(panel, result.lastGood!.data, berlin, result.lastGood!);
  // ChartExplorer rejects marks without a row, so every drawn point needs exactly one.
  const keys = explorer.data.rows.map((row) => row.key);
  expect(new Set(keys).size).toBe(keys.length);
  expect(explorer.data.chart.marks.map((mark) => mark.rowKey).sort()).toEqual([...keys].sort());
  expect(explorer.legend.map((entry) => entry.label)).toEqual(["demo-site", "demo-shop", "demo-cloud"]);
  expect(explorer.data.chart.marks[0]!.tooltip.rows[0]!.value).toMatch(/\/s$/);
  const single = dashboardTestDashboard.definition.panels.find((item) => item.id === "e5")!;
  expect(dashboardLineExplorer(single, dashboardTestPanelResult(single).lastGood!.data, berlin).legend).toEqual([]);
  // The day bucket before :from from the #2714 case still renders and keeps every point.
  const bucket = { ...panel, series: undefined, columns: ["tag", "besucher"], x: "tag" };
  const day = dashboardLineExplorer(
    bucket,
    {
      columns: [
        { name: "tag", type: "DateTime('Europe/Berlin')" },
        { name: "besucher", type: "UInt64" },
      ],
      rows: [
        ["2026-11-05 00:00:00", "12"],
        ["2026-11-06 00:00:00", "7"],
      ],
    },
    berlin,
    { from: "2026-11-05T14:30:00.000Z", to: "2026-11-06T14:30:00.000Z" },
  );
  expect(day.data.rows.map((row) => row.value)).toEqual([12, 7]);
});
test("a line point keeps its row key when a refresh drops older points, and a repeated time stays unique", () => {
  const panel = { ...dashboardTestDashboard.definition.panels[4]!, series: "host", columns: ["time", "host", "value"] };
  const columns = [
    { name: "time", type: "DateTime('UTC')" },
    { name: "host", type: "String" },
    { name: "value", type: "Float64" },
  ];
  const keyAt = (rows: unknown[][], at: string) =>
    dashboardLineExplorer(panel, { columns, rows }, berlin).data.rows.find((row) => row.at === Date.parse(at) && row.series === "demo-web")
      ?.key;
  const earlier = [
    ["2026-10-20T10:00:00Z", "demo-web", 1],
    ["2026-10-20T11:00:00Z", "demo-web", 2],
  ];
  expect(keyAt(earlier, "2026-10-20T11:00:00Z")).toBe(keyAt(earlier.slice(1), "2026-10-20T11:00:00Z"));
  const repeated = dashboardLineExplorer(panel, { columns, rows: [...earlier, ["2026-10-20T11:00:00Z", "demo-web", 3]] }, berlin);
  const keys = repeated.data.rows.map((row) => row.key);
  expect(new Set(keys).size).toBe(3);
  expect(repeated.data.chart.marks.map((mark) => mark.rowKey).sort()).toEqual([...keys].sort());
});

test("day buckets across the end of daylight saving time read as midnight in the base zone and keep the widened axis", () => {
  // toStartOfDay(ts, :base_tz) in Europe/Berlin: 25 Oct 2026 starts at 22:00 UTC (CEST), 26 Oct at 23:00 UTC (CET).
  const panel = { ...dashboardTestDashboard.definition.panels[4]!, series: undefined, columns: ["tag", "besucher"], x: "tag", unit: "" };
  const window = { from: "2026-10-25T10:00:00.000Z", to: "2026-10-26T10:00:00.000Z" };
  const data = {
    columns: [
      { name: "tag", type: "DateTime('Europe/Berlin')" },
      { name: "besucher", type: "UInt64" },
    ],
    rows: [
      ["2026-10-25 00:00:00", "12"],
      ["2026-10-26 00:00:00", "7"],
    ],
  };
  const explorer = dashboardLineExplorer(panel, data, berlin, window);
  expect(explorer.data.rows.map((row) => new Date(row.at).toISOString())).toEqual(["2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z"]);
  expect(explorer.data.chart.marks.map((mark) => mark.tooltip.title)).toEqual(["25. Okt., 00:00", "26. Okt., 00:00"]);
  expect(dashboardLine(panel, data, berlin, window).xAxis?.domain).toEqual([Date.parse("2026-10-24T22:00:00.000Z"), Date.parse(window.to)]);
});
test("dashboard times never format in UTC: no fixed UTC zone or suffix in the dashboard sources", async () => {
  // Every dashboard time reads in the base zone (dashboardDateTime, DashboardClock). A UTC formatter or a " UTC"
  // suffix coming back would show a second clock beside the base's.
  const files = ["DashboardView.tsx", "DashboardPanelView.tsx", "dashboard-data.ts", "../PublicDashboard.island.tsx"];
  for (const file of files) {
    const source = await Bun.file(new URL(file, import.meta.url)).text();
    expect({ file, utc: source.match(/timeZone:\s*"UTC"|["'`] UTC["'`]|\+ " UTC"/g) }).toEqual({ file, utc: null });
  }
});
test("a date bucket from toDate(ts, :base_tz) starts at midnight in the base zone, east and west of UTC", () => {
  const panel = { ...dashboardTestDashboard.definition.panels[4]!, series: undefined, columns: ["tag", "besucher"], x: "tag", unit: "" };
  const data = {
    columns: [
      { name: "tag", type: "Date" },
      { name: "besucher", type: "UInt64" },
    ],
    rows: [["2026-10-25", "12"]],
  };
  const newYork = dashboardLineExplorer(panel, data, { locale: "en", timeZone: "America/New_York" });
  expect(new Date(newYork.data.rows[0]!.at).toISOString()).toBe("2026-10-25T04:00:00.000Z");
  expect(newYork.data.chart.marks[0]!.tooltip.title).toBe("Oct 25, 12:00 AM");
  expect(new Date(dashboardLineExplorer(panel, data, berlin).data.rows[0]!.at).toISOString()).toBe("2026-10-24T22:00:00.000Z");
});
test("a dashboard line axis labels round times in the base zone, never decimal steps such as 03:33", () => {
  const panel = dashboardTestDashboard.definition.panels.find((item) => item.id === "req")!;
  const result = dashboardTestPanelResult(panel);
  const svg = dashboardLineExplorer(panel, result.lastGood!.data, berlin, result.lastGood!).data.chart.svg;
  const labels = [...svg.matchAll(/class="stdlib-chart-tick-label"[^>]*text-anchor="middle"[^>]*>([^<]*)</g)].map((match) => match[1]);
  // The fixture window runs 19 Oct 16:32 to 20 Oct 16:32 in Berlin: six-hour ticks and the day at midnight.
  expect(labels).toEqual(["18:00", "20. Okt.", "06:00", "12:00"]);
});
