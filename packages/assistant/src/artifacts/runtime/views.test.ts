import { expect, test } from "bun:test";
import { checkCloudAiView, cloudAiViewSummary } from "@k2b/cloud/ai/browser";
import { createCloud } from "./cloud";
import { createViews } from "./views";

function fixture(timeZone = "UTC") {
  const specs: unknown[] = [];
  const view = createViews(
    async (method, args) => {
      expect(method).toBe("view.save");
      const spec = args[0];
      specs.push(spec);
      const checked = checkCloudAiView(spec);
      if ("issues" in checked) throw new Error(checked.issues.join("; "));
      return { path: "/views/test-12345678.view.json", ...cloudAiViewSummary(checked.view) };
    },
    { locale: "en-US", timeZone },
    true,
  );
  return { view, specs };
}

test.each(["bar", "pie", "donut"])("converts %s rows and skips null y", async (kind) => {
  const { view, specs } = fixture();
  await view.chart({
    kind,
    title: "Counts",
    rows: [
      { label: "A", n: 1 },
      { label: "B", n: null },
    ],
    x: "label",
    y: "n",
    legend: false,
  });
  expect(specs[0]).toEqual({ view: "chart", kind, title: "Counts", legend: false, data: [{ label: "A", value: 1 }] });
});
test.each(["bar", "pie", "donut"])("converts %s Date and numeric labels in the run time zone", async (kind) => {
  const { view, specs } = fixture("Europe/Berlin");
  await view.chart({
    kind,
    title: "Days",
    rows: [
      { day: new Date("2025-12-31T23:00:00Z"), n: 1 },
      { day: new Date("2026-01-01T12:30:00Z"), n: 2 },
      { day: 3, n: 3 },
      { n: null },
      {},
    ],
    x: "day",
    y: "n",
  });
  expect(specs[0]).toMatchObject({
    data: [
      { label: "2026-01-01", value: 1 },
      { label: "2026-01-01T13:30:00", value: 2 },
      { label: "3", value: 3 },
    ],
  });
});
test.each(["bar", "pie", "donut"])("rejects missing and invalid %s labels with the row and column", async (kind) => {
  const { view } = fixture();
  for (const month of [undefined, null, {}, true, NaN, Infinity, new Date(NaN)])
    await expect(
      view.chart({
        kind,
        title: "Months",
        rows: [
          { month: "Jan", n: 1 },
          { month, n: 2 },
        ],
        x: "month",
        y: "n",
      }),
    ).rejects.toMatchObject({
      code: "invalid",
      message: expect.stringContaining("rows[1].month: Expected"),
    });
  await expect(view.chart({ kind, title: "Months", rows: [{ month: "Jan", n: 1 }, { n: 2 }], x: "month", y: "n" })).rejects.toMatchObject({
    code: "invalid",
    message: "rows[1].month: Expected a label: text, a number or a Date.",
  });
});
test.each(["line", "scatter"])("converts wide %s rows", async (kind) => {
  const { view, specs } = fixture();
  await view.chart({
    kind,
    title: "Trend",
    rows: [
      { day: 1, a: 2, b: 3 },
      { day: 2, a: 4, b: 5 },
    ],
    x: "day",
    y: ["a", "b"],
  });
  expect(specs[0]).toMatchObject({
    series: [
      {
        label: "a",
        data: [
          { x: 1, y: 2 },
          { x: 2, y: 4 },
        ],
      },
      {
        label: "b",
        data: [
          { x: 1, y: 3 },
          { x: 2, y: 5 },
        ],
      },
    ],
  });
});
test("long format keeps first-seen series order, dates use the run time zone", async () => {
  const { view, specs } = fixture("America/New_York");
  await view.chart({
    kind: "scatter",
    title: "Trend",
    rows: [
      { time: new Date("2026-01-02T00:30:00Z"), team: "B", n: 1 },
      { time: "2026-01-02", team: "A", n: 2 },
    ],
    x: "time",
    y: "n",
    series: "team",
  });
  expect(specs[0]).toMatchObject({
    series: [
      { label: "B", data: [{ x: "2026-01-01T19:30:00", y: 1 }] },
      { label: "A", data: [{ x: "2026-01-02", y: 2 }] },
    ],
  });
});
test("sparkline converts one y column", async () => {
  const { view, specs } = fixture();
  await view.chart({ kind: "sparkline", title: "Trend", rows: [{ n: 1 }, {}, { n: 2 }], y: "n", area: true });
  expect(specs[0]).toEqual({ view: "chart", kind: "sparkline", title: "Trend", area: true, data: [1, 2] });
});
test("long format keeps distinct values even when their labels match", async () => {
  const { view, specs } = fixture();
  await view.chart({
    kind: "scatter",
    title: "Groups",
    rows: [
      { x: 1, group: 1, n: 2 },
      { x: 2, group: "1", n: 3 },
    ],
    x: "x",
    y: "n",
    series: "group",
  });
  expect(specs[0]).toMatchObject({
    series: [
      { label: "1", data: [{ x: 1, y: 2 }] },
      { label: "1", data: [{ x: 2, y: 3 }] },
    ],
  });
});
test.each(["line", "scatter"])("rejects missing and invalid %s series cells", async (kind) => {
  const { view } = fixture();
  for (const group of [undefined, null, {}, true, NaN, Infinity, new Date(NaN)])
    await expect(
      view.chart({ kind, title: "Groups", rows: [{ x: 1, group, n: 2 }], x: "x", y: "n", series: "group" }),
    ).rejects.toMatchObject({
      code: "invalid",
      message: expect.stringContaining("rows[0].group: Expected"),
    });
  await expect(view.chart({ kind, title: "Groups", rows: [{ x: 1, n: 2 }], x: "x", y: "n", series: "group" })).rejects.toMatchObject({
    code: "invalid",
    message: "rows[0].group: Expected a label: text, a number or a Date.",
  });
});
test.each(["line", "scatter"])("groups equal %s Date series by wall-clock text in first-seen order", async (kind) => {
  const { view, specs } = fixture("Europe/Berlin");
  await view.chart({
    kind,
    title: "Groups",
    rows: [
      { x: 1, day: new Date("2025-12-31T23:00:00Z"), n: 1 },
      { x: 2, day: new Date("2026-01-01T12:30:00Z"), n: 2 },
      { x: 3, day: new Date("2025-12-31T23:00:00Z"), n: 3 },
      { x: 4, day: new Date("2026-01-01T12:30:00Z"), n: 4 },
      { x: 5, n: null },
    ],
    x: "x",
    y: "n",
    series: "day",
  });
  expect(specs[0]).toMatchObject({
    series: [
      {
        label: "2026-01-01",
        data: [
          { x: 1, y: 1 },
          { x: 3, y: 3 },
        ],
      },
      {
        label: "2026-01-01T13:30:00",
        data: [
          { x: 2, y: 2 },
          { x: 4, y: 4 },
        ],
      },
    ],
  });
});
test("canonical chart forms pass through for every kind including gauge", async () => {
  const { view, specs } = fixture();
  const charts = [
    { kind: "bar", data: [{ label: "A", value: 1 }] },
    { kind: "pie", data: [{ label: "A", value: 1 }] },
    { kind: "donut", data: [{ label: "A", value: 1 }] },
    {
      kind: "line",
      series: [
        {
          data: [
            { x: 0, y: 1 },
            { x: 1, y: 2 },
          ],
        },
      ],
    },
    { kind: "scatter", series: [{ data: [{ x: 0, y: 1 }] }] },
    { kind: "histogram", data: [1, 2, 3] },
    { kind: "gauge", value: 50 },
    { kind: "sparkline", data: [1, 2] },
  ];
  for (const chart of charts) await view.chart({ ...chart, title: "Result" });
  expect(specs).toHaveLength(8);
});
test("histogram counts all observations with nice edges instead of truncating raw values", async () => {
  const { view, specs } = fixture();
  const rows = Array.from({ length: 10000 }, (_, index) => ({ price: index / 100 }));
  await view.chart({ kind: "histogram", title: "Distribution", rows, value: "price", bins: 10 });
  const checked = checkCloudAiView(specs[0]);
  if ("issues" in checked || checked.view.view !== "chart" || checked.view.kind !== "bar") throw new Error("Expected binned chart");
  expect(checked.view.data.reduce((n, bin) => n + bin.value, 0)).toBe(rows.length);
  expect(checked.view.data[0]?.label).toBe("0–10");
  expect(checked.view.data.at(-1)?.label).toBe("90–100");
});
test("histogram uses half-open bins, includes the upper edge and handles equal values", async () => {
  const { view, specs } = fixture();
  await view.chart({ kind: "histogram", title: "Edges", rows: [0, 1, 2, 3, 4].map((n) => ({ n })), value: "n", bins: [0, 2, 4] });
  expect(specs[0]).toMatchObject({
    kind: "bar",
    data: [
      { label: "0–2", value: 2 },
      { label: "2–4", value: 3 },
    ],
  });
  await view.chart({ kind: "histogram", title: "Equal", rows: [{ n: 2 }, { n: 2 }], value: "n" });
  expect(specs[1]).toMatchObject({ data: [{ label: "2", value: 2 }] });
});
test.each([
  { values: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7], bins: 7, counts: [1, 1, 1, 1, 1, 1, 2], first: "0–0.1" },
  { values: [0, 0.1, 0.2, 0.3, 0.4], bins: 4, counts: [1, 1, 1, 2], first: "0–0.1" },
  { values: [0, 1, 2, 3, 4], bins: 4, counts: [1, 1, 1, 2], first: "0–1" },
  { values: [0.3, 0.4, 0.5, 0.6, 0.7], bins: 4, counts: [1, 1, 1, 2], first: "0.3–0.4" },
])("generated histogram edges keep half-open counts: %j", async ({ values, bins, counts, first }) => {
  const { view, specs } = fixture();
  await view.chart({ kind: "histogram", title: "Edges", rows: values.map((n) => ({ n })), value: "n", bins });
  const checked = checkCloudAiView(specs[0]);
  if ("issues" in checked || checked.view.view !== "chart" || checked.view.kind !== "bar") throw new Error("Expected binned chart");
  expect(checked.view.data.map((bin) => bin.value)).toEqual([...counts]);
  expect(checked.view.data[0]?.label).toBe(first);
});
test("histogram rejects invalid or incomplete edges and bin counts", async () => {
  const { view } = fixture();
  for (const bins of [[1, 0], [1, 2], [0, 1], 0, 481, 1.5])
    await expect(view.chart({ kind: "histogram", title: "Edges", rows: [{ n: 0 }, { n: 2 }], value: "n", bins })).rejects.toMatchObject({
      code: "invalid",
    });
});
test("table infers first-seen columns, normalizes dates, undefined and footer", async () => {
  const { view, specs } = fixture("Europe/Berlin");
  await view.table({
    title: "Rows",
    rows: [
      { n: 1, time: new Date("2026-01-01T00:00:00Z"), label: "A" },
      { n: 2, time: undefined, later: "B" },
    ],
    footer: { n: 3 },
  });
  expect(specs[0]).toMatchObject({
    columns: [
      { id: "n", type: "number" },
      { id: "time", type: "datetime" },
      { id: "label", type: "text" },
      { id: "later", type: "text" },
    ],
    rows: [
      { n: 1, time: "2026-01-01T01:00:00", label: "A", later: null },
      { n: 2, time: null, label: null, later: "B" },
    ],
    footer: { n: 3, time: null, label: null, later: null },
  });
});
test("table infers empty columns from footer cells and validates on the server", async () => {
  const { view, specs } = fixture();
  await view.table({ title: "t", columns: ["name", "n"], rows: [], footer: { name: "Total", n: 0 } });
  expect(specs[0]).toMatchObject({
    columns: [
      { id: "name", type: "text" },
      { id: "n", type: "number" },
    ],
    rows: [],
    footer: { name: "Total", n: 0 },
  });
});
test("table infers all-null columns as text with or without a text footer", async () => {
  const { view, specs } = fixture();
  for (const footer of [{ name: "Total" }, undefined])
    await view.table({ title: "t", columns: ["name"], rows: [{ name: null }, {}], ...(footer ? { footer } : {}) });
  for (const spec of specs) expect(spec).toMatchObject({ columns: [{ id: "name", type: "text" }], rows: [{ name: null }, { name: null }] });
});
test("table keeps only listed columns and passes format and sort", async () => {
  const { view, specs } = fixture();
  await view.table({
    title: "Rows",
    rows: [{ n: 1, discarded: {} }],
    columns: [{ id: "n", format: { style: "currency", currency: "EUR" } }],
    sort: { column: "n", direction: "desc" },
  });
  expect(specs[0]).toMatchObject({
    rows: [{ n: 1 }],
    columns: [{ id: "n", type: "number", format: { style: "currency", currency: "EUR" } }],
    sort: { column: "n", direction: "desc" },
  });
});
test("row conversion ignores inherited properties for missing columns", async () => {
  const { view, specs } = fixture();
  await view.table({ title: "Missing", columns: ["toString", "constructor"], rows: [{}], footer: {} });
  expect(specs[0]).toMatchObject({ rows: [{ toString: null, constructor: null }], footer: { toString: null, constructor: null } });
  await view.chart({
    kind: "bar",
    title: "Own cells",
    rows: [{ label: "Missing" }, { label: "Own", toString: 1 }],
    x: "label",
    y: "toString",
  });
  expect(specs[1]).toMatchObject({ data: [{ label: "Own", value: 1 }] });
  const row = Object.fromEntries([["__proto__", "Own cell"]]);
  await view.table({ title: "Own cells", columns: ["__proto__"], rows: [row] });
  expect(specs[2]).toMatchObject({ rows: [row] });
});
test.each([true, {}, [], Infinity, NaN])("table rejects unsupported cells with column and row: %j", async (cell) => {
  const { view } = fixture();
  await expect(view.table({ title: "Rows", rows: [{ price: cell }] })).rejects.toMatchObject({
    code: "invalid",
    message: expect.stringContaining("rows[0].price: Unsupported cell; convert it to text or a number."),
  });
});
test("conversion errors name chart row and column, gauge cannot use rows", async () => {
  const { view } = fixture();
  await expect(view.chart({ kind: "bar", title: "Rows", rows: [{ name: "A", n: "1" }], x: "name", y: "n" })).rejects.toMatchObject({
    code: "invalid",
    message: expect.stringContaining("rows[0].n"),
  });
  await expect(view.chart({ kind: "gauge", title: "Rows", rows: [] })).rejects.toMatchObject({ code: "invalid" });
  await expect(view.chart({ kind: "sparkline", title: "Rows", rows: [{ a: 1, b: 2 }], y: ["a", "b"] })).rejects.toMatchObject({
    code: "invalid",
    message: "y: Choose one value column.",
  });
});
test("HTML app createCloud rejects both view methods before RPC", async () => {
  let calls = 0;
  const cloud = createCloud(
    async () => {
      calls++;
    },
    { locale: "en", timeZone: "UTC", user: null },
  );
  for (const method of [cloud.view.chart, cloud.view.table])
    await expect(method({})).rejects.toMatchObject({
      code: "unavailable",
      message: "cloud.view.* works in code_run scripts; an app draws charts with cloud.chart().",
    });
  expect(calls).toBe(0);
});

test("a Date in a date column keeps the calendar day of the run's time zone", async () => {
  const { view, specs } = fixture("Europe/Berlin");
  await view.table({
    title: "Days",
    columns: [{ id: "day", type: "date" }, "at"],
    rows: [{ day: new Date("2026-01-01T23:30:00Z"), at: new Date("2026-01-01T23:30:00Z") }],
    footer: { day: new Date("2026-01-02T00:00:00Z") },
  });
  expect(specs[0]).toMatchObject({
    rows: [{ day: "2026-01-02", at: "2026-01-02T00:30:00" }],
    footer: { day: "2026-01-02" },
  });
});
