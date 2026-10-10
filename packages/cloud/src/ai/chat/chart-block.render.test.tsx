import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

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

  test("a sparkline keeps a low frame", () => {
    expect(render({ kind: "sparkline", title: "Trend", data: [1, 3, 2] })).toMatch(/k2b-chart-explorer__viewport[^>]*height:\s*8rem/);
  });
});
