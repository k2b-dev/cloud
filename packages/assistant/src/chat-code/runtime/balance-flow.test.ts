import { expect, test } from "bun:test";
import { chart, resolveChartHtml } from "./lib";

const spec = {
  kind: "balanceFlow",
  title: "Marketplace settlements",
  currency: "EUR",
  locale: "de-DE",
  periods: [
    {
      label: "Oktober",
      opening: 10,
      inflows: [{ label: "Bestellungen", value: 20 }],
      outflows: [{ label: "Gebühren", value: 5 }],
      closing: 25,
    },
    { label: "November", opening: 25, inflows: [], outflows: [{ label: "Auszahlung", value: 15 }], closing: 10 },
  ],
};
test("cloud.chart draws every period offline with complete currency values and no unrelated palette", async () => {
  const markup = String(chart(spec, "en"));
  expect(markup).toContain("data-balance-flow");
  expect(markup).toContain('data-balance-month="1"');
  expect(markup).toContain("25,00 €");
  expect(markup.match(/<h3[^>]*>Marketplace settlements<\/h3>/g)).toHaveLength(1);
  expect(markup).not.toMatch(/textLength|--[^,;)\s]*(?:green|red|success|danger)/);
  expect(await resolveChartHtml(markup, "en")).toBe(markup);
  expect(() => chart({ ...spec, periods: [{ ...spec.periods[0], closing: 0 }] }, "en")).toThrow("must equal closing");
});
