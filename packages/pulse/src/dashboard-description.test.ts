import { expect, test } from "bun:test";
import { drawChart } from "@k2b/editor/charts";
import { parseRows069, signedRows069Json } from "../../ui/test/chart-rows-069-fixture";
import { type DashboardPanel, DashboardPanelSchema, DashboardSaveSchema } from "./dashboard-contracts";
import {
  dashboardCategoryDescription,
  dashboardChartDescription,
  dashboardChartRenderOptions,
  dashboardMoneyDescription,
} from "./dashboard-description";
import { type DashboardPanelData, projectDashboardPanel } from "./dashboard-result";
import { dashboardTestKinds } from "./frontend/workspace/dashboard-test-fixtures";

const clock = { locale: "de", timeZone: "Europe/Berlin" };
const panel = (kind: DashboardPanel["kind"], columns: string[], options: Partial<DashboardPanel> = {}) =>
  DashboardPanelSchema.parse({ id: "chart", title: "Invented observations", kind, columns, sql: "SELECT 1", ...options });
const data = (columns: string[], rows: unknown[][]): DashboardPanelData => ({
  columns: columns.map((name) => ({ name, type: "Float64" })),
  rows,
});
const project = (panel: DashboardPanel, value: DashboardPanelData) =>
  projectDashboardPanel(panel, {
    ...value,
    truncated: false,
    rowCount: value.rows.length,
    stats: { elapsedMs: 1, readRows: value.rows.length, readBytes: 1 },
  });

test("saved Pulse bar data retains the signed values accepted in 0.69", () => {
  const signedRows069 = parseRows069(signedRows069Json);
  const p = panel("bar", ["category", "value"], { x: "category" });
  const result = data(
    p.columns,
    signedRows069.data.map(({ label, value }) => [label, value]),
  );
  expect(dashboardChartDescription(p, result, clock)).toMatchObject({ kind: "bar", data: signedRows069.data });
  const options = dashboardChartRenderOptions(p, result, clock);
  if (options.kind !== "bar") throw new Error("Expected the saved bar renderer");
  expect(() => drawChart(options)).not.toThrow();
  expect(drawChart({ ...options, layout: "rows" })).toContain('data-bar-layout="rows"');
});

test("SQL descriptions preserve named series, time-zone instants and JSON null gaps", () => {
  const p = panel("line", ["host", "at", "amount"], { x: "at", series: "host" });
  const result = data(p.columns, [
    ["North", "2026-10-20 12:00:00", "12"],
    ["North", "2026-10-20 13:00:00", null],
    ["South", "2026-10-20 12:00:00", 7],
  ]);
  result.columns[1]!.type = "DateTime('Europe/Berlin')";
  const description = dashboardChartDescription(p, result, clock);
  expect(description).toMatchObject({
    kind: "line",
    series: [
      {
        id: '["North","amount"]',
        label: "North",
        data: [
          { x: Date.parse("2026-10-20T10:00:00Z"), y: 12 },
          { x: Date.parse("2026-10-20T11:00:00Z"), y: null },
        ],
      },
      { label: "South" },
    ],
  });
  expect(JSON.parse(JSON.stringify(description))).toEqual(description);
  expect(() => project(p, { ...result, rows: [["North", "invalid", 1]] })).toThrow("invalid value");
});

test("saved single-series bar labels, repeated source rows and funnel magnitudes keep their order", () => {
  const p = panel("bar", ["category", "value"], { x: "category" });
  expect(
    dashboardChartDescription(
      p,
      data(p.columns, [
        ["A", 10],
        ["A", 8],
        ["B", null],
      ]),
      clock,
    ),
  ).toEqual({
    kind: "bar",
    title: p.title,
    data: [
      { label: "A", value: 10 },
      { label: "A", value: 8 },
      { label: "B", value: null },
    ],
  });
  const f = { ...p, kind: "funnel" as const };
  expect(
    dashboardChartDescription(
      f,
      data(p.columns, [
        ["Visit", 20],
        ["Contact", 4],
      ]),
      clock,
    ),
  ).toMatchObject({
    kind: "barGauge",
    min: 0,
    max: 20,
    data: [
      { label: "Visit", value: 20 },
      { label: "Contact", value: 4 },
    ],
  });
  expect(() => dashboardCategoryDescription(f, data(p.columns, [["A", null]]), "de")).toThrow();
});

test("every already merged JSON chart can be drawn from its documented SQL columns", () => {
  const cases = [
    {
      kind: "pie",
      columns: ["category", "value"],
      x: "category",
      rows: [
        ["A", "12"],
        ["B", 8],
      ],
    },
    {
      kind: "donut",
      columns: ["category", "value"],
      x: "category",
      rows: [
        ["A", 12],
        ["B", 8],
      ],
    },
    {
      kind: "barGauge",
      columns: ["category", "value"],
      x: "category",
      rows: [
        ["A", 12],
        ["B", 8],
      ],
    },
    { kind: "histogram", columns: ["value"], rows: [[1], [2], [2], [4], [null]] },
    { kind: "sparkline", columns: ["value"], rows: [[1], [null], [3]] },
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
        [3, "4"],
      ],
    },
    {
      kind: "heatmap",
      columns: ["x", "y", "value"],
      x: "x",
      series: "y",
      rows: [
        ["A", "North", 1],
        ["B", "North", null],
        ["A", "South", 3],
      ],
    },
  ] satisfies { kind: DashboardPanel["kind"]; columns: string[]; x?: string; series?: string; rows: unknown[][] }[];
  for (const fixture of cases) {
    const p = panel(fixture.kind, fixture.columns, {
      ...("x" in fixture ? { x: fixture.x } : {}),
      ...("series" in fixture ? { series: fixture.series } : {}),
    });
    const result = data(p.columns, fixture.rows);
    expect(() => project(p, result)).not.toThrow();
    expect(() => project(p, { ...result, rows: [] })).not.toThrow();
    expect(dashboardChartRenderOptions(p, result, clock).kind).toBe(fixture.kind);
  }
});

test("storage grows additively, still rejects unknown fields, and keeps existing dashboard JSON valid", async () => {
  const website = await Bun.file(new URL("../examples/website-dashboard.json", import.meta.url)).json();
  expect(DashboardSaveSchema.safeParse(website).success).toBe(true);
  expect(
    DashboardSaveSchema.safeParse({
      name: dashboardTestKinds.name,
      definition: { panels: dashboardTestKinds.definition.panels.map((panel) => ({ ...panel, params: {} })) },
    }).error,
  ).toBeUndefined();
  expect(() => panel("gauge", ["value"], { x: "value" })).toThrow();
  expect(() => panel("heatmap", ["x", "value"], { x: "x" })).toThrow();
  expect(DashboardPanelSchema.safeParse({ ...panel("pie", ["category", "value"], { x: "category" }), callback: "ignored?" }).success).toBe(
    false,
  );
});

test("limits belong to Pulse and count actual marks, while retaining point and series budgets", () => {
  const p = panel("bar", ["category", ...Array.from({ length: 8 }, (_, i) => `value${i}`)], { x: "category" });
  const result = data(
    p.columns,
    Array.from({ length: 480 }, (_, i) => [`C${i}`, ...Array.from({ length: 8 }, () => 1)]),
  );
  expect(() => project(p, result)).not.toThrow();
  expect(() => project(p, { ...result, rows: [...result.rows, result.rows[0]!] })).toThrow("480 points");
  const tooManySeries = { ...p, columns: [...p.columns, "ninth"] };
  expect(() => project(tooManySeries, data(tooManySeries.columns, [["A", ...Array.from({ length: 9 }, () => 1)]]))).toThrow("8 series");
  const heatmap = panel("heatmap", ["x", "row", "value"], { x: "x", series: "row" });
  const matrix = Array.from({ length: 8 }, (_, y) => Array.from({ length: 480 }, (_, x) => [`X${x}`, `Y${y}`, x === 0 ? null : 1])).flat();
  expect(() => project(heatmap, data(heatmap.columns, matrix))).not.toThrow();
  expect(() => project(heatmap, data(heatmap.columns, [...matrix, ["extra", "Y0", 1]]))).toThrow("480 points");
});

test("semantic errors are visible failures instead of silently omitted SQL values", () => {
  for (const kind of ["pie", "donut", "barGauge"] as const) {
    const p = panel(kind, ["category", "value"], { x: "category" });
    expect(() => project(p, data(p.columns, [["A", -1]]))).toThrow("nonnegative");
    expect(() => project(p, data(p.columns, [["A", "n/a"]]))).toThrow("finite");
  }
  const gauge = panel("gauge", ["value"]);
  for (const rows of [[[101]], [[-1]], [[null]], [[20], [30]]]) expect(() => project(gauge, data(gauge.columns, rows))).toThrow();
  const heatmap = panel("heatmap", ["x", "row", "value"], { x: "x", series: "row" });
  expect(() =>
    project(
      heatmap,
      data(heatmap.columns, [
        ["A", "B", 1],
        ["A", "B", 2],
      ]),
    ),
  ).toThrow("duplicate");
});

test("host tooltips use the shared rows with the panel unit and reader locale", () => {
  const p = panel("pie", ["category", "value"], { x: "category", unit: "visits" });
  const options = dashboardChartRenderOptions(p, data(p.columns, [["North", 1234.5]]), clock);
  expect(
    options.tooltip({
      kind: "pie",
      datum: { index: 0, role: "item", label: "North", anchor: [0, 0], values: [{ key: "value", value: 1234.5 }] },
    }),
  ).toEqual({ title: "North", rows: [{ label: "Wert", value: "1.234,5 visits" }] });
});

test("area SQL aligns series by category and keeps absent and explicit null cells as gaps", () => {
  const p = panel("area", ["day", "region", "amount"], { x: "day", series: "region" });
  const result = data(p.columns, [
    ["Mon", "North", 4],
    ["Tue", "North", null],
    ["Mon", "South", 2],
    ["Wed", "South", 3],
  ]);
  expect(dashboardChartDescription(p, result, clock)).toEqual({
    kind: "area",
    title: p.title,
    layout: "stacked",
    normalize: false,
    x: ["Mon", "Tue", "Wed"],
    series: [
      { label: "North", data: [4, null, null] },
      { label: "South", data: [2, null, 3] },
    ],
  });
  expect(() => project(p, result)).not.toThrow();
  expect(dashboardChartRenderOptions({ ...p, kind: "areaPercent" }, result, clock)).toMatchObject({ kind: "area", normalize: true });
  expect(() => project(p, { ...result, rows: [...result.rows, ["Mon", "North", 1]] })).toThrow("duplicate");
  expect(() => project(p, data(p.columns, [["Mon", "North", -1]]))).toThrow();
  expect(() =>
    project(
      p,
      data(
        p.columns,
        Array.from({ length: 9 }, (_, i) => ["Mon", `S${i}`, 1]),
      ),
    ),
  ).toThrow("8 series");
  expect(() =>
    project(
      p,
      data(
        p.columns,
        Array.from({ length: 481 }, (_, i) => [i, "North", 1]),
      ),
    ),
  ).toThrow("480 points");
});

test("budget and balance SQL become portable money blocks with validated magnitudes", () => {
  const p = panel("budget", ["name", "used", "expected", "limit"], { x: "name", unit: "EUR" });
  const result = data(p.columns, [
    ["Office", "80", 30, 100],
    ["Travel", 0, 0, 0],
  ]);
  expect(dashboardMoneyDescription(p, result, "de")).toEqual({
    block: "budget",
    currency: "EUR",
    items: [
      { label: "Office", used: 80, expected: 30, limit: 100 },
      { label: "Travel", used: 0, expected: 0, limit: 0 },
    ],
  });
  expect(() => project(p, result)).not.toThrow();
  const b = panel("balance", ["start", "in", "out"], { unit: "EUR" });
  expect(dashboardMoneyDescription(b, data(b.columns, [[-20, "80", 30]]), "en")).toEqual({
    block: "balance",
    currency: "EUR",
    start: -20,
    in: 80,
    out: 30,
  });
  expect(() =>
    project(
      b,
      data(b.columns, [
        [0, 1, 2],
        [1, 2, 3],
      ]),
    ),
  ).toThrow("one aggregate");
  for (const value of [null, -1, "invalid", Infinity]) expect(() => project(b, data(b.columns, [[0, value, 1]]))).toThrow();
  expect(() => project(p, data(p.columns, [["A", 1, null, 10]]))).toThrow();
  expect(() =>
    project(
      p,
      data(
        p.columns,
        Array.from({ length: 481 }, () => ["A", 1, 0, 10]),
      ),
    ),
  ).toThrow("480 points");
  for (const bad of [
    { kind: "budget", columns: ["name", "used"], x: "name", unit: "EUR" },
    { kind: "balance", columns: ["start", "in", "out"], unit: "euros" },
    { kind: "balance", columns: ["start", "in", "out", "extra"], unit: "EUR" },
    { kind: "budget", columns: ["name", "used", "limit"], x: "name", series: "used", unit: "EUR" },
  ])
    expect(DashboardPanelSchema.safeParse({ id: "bad", title: "Bad", sql: "SELECT 1", ...bad }).success).toBe(false);
});
