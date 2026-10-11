import { ChartExplorer, type ChartExplorerSnapshot, ChartFilterControls, createChartExplorer } from "@k2b/ui";
import { createSignal } from "solid-js";
import { type OrderCharts, type OrderRow, orderLegend, orderRegions, orderSnapshot, orderSteps, orderViews } from "./chart-views-data";
import { DemoCard } from "./DemoCard";

export default function ChartViewsDemo(props: { initial: ChartExplorerSnapshot<OrderCharts> }) {
  const explorer = createChartExplorer({ snapshot: () => props.initial, load: orderSnapshot });
  const [chart, setChart] = createSignal<"orders" | "basket">("orders");
  const [view, setView] = createSignal<"chart" | "table">("chart");
  const request = () => explorer.desired();
  return (
    <DemoCard
      id="chart-views"
      chip={{ kind: "component", name: "ChartExplorer", from: "@k2b/ui" }}
      description="One dataset, several charts: the switcher lists both charts and the table, the filters above them apply to all three, and a selected row stays selected across them. Pin a year, then move the slider to compare. The table shows at most 24 rows; Copy data copies all of them."
      code={
        '<ChartExplorer charts={views} chart={chart()} onChartChange={setChart} view={view()} onViewChange={setView}\n  data={explorer.snapshot().charts[view() === "table" ? "table" : chart()]} tableRows={24}\n  controls={<ChartFilterControls request={explorer.desired()} displayedRequest={explorer.snapshot().request} steps={steps} series={regions} compare onRequest={explorer.setRequest} />} />'
      }
    >
      <ChartExplorer<OrderRow>
        title="Orders by region"
        description={<span>Synthetic monthly orders, two years</span>}
        charts={orderViews}
        chart={chart()}
        onChartChange={(id) => setChart(id === "basket" ? "basket" : "orders")}
        view={view()}
        onViewChange={setView}
        data={explorer.snapshot().charts[view() === "table" ? "table" : chart()]}
        legend={orderLegend(explorer.snapshot().request)}
        selectedKey={explorer.selectedKey()}
        onSelectedKeyChange={explorer.select}
        tableRows={24}
        renderDetails={false}
        controls={
          <ChartFilterControls
            request={request()}
            displayedRequest={explorer.snapshot().request}
            steps={orderSteps}
            series={orderRegions}
            dimensionLabel="Year"
            compare
            onRequest={explorer.setRequest}
          />
        }
        columns={[
          { id: "region", label: "Region", value: (row) => row.region, sortValue: (row) => row.region },
          { id: "year", label: "Year", value: (row) => row.year, sortValue: (row) => row.year },
          { id: "month", label: "Month", value: (row) => String(row.month), sortValue: (row) => row.month, align: "right" },
          { id: "orders", label: "Orders", value: (row) => String(row.orders), sortValue: (row) => row.orders, align: "right" },
          { id: "basket", label: "Average basket", value: (row) => `€${row.basket}`, sortValue: (row) => row.basket, align: "right" },
        ]}
      />
    </DemoCard>
  );
}
