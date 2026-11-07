import { expect, test } from "bun:test";
import { balanceFlowRows, balanceFlowTooltip, renderBalanceFlowSvg } from "@k2b/ui/charts/core";
import { chartKinds, chartMarks, chartRenderOptions, chartRows, chartSvgMarks, chartTable, chartTooltip } from "./charts";
import {
  chartBlockFrame,
  notebookChartFrameHtml,
  notebookChartHeight,
  parseNotebookChartBlocks,
  renderNotebookChartFigure,
} from "./markdown/lib/chart-blocks";

const source = {
  kind: "balanceFlow",
  title: "Settlements",
  currency: "EUR",
  locale: "de-DE",
  periods: [
    {
      label: "Oktober",
      opening: 100,
      inflows: [{ label: "Bestellungen", value: 300 }],
      outflows: [{ label: "Gebühren", value: 50 }],
      closing: 350,
    },
    { label: "November", opening: 350, inflows: [], outflows: [{ label: "Auszahlung", value: 200 }], closing: 150 },
  ],
};
test("balance flow schema validates accounting, currency, locale and initial period", () => {
  const schema = chartKinds();
  for (const invalid of [
    { ...source, locale: "de_DE" },
    { ...source, currency: "Euro" },
    { ...source, period: 2 },
    { ...source, periods: [{ ...source.periods[0], closing: 349 }] },
  ])
    expect(schema.safeParse(invalid).success).toBe(false);
  const parsed = schema.parse(source);
  expect(chartMarks(parsed)).toBe(9);
  expect(chartRenderOptions(parsed, "en")).toMatchObject({ locale: "de-DE", currency: "EUR" });
});
test("every shared tooltip and table field matches Solid including the inherited-locale override", () => {
  const input = chartKinds().parse(source),
    options = chartRenderOptions(input, "en");
  if (options.kind !== "balanceFlow") throw new Error("Expected balance flow");
  const rows = chartRows(input, "en");
  for (const datum of chartSvgMarks(renderBalanceFlowSvg({ ...options, inspect: true }))) {
    const row = rows.add(datum);
    expect(chartTooltip(rows.columns(), row, input.kind)).toEqual(balanceFlowTooltip(datum, source.locale));
  }
  const table = chartTable(input, "en");
  expect(table.rows.map((r) => r.cells.label)).toEqual(balanceFlowRows(options).map((r) => r.label));
  expect(table.rows[0]!.cells.value).toBe("100,00 €");
  expect(table.columns.map((c) => c.label)).toEqual(["Detail", "Zeitraum", "Richtung", "Wert"]);
});
test("notebooks reserve the max period and preserve navigation and period tables for print", () => {
  const input = chartKinds().parse(source);
  expect(notebookChartHeight(input, "en")).toBeGreaterThanOrEqual(280);
  const figure = renderNotebookChartFigure(input, "en");
  expect(figure).toContain("data-balance-flow");
  expect(figure).toContain('data-balance-template="1"');
  expect(renderNotebookChartFigure(input, "en", { print: true })).toContain("350,00 €");
  const options = { maxBlocks: 8, maxSeries: 8, maxValues: 480, schema: chartKinds() };
  const block = `:::chart\ntype: balanceFlow\ntitle: Settlements\ncurrency: EUR\nperiods: ${JSON.stringify(source.periods)}\n:::`;
  const frame = chartBlockFrame(block.split("\n").slice(1, -1), options)!;
  expect(notebookChartFrameHtml(frame, "", { locale: "en" })).toContain("data-balance-flow");
  expect(notebookChartFrameHtml(frame, "", { locale: "en" })).toContain('data-state="loading"');
  const parsed = parseNotebookChartBlocks(block, options);
  expect(parsed.diagnostics).toEqual([]);
  expect(parsed.blocks[0]?.input.kind).toBe("balanceFlow");
});

test("zero flows remain in the accessible table without inventing a visible band", () => {
  const input = chartKinds().parse({
    ...source,
    periods: [{ label: "Zero", opening: 0, inflows: [{ label: "No orders", value: 0 }], outflows: [], closing: 0 }],
  });
  expect(chartTable(input, "en").rows.map((row) => row.cells.label)).toEqual(["Anfang", "No orders", "Verfügbar", "Schluss"]);
});

test("balance flow tooltip formats and labels survive the portable contract", () => {
  const input = chartKinds().parse({
    ...source,
    tooltip: { label: "Betrag", format: { style: "currency", currency: "EUR", decimals: 0 } },
  });
  const drawing = chartRenderOptions(input, "en");
  if (drawing.kind !== "balanceFlow") throw new Error("Expected balance flow");
  const rows = chartRows(input, "en");
  for (const datum of chartSvgMarks(renderBalanceFlowSvg({ ...drawing, inspect: true }))) {
    const row = rows.add(datum);
    expect(chartTooltip(rows.columns(), row, input.kind)).toEqual(balanceFlowTooltip(datum, source.locale));
  }
  const table = chartTable(input, "en");
  expect(table.columns.at(-1)?.label).toBe("Betrag");
  expect(table.rows[1]?.cells.value).toBe("↙ 300 €");
});
