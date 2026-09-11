import { Show } from "solid-js";
import { Button, ChartExplorer, ChartExplorerControls, createChartExplorer, type ChartExplorerSnapshot } from "@k2b/ui";
import { queueSnapshot, queueSteps, staticQueueSteps, queueSeries, type QueueCharts } from "./chart-local-data";
import { comparisonValues, signed } from "./chart-group-demo-model";
import { DemoCard } from "./DemoCard";
export default function ChartLocalDemo(props: {
  mode: "client" | "static";
  initial: ChartExplorerSnapshot<QueueCharts>;
  snapshots?: readonly ChartExplorerSnapshot<QueueCharts>[];
}) {
  const explorer = createChartExplorer({
    snapshot: () => props.initial,
    load: (request) => {
      if (props.mode === "client") return queueSnapshot(request);
      const found = props.snapshots?.find(
        (item) =>
          item.request.step === request.step &&
          item.request.referenceStep === request.referenceStep &&
          item.request.visibleKeys?.length === request.visibleKeys?.length &&
          request.visibleKeys?.every((key) => item.request.visibleKeys?.includes(key)),
      );
      if (!found) throw new Error("No prepared snapshot for these filters");
      return found;
    },
  });
  const reference = (row: QueueCharts["queues"]["rows"][number]) => {
    const diff = comparisonValues(row.current, row.reference);
    return `Ref: ${row.reference}${diff.percent === null ? "" : ` · ${signed(diff.percent)}%`}`;
  };
  return (
    <DemoCard
      id={props.mode === "client" ? "chart-single" : "chart-static"}
      chip={{ kind: "component", name: "ChartExplorer", from: "@k2b/ui" }}
      description={
        props.mode === "client"
          ? "Client-side dashboard: one chart with a local synchronous data builder. Filter and reference changes generate SVG in the browser without HTTP requests."
          : "Static report: one chart with 24 server-prepared snapshots. Changing filters only selects an embedded snapshot; no data endpoint or browser rendering is needed."
      }
      code={
        props.mode === "client"
          ? "const initial = queueSnapshot(filters);\nconst explorer = createChartExplorer({ snapshot: () => initial, load: queueSnapshot });\n<ChartExplorer data={explorer.snapshot().charts.queues} columns={columns} />"
          : "const explorer = createChartExplorer({ snapshot: () => initial, load: findPreparedSnapshot });\n<ChartExplorer data={explorer.snapshot().charts.queues} columns={columns} />"
      }
    >
      <ChartExplorerControls
        explorer={explorer}
        title={props.mode === "client" ? "Local queue dashboard" : "Prepared queue report"}
        steps={props.mode === "static" ? staticQueueSteps : queueSteps}
        series={queueSeries}
        dimensionLabel="Time of day"
      />
      <Button size="sm" variant="text" onClick={() => void explorer.refresh()}>
        Refresh data
      </Button>
      <ChartExplorer
        title="Completed jobs"
        data={explorer.snapshot().charts.queues}
        selectedKey={explorer.selectedKey()}
        onSelectedKeyChange={explorer.select}
        columns={[
          { id: "queue", label: "Queue", value: (row) => row.label, sortValue: (row) => row.label },
          {
            id: "jobs",
            label: "Jobs",
            sortValue: (row) => row.current,
            value: (row) => `${row.current}${row.reference === null ? "" : `\n${reference(row)}`}`,
            render: (row) => (
              <div class="ui-demo-chart-group-cell">
                <span>{row.current}</span>
                <Show when={row.reference !== null}>
                  <small>{reference(row)}</small>
                </Show>
              </div>
            ),
          },
        ]}
      />
    </DemoCard>
  );
}
