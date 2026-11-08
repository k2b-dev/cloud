import { expect, test } from "bun:test";
import type { CloudAiChartInput } from "@k2b/cloud/ai/app-frame";
import { chart, chartSvg, pendingChartHeight } from "./lib";

test("cloud.chart renders horizontal grouped rows and their title in Code scripts", () => {
  const markup = String(
    chart(
      {
        kind: "hbar",
        title: "Orders",
        subtitle: "By shop",
        series: ["Current", "Prior"],
        rows: [
          { group: "Store", label: "Desks", values: [10, 20] },
          { label: "Missing", values: [null, null] },
        ],
      },
      "de-DE",
    ),
  );
  expect(markup).toContain('data-chart-kind="hbar"');
  expect(markup).toContain(">Orders</text>");
  expect(markup).toContain(">By shop</text>");
  expect(markup).toContain("Gesamt");
  expect(markup).not.toContain("<style>");
  expect(markup).not.toMatch(/NaN|Infinity/);
});

test("horizontal rows reserve their final height before the lazy renderer loads", () => {
  const input: CloudAiChartInput = {
    kind: "hbar",
    title: "Regional orders",
    subtitle: "Fictional",
    series: ["Current", "Prior"],
    rows: Array.from({ length: 20 }, (_, i) => ({ group: "Shops", label: `Region ${i + 1}`, values: [i, i + 1] })),
  };
  for (const width of [480, 390]) {
    const prepared = { input, title: input.title };
    const height = pendingChartHeight(prepared, "en", width, 280);
    expect(height).toBeGreaterThan(280);
    expect(chartSvg(prepared, "en", width, 280)).toContain(`viewBox="0 0 ${width} ${height}"`);
  }
});
