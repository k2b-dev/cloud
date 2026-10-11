import ChartGroupDemo from "./ChartGroupDemo.island";
import ChartLocalDemo from "./ChartLocalDemo.island";
import ChartMonitoringDemo from "./ChartMonitoringDemo.island";
import ChartStaticDemo from "./ChartStaticDemo.island";
import ChartViewsDemo from "./ChartViewsDemo.island";
import { explorerSeries, explorerSteps } from "./chart-explorer-data";
import { linkedChartSnapshot } from "./chart-group-data";
import { chartRequestFromSearch } from "./chart-group-url";
import { queueInitial, queueSnapshot, staticQueueSnapshots } from "./chart-local-data";
import { deliveryInitial, deliverySnapshot } from "./chart-map-data";
import { orderInitial, orderSnapshot } from "./chart-views-data";
export function ChartExplorerShowcases(props: { search?: string }) {
  return (
    <>
      <ChartMonitoringDemo />
      <ChartGroupDemo snapshot={linkedChartSnapshot(chartRequestFromSearch(props.search))} steps={explorerSteps} legend={explorerSeries} />
      <ChartLocalDemo initial={deliverySnapshot(deliveryInitial)} />
      <ChartViewsDemo initial={orderSnapshot(orderInitial)} />
      <ChartStaticDemo initial={queueSnapshot(queueInitial)} snapshots={staticQueueSnapshots()} />
    </>
  );
}
