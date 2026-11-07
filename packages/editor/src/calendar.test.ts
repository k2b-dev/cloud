import { expect, test } from "bun:test";
import { chartKinds, chartRenderOptions, chartTable } from "./charts";
import { renderNotebookChartFigure } from "./markdown/lib/chart-blocks";

const spec = {
  kind: "heatmap",
  layout: "calendar",
  title: "Opens per day",
  scale: "sequential",
  data: [
    ["2026-11-02", 1234.5],
    ["2026-11-03", 0],
  ],
};
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
