import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import type { MetricQueryPoint, PulseDashboardConfig, PulseDashboardSnapshot, PulsePublicDashboardMetricWidget } from "../contracts";
import { PublicDashboardSections } from "./PublicDashboardSections";
import { DashboardContent, type DashboardRenderContext } from "./workspace/DashboardView";

const points: MetricQueryPoint[] = [
  { bucket: "2026-01-01T13:00:00.000Z", value: 42 },
  { bucket: "2026-01-01T14:00:00.000Z", value: 37.5 },
];
const widgets: PulsePublicDashboardMetricWidget[] = (["bar", "line", "histogram"] as const).map((visual) => ({
  id: visual,
  kind: "metric",
  title: "CPU",
  metric: "cpu",
  unit: "%",
  visual,
  aggregation: "avg",
  bucket: "1h",
  since: "1h",
  timeZone: "Europe/Berlin",
}));
const snapshot: PulseDashboardSnapshot = {
  dashboard: {
    id: "Dash01",
    name: "Ops",
    config: {
      layout: {
        version: 1,
        sections: [{ id: "section", kind: "section", title: "Ops", rows: [{ id: "row", kind: "row", height: "md", cells: widgets }] }],
      },
    },
  },
  points: { bar: points, line: points, histogram: points },
  events: {},
  states: {},
  maps: {},
};
const workspaceConfig: PulseDashboardConfig = {
  dsl: "",
  layout: {
    version: 1,
    sections: [
      {
        id: "workspace-section",
        kind: "section",
        title: "Workspace",
        rows: [
          {
            id: "workspace-row",
            kind: "row",
            height: "md",
            cells: [
              {
                id: "bar",
                kind: "metric",
                title: "CPU",
                visual: "bar",
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
  metricWidgetPoints: () => ({ bar: points }),
  dashboardEvents: () => ({}),
  dashboardStates: () => ({}),
  dashboardMaps: () => ({}),
  metricByName: () => new Map([["cpu", { name: "cpu", unit: "%", type: "gauge", seriesCount: 1, lastSeenAt: "2026-01-01T14:00:00.000Z" }]]),
  sourceNameById: () => new Map(),
  sources: () => [],
  dashboardControlValues: () => ({}),
  dateContext: () => ({ locale: "de", timeZone: "Europe/Berlin" }),
  onControlChange: () => {},
  onOpenPublicDisplay: () => {},
};

render(
  () => (
    <LocaleProvider locale="de">
      <main style={{ width: "480px" }}>
        <div id="public">
          <PublicDashboardSections snapshot={snapshot} dateContext={{ locale: "de", timeZone: "UTC" }} />
        </div>
        <div id="workspace">
          <DashboardContent config={() => workspaceConfig} context={context} />
        </div>
      </main>
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
