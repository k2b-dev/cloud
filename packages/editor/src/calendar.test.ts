import { expect, test } from "bun:test";
import { type ChartDescription, calendarLayout, calendarViewportHeight } from "@k2b/ui/charts";
import { type ChartInput, chartKinds, chartRenderOptions, chartTable } from "./charts";
import { notebookChartFrameHtml, notebookChartHeight, renderNotebookChartFigure } from "./markdown/lib/chart-blocks";

const spec = {
  kind: "heatmap",
  layout: "calendar",
  title: "Opens per day",
  scale: "sequential",
  data: [
    ["2026-11-02", 1234.5],
    ["2026-11-03", 0],
  ],
} satisfies ChartDescription;
test("calendar schema is additive, validates dates and preserves table locale", () => {
  const schema = chartKinds();
  const input = schema.parse(spec);
  expect(chartTable(input, "de").rows.map((r) => r.cells.value)).toEqual(["1.234,5", "0"]);
  expect(chartTable(input, "de").rows[0]!.cells.label).toContain("Montag");
  expect(chartRenderOptions(input, "de", { width: 900 })).toMatchObject({ displayWidth: 900 });
  expect(schema.safeParse({ ...spec, data: [["2026-02-30", 1]] }).success).toBe(false);
  expect(
    schema.safeParse({
      ...spec,
      data: [
        ["2026-11-02", 1],
        ["2026-11-02", 2],
      ],
    }).success,
  ).toBe(false);
  expect(schema.safeParse({ kind: "heatmap", title: "Queues", data: [{ x: "Mon", y: "Queue", value: 2 }] }).success).toBe(true);
});

test("calendar unit, sign-free diverging text, explicit locale and null gaps reach the table", () => {
  const input = chartKinds().parse({
    ...spec,
    locale: "de-DE",
    label: "EUR",
    scale: "diverging",
    data: [
      ["2026-11-02", -1234.5],
      ["2026-11-03", null],
    ],
  });
  const table = chartTable(input, "en");
  expect(table.rows).toHaveLength(1);
  expect(table.columns.map((c) => c.label)).toEqual(["Tag", "EUR"]);
  expect(table.rows[0]!.cells.value).toBe("1.234,5 mehr raus");
});

test("calendar notebook print frames permit uniform page scaling", () => {
  const input = chartKinds().parse({
    ...spec,
    data: [
      ["2025-01-01", 5],
      ["2026-11-03", 8],
    ],
  });
  const figure = renderNotebookChartFigure(input, "en", { print: true });
  expect(figure).not.toBeNull();
  expect(figure).toContain("min-width:0;");
  expect(figure).not.toContain("data-stretch");
  expect(figure).not.toMatch(/min-width:[1-9]\d*px/);
});

const calendarInput: ChartInput = {
  kind: "heatmap",
  layout: "calendar",
  title: "Opens per day",
  scale: "sequential",
  data: Array.from({ length: 182 }, (_, i): [string, number] => [
    new Date(Date.UTC(2026, 4, 11) + i * 86400000).toISOString().slice(0, 10),
    i,
  ]),
};
test("calendar notebook placeholder and drawing reserve the same responsive geometry; print fits the page", () => {
  const options = chartRenderOptions(calendarInput, "en-GB");
  if (options.kind !== "heatmap" || options.layout !== "calendar") throw new Error("Expected calendar");
  const size = calendarLayout(options),
    height = notebookChartHeight(calendarInput, "en-GB");
  expect(height).toBe(calendarViewportHeight(size));
  const placeholder = notebookChartFrameHtml({ ...calendarInput, height }, "");
  const drawn = renderNotebookChartFigure(calendarInput, "en-GB")!;
  for (const html of [placeholder, drawn]) {
    expect(html).toContain('data-calendar="true"');
    expect(html).toContain(`--notebook-chart-height:${height}`);
    expect(html).not.toContain(`${height}px`);
  }
  expect(drawn).toContain(`min-width:${size.minWidth}px`);
  const print = renderNotebookChartFigure(calendarInput, "en-GB", { print: true })!;
  expect(print).toContain("min-width:0;");
  expect(print).toContain(`calc(min(100cqw, ${size.maxWidth}px) * ${size.height / size.width})`);
});
