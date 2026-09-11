import { Show } from "solid-js";
import { Button, ChartExplorer, ChartExplorerControls, createChartExplorer, type ChartExplorerSnapshot } from "@k2b/ui";
import { deliverySnapshot, deliverySteps, deliverySeries, type DeliveryCharts } from "./chart-map-data";
import { comparisonValues, signed } from "./chart-group-demo-model";
import { DemoCard } from "./DemoCard";
export default function ChartLocalDemo(props: { initial: ChartExplorerSnapshot<DeliveryCharts> }) {
  const explorer = createChartExplorer({ snapshot: () => props.initial, load: deliverySnapshot });
  const reference = (row: DeliveryCharts["deliveries"]["rows"][number]) => {
    const diff = comparisonValues(row.current, row.reference);
    return `Ref: ${row.reference} km${diff.percent === null ? "" : ` · ${signed(diff.percent)}%`}`;
  };
  return (
    <DemoCard
      id="chart-single"
      chip={{ kind: "component", name: "ChartExplorer", from: "@k2b/ui" }}
      description="Synthetic delivery routes across Europe: explore vehicle positions from 08:00 to 20:00. Pin a reference to compare earlier positions. The initial map is server-rendered; subsequent snapshots are computed locally without HTTP requests."
      code={
        "const explorer = createChartExplorer({ snapshot: () => initial, load: deliverySnapshot });\n<ChartExplorer data={explorer.snapshot().charts.deliveries} columns={columns} />"
      }
    >
      <ChartExplorerControls
        explorer={explorer}
        title="Deliveries through the day"
        steps={deliverySteps}
        series={deliverySeries}
        dimensionLabel="Time of day"
      />
      <Button size="sm" variant="text" onClick={() => void explorer.refresh()}>
        Refresh data
      </Button>
      <ChartExplorer
        title="Vehicle positions"
        data={explorer.snapshot().charts.deliveries}
        selectedKey={explorer.selectedKey()}
        onSelectedKeyChange={explorer.select}
        columns={[
          { id: "route", label: "Route", value: (row) => row.label, sortValue: (row) => row.label },
          {
            id: "distance",
            label: "Distance travelled",
            sortValue: (row) => row.current,
            value: (row) => `${row.current} km${row.reference === null ? "" : `\n${reference(row)}`}`,
            render: (row) => (
              <div class="ui-demo-chart-group-cell">
                <span>{row.current} km</span>
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
