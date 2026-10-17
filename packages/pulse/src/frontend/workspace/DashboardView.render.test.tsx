import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { PulseDashboardConfig, PulseDashboardMetricWidget } from "../../contracts";
import type { DashboardRenderContext } from "./DashboardView";
import { formatQueryBucket } from "./date-format";

const root = mkdtempSync(join(tmpdir(), "pulse-workspace-dashboard-render-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { DashboardContent } = await import("./DashboardView");
const dateContext = { locale: "de", timeZone: "Europe/Berlin" };
const bucket = "2026-01-01T13:00:00.000Z";

const render = (visual: PulseDashboardMetricWidget["visual"]) => {
  const config: PulseDashboardConfig = {
    dsl: "",
    layout: {
      version: 1,
      sections: [
        {
          id: "section",
          kind: "section",
          title: "Ops",
          rows: [
            {
              id: "row",
              kind: "row",
              height: "md",
              cells: [
                {
                  id: "metric",
                  kind: "metric",
                  title: "CPU",
                  visual,
                  queryText: "metric cpu avg bucket 1h since 1h",
                  query: { kind: "metric", metric: "cpu", aggregation: "avg", bucket: "1h", since: "1h" },
                },
              ],
            },
          ],
        },
      ],
    },
  };
  const context: DashboardRenderContext = {
    metricWidgetPoints: () => ({
      metric: [
        { bucket, value: 42 },
        { bucket: "2026-01-01T14:00:00.000Z", value: 37.5 },
      ],
    }),
    dashboardEvents: () => ({}),
    dashboardStates: () => ({}),
    dashboardMaps: () => ({}),
    metricByName: () => new Map(),
    sourceNameById: () => new Map(),
    sources: () => [],
    dashboardControlValues: () => ({}),
    dateContext: () => dateContext,
    onControlChange: () => {},
    onOpenPublicDisplay: () => {},
  };
  return renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(DashboardContent, { config: () => config, context });
      },
    }),
  );
};

test("workspace histograms localize the count axis in German", () => {
  const html = render("histogram");
  expect(html).toContain('data-chart-kind="histogram"');
  expect(html).toMatch(/>Anzahl<\/text>/);
  expect(html).not.toContain(">Count<");
});

test("workspace bars and lines preserve visible values and zoned time ticks", () => {
  const bar = render("bar");
  expect(bar).toContain('data-chart-kind="bar"');
  expect(bar).toMatch(/>42<\/text>/);
  expect(bar).toMatch(/>37\.5<\/text>/);
  const line = render("line");
  expect(line).toContain('data-chart-kind="line"');
  const tick = formatQueryBucket("2026-01-01T14:00:00.000Z", "1h", dateContext);
  expect(tick).toBe("15:00");
  expect(line).toContain(`>${tick}</text>`);
});
