import { Chart, LocaleProvider } from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";
import { CloudChartBlock } from "../../cloud/src/ai/chat/chart-block";
import AiUsageCharts from "../../core/src/pages/admin/settings/_components/AiUsageCharts";
import { chartKinds } from "../../editor/src/charts";
import { renderNotebookChartFigure } from "../../editor/src/markdown/lib/chart-blocks";
import { enhanceNotebookCharts } from "../../editor/src/markdown/notebook-charts";
import ObservabilityChart from "../../gateway-ops/src/frontend/ObservabilityChart.island";
import { sqlResultChart } from "../../pulse/src/frontend/workspace/sql-result-chart";
import { lineForecastFixture } from "./line-forecast-fixture";

const portable = {
  ...lineForecastFixture,
  kind: "line",
  title: "Studio cash outlook",
  format: { style: "currency", currency: "EUR", decimals: 0 },
};
const sql = sqlResultChart(
  {
    columns: [
      { name: "day", type: "Date" },
      { name: "Orders", type: "UInt32" },
      { name: "Returns", type: "UInt32" },
    ],
    rows: [
      ["2026-10-01", 12, 1],
      ["2026-10-02", 18, 2],
      ["2026-10-03", 24, 3],
    ],
  },
  "de",
);
const timeline = [
  { bucket: "2026-10-01T00:00:00Z", turns: 12, failed: 1, tokens: 1200, cost: 0.12 },
  { bucket: "2026-10-02T00:00:00Z", turns: 18, failed: 2, tokens: 1800, cost: 0.18 },
  { bucket: "2026-10-03T00:00:00Z", turns: 24, failed: 3, tokens: 2400, cost: 0.24 },
];

/** Actual consumer adapters with fictional data; no application server or database. */
export function LineHostFixtures() {
  let notebook: HTMLElement | undefined;
  onMount(() => {
    if (notebook) onCleanup(enhanceNotebookCharts(notebook, "de", { schema: chartKinds() }));
  });
  return (
    <LocaleProvider locale="de">
      <section class="line-forecast-panel" data-line-host="pulse">
        <h2>Pulse · SQL result</h2>
        {sql.kind === "chart" && <Chart {...sql.chart} legendPlacement="top-start" style={{ height: "230px" }} />}
      </section>
      <section class="line-forecast-panel" data-line-host="core">
        <h2>Core · AI usage</h2>
        <AiUsageCharts timeline={timeline} range="7d" unit="EUR" />
      </section>
      <section class="line-forecast-panel" data-line-host="gateway">
        <h2>Gateway Ops · Network traffic</h2>
        <ObservabilityChart
          kind="line"
          legend
          yFormat="bytes"
          series={[
            {
              label: "Received",
              data: [
                { x: 1, y: 1024 },
                { x: 2, y: 2048 },
              ],
            },
            {
              label: "Sent",
              data: [
                { x: 1, y: 4096 },
                { x: 2, y: 8192 },
              ],
            },
          ]}
        />
      </section>
      <section class="line-forecast-panel" data-line-host="chat">
        <h2>Chat · Chart tool</h2>
        <CloudChartBlock args={portable} completed />
      </section>
      <section
        class="line-forecast-panel notebook-book-content"
        data-line-host="notebook"
        ref={notebook}
        innerHTML={renderNotebookChartFigure(chartKinds().parse(portable), "de") ?? ""}
      />
    </LocaleProvider>
  );
}
