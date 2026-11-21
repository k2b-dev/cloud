import { expect, test } from "bun:test";
import type { CloudAiChartInput } from "@k2b/cloud/ai/app-frame";
import { chart, chartSvg, pendingChartHeight, resolveChartHtml } from "./lib";

test("Code scripts keep signed bar rows synchronous and printable", async () => {
  const markup = String(
    chart(
      {
        kind: "bar",
        title: "Balance",
        layout: "rows",
        data: [
          { label: "Prior", value: -12 },
          { label: "Current", value: 30 },
          { label: "Adjustment", value: -4 },
          { label: "Empty", value: 0 },
        ],
      },
      "en-US",
    ),
  );
  expect(markup).toContain('data-bar-layout="rows"');
  expect(markup).toContain(">-12</text>");
  expect(markup).toContain(">-4</text>");
  expect(markup).not.toMatch(/data-chart-pending|k2b-chart-ranked|NaN|Infinity/);
  expect(await resolveChartHtml(markup, "en-US")).toBe(markup);
});

test("Code scripts render forecast lines and null gaps through the retained chart module", async () => {
  const markup = String(
    chart(
      {
        kind: "line",
        title: "Cash outlook",
        series: [
          {
            data: [
              { x: 1, y: 10 },
              { x: 2, y: null },
              { x: 3, y: -4 },
              { x: 4, y: 8 },
            ],
          },
        ],
        forecast: {
          from: 3,
          band: [
            [-8, 0],
            [2, 14],
          ],
        },
        marker: { at: 3, label: "Today" },
        threshold: { value: 5, label: "Reserve" },
        zero: true,
        step: "after",
      },
      "en-US",
    ),
  );
  expect(markup).toContain('data-chart-kind="line"');
  expect(markup).toContain("Today");
  expect(markup).toContain("Reserve");
  expect(markup).toContain("Cash outlook");
  expect(markup).not.toMatch(/data-chart-pending|NaN|Infinity/);
  expect(await resolveChartHtml(markup, "en-US")).toBe(markup);
});

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
