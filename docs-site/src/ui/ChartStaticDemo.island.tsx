import { Button, ChartExplorer, ChartExplorerControls, type ChartExplorerSnapshot, createChartExplorer } from "@k2b/ui";
import { Show } from "solid-js";
import { comparisonValues, signed } from "./chart-group-demo-model";
import { type QueueCharts, queueSeries, staticQueueSteps } from "./chart-local-data";
import { DemoCard } from "./DemoCard";
export default function ChartStaticDemo(props: {
  initial: ChartExplorerSnapshot<QueueCharts>;
  snapshots: readonly ChartExplorerSnapshot<QueueCharts>[];
}) {
  const explorer = createChartExplorer({
    snapshot: () => props.initial,
    load: (request) => {
      const found = props.snapshots.find(
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
      id="chart-static"
      chip={{ kind: "component", name: "ChartExplorer", from: "@k2b/ui" }}
      description="Static report: seven time steps with 224 server-prepared snapshots. Changing filters only selects an embedded snapshot; no data endpoint or browser rendering is needed."
      code={
        "const explorer = createChartExplorer({ snapshot: () => initial, load: findPreparedSnapshot });\n<ChartExplorer data={explorer.snapshot().charts.queues} columns={columns} />"
      }
    >
      <ChartExplorerControls
        explorer={explorer}
        title="Prepared queue report"
        steps={staticQueueSteps}
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
