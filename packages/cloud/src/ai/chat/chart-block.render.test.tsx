import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { barChartLayout } from "@k2b/ui/charts";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { cloudAiChartRenderOptions, cloudAiChartTable } from "../chart-block";
import { cloudAiChartSchema } from "../default-tool-contracts";

const root = mkdtempSync(resolve(tmpdir(), "cloud-chart-block-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { CloudChartBlock } = await import("./chart-block");
const { LocaleProvider } = await import("@k2b/ui");

const render = (args: unknown, options: { completed?: boolean; locale?: string } = {}) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: options.locale ?? "en",
      get children() {
        return createComponent(CloudChartBlock, { args, completed: options.completed ?? true });
      },
    }),
  );

const revenue = {
  kind: "bar",
  title: "Revenue per month",
  subtitle: "EUR, 2026",
  data: [
    { label: "Jan", value: 1200 },
    { label: "Feb", value: 980 },
  ],
};

describe("chart chat block", () => {
  test("draws the chart with its title, subtitle, data table switch and Copy data", () => {
    const html = render(revenue);
    expect(html).toContain("<h3");
    expect(html).toContain("Revenue per month");
    expect(html).toContain("EUR, 2026");
    expect(html).toContain('data-chart-kind="bar"');
    expect(html.match(/data-chart-datum=/g)).toHaveLength(2);
    expect(html).toContain("Copy data");
    expect(html).toContain("Diagram");
    expect(html).toContain("Table");
    // The viewport has its height from the first frame, for the chart and for the table.
    expect(html).toMatch(/k2b-chart-explorer__viewport[^>]*height:\s*18rem/);
    // Every mark names its exact value for assistive technology and tooltips.
    expect(html).toContain("<title>Jan · Value: 1,200</title>");
  });

  test("uses the shared tooltip label and currency format in German", () => {
    const input = cloudAiChartSchema().parse({
      kind: "bar",
      title: "Umsatz",
      data: [{ label: "Jan", value: 1200.5 }],
      tooltip: { label: "Umsatz", format: { style: "currency", currency: "EUR" } },
    });
    const html = render(input, { locale: "de" });
    const table = cloudAiChartTable(input, "de");
    expect(table.columns).toEqual([
      { id: "label", label: "Kategorie", numeric: false },
      { id: "value", label: "Umsatz", numeric: true },
    ]);
    expect(table.rows[0]?.cells).toEqual({ label: "Jan", value: "1.200,50\u00a0€" });
    expect(html).toContain("<title>Jan · Umsatz: 1.200,50\u00a0€</title>");
    expect(html).toContain("Daten kopieren");
    // The table mounts when selected; SSR exposes its formatted row through the mark's accessible title.
    expect(html).not.toContain("Jan · Wert:");
  });

  test("speaks the reader's language", () => {
    const html = render(revenue, { locale: "de" });
    expect(html).toContain("Daten kopieren");
    expect(html).toContain("Diagramm");
    expect(html).toContain("<title>Jan · Wert: 1.200</title>");
  });

  test("shows nothing for arguments that are not a chart while the call runs, and says so once it ended", () => {
    const invalid = { kind: "bar", title: "Orders", data: [] };
    expect(render(invalid, { completed: false })).not.toContain("<");
    expect(render(invalid)).toContain("This chart cannot be shown.");
    expect(render(invalid, { locale: "de" })).toContain("Dieses Diagramm kann nicht angezeigt werden.");
  });

  test("a tall single bar chart grows its frame up to 40rem; a group keeps the usual height", () => {
    const bars = (count: number) => ({
      kind: "bar",
      title: "Visits per site",
      data: Array.from({ length: count }, (_, index) => ({ label: `Site ${index + 1}`, value: (index + 1) * 10 })),
    });
    const viewport = (html: string) => html.match(/k2b-chart-explorer__viewport[^>]*?height:\s*([^;"]+)/)?.[1];
    expect(viewport(render(bars(3)))).toBe("18rem");
    for (const count of [15, 40]) {
      const options = cloudAiChartRenderOptions(cloudAiChartSchema().parse(bars(count)), "en", { legend: "outside" });
      if (options.kind !== "bar") throw new Error("Expected bar options.");
      const { height } = barChartLayout(options);
      expect(height).toBeGreaterThan(288);
      expect(viewport(render(bars(count)))).toBe(`min(40rem, max(18rem, ${height}px))`);
    }
    const group = { title: "Sites", charts: [bars(40), bars(3)] };
    expect([...render(group).matchAll(/k2b-chart-explorer__viewport[^>]*?height:\s*([^;"]+)/g)].map((match) => match[1])).toEqual([
      "18rem",
      "18rem",
    ]);
  });

  test("a sparkline keeps a low frame", () => {
    expect(render({ kind: "sparkline", title: "Trend", data: [1, 3, 2] })).toMatch(/k2b-chart-explorer__viewport[^>]*height:\s*8rem/);
  });
  test("a group draws every chart under one heading, and named series get an HTML legend instead of the SVG row", () => {
    const days = (offset: number) => Array.from({ length: 5 }, (_, i) => ({ x: `2026-01-0${i + 1}`, y: offset + i }));
    const html = render({
      title: "Revenue and margin",
      subtitle: "Daily, January 2026",
      linkX: true,
      layout: "grid",
      charts: [
        {
          kind: "line",
          title: "Revenue",
          series: [
            { label: "2026", data: days(10) },
            { label: "2025", data: days(8), role: "reference" },
          ],
        },
        { kind: "line", title: "Margin", series: [{ data: days(0.2) }], yAxis: { format: { style: "percent" } } },
      ],
    });
    expect(html).toContain("Revenue and margin");
    // Screen-reader heading navigation nests the charts under the group.
    expect(html.match(/<h3\b/g)).toHaveLength(1);
    expect(html.match(/<h4\b[^>]*>Revenue<\/h4>|<h4\b[^>]*>Margin<\/h4>/g)).toHaveLength(2);
    expect(html).toContain("@2xl:grid-cols-2");
    expect(html.match(/data-chart-kind="line"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Legend"');
    expect(html).not.toContain('class="stdlib-chart-legend');
    // The comparison series is dashed in the chart and its legend; a line draws no hollow marks.
    expect(html).toContain('data-style="dashed"');
    expect(html).toContain('stroke-dasharray="6 4"');
    expect(html).not.toContain('data-chart-reference="true"');
    expect(html).toContain("20%");
  });

  test("new kinds draw in the chat frame", () => {
    for (const args of [
      { kind: "boxplot", title: "Prices", data: [{ label: "North", values: [1, 2, 3, 9] }] },
      { kind: "heatmap", title: "Load", data: [{ x: "Mon", y: "AM", value: 3 }] },
      { kind: "barGauge", title: "Quota", data: [{ label: "Disk", value: 40 }], thresholds: [{ value: 80 }] },
      { kind: "stat", title: "Orders", value: 1284, delta: 12, better: "up", sparkline: [1, 3, 2] },
    ])
      expect(render(args)).toContain(`data-chart-kind="${args.kind}"`);
    expect(render({ kind: "stat", title: "Orders", value: 1 })).toMatch(/k2b-chart-explorer__viewport[^>]*height:\s*10rem/);
  });
});
