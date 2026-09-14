import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { PulseDashboardSnapshot, PulsePublicDashboardMetricWidget } from "../contracts";

const root = mkdtempSync(join(tmpdir(), "pulse-dashboard-render-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { PublicDashboardSections } = await import("./PublicDashboardSections");
const dateContext = { timeZone: "UTC", locale: "en", firstDayOfWeek: 1, now: "2026-01-01T00:05:00.000Z" } as const;
const render = (visual: PulsePublicDashboardMetricWidget["visual"]) => {
  const widget: PulsePublicDashboardMetricWidget = {
    id: "metric",
    kind: "metric",
    title: "Requests",
    metric: "requests",
    visual,
    aggregation: "avg",
    bucket: "1m",
    since: "1h",
  };
  const snapshot: PulseDashboardSnapshot = {
    dashboard: {
      id: "Dash01",
      name: "Ops",
      config: {
        layout: {
          version: 1,
          sections: [{ id: "section", kind: "section", title: "Ops", rows: [{ id: "row", kind: "row", height: "md", cells: [widget] }] }],
        },
      },
    },
    points: {
      metric: [
        { bucket: "2026-01-01T00:00:00.000Z", value: 1 },
        { bucket: "2026-01-01T00:01:00.000Z", value: null },
        { bucket: "2026-01-01T00:02:00.000Z", value: 0 },
        { bucket: "2026-01-01T00:03:00.000Z", value: null },
      ],
    },
    events: {},
    states: {},
    maps: {},
  };
  return renderToString(() => createComponent(PublicDashboardSections, { snapshot, dateContext }));
};
test("line dashboards render with explicit gaps", () => {
  expect(render("line")).toContain("<svg");
});
test("missing latest values never produce zero gauges", () => {
  for (const visual of ["gauge", "barGauge"] as const) {
    const html = render(visual);
    expect(html).toContain("No points yet.");
    expect(html).not.toContain("<svg");
  }
});
