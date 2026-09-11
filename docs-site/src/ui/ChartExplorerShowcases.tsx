import ChartGroupDemo from "./ChartGroupDemo.island";
import ChartLocalDemo from "./ChartLocalDemo.island";
import { explorerSteps, explorerSeries } from "./chart-explorer-data";
import { linkedChartSnapshot } from "./chart-group-data";
import { chartRequestFromSearch } from "./chart-group-url";
import { queueInitial, queueSnapshot, staticQueueSnapshots } from "./chart-local-data";
export function ChartExplorerShowcases(props: { search?: string }) {
  return (
    <>
      <ChartGroupDemo snapshot={linkedChartSnapshot(chartRequestFromSearch(props.search))} steps={explorerSteps} legend={explorerSeries} />
      <ChartLocalDemo mode="client" initial={queueSnapshot(queueInitial)} />
      <ChartLocalDemo mode="static" initial={queueSnapshot(queueInitial)} snapshots={staticQueueSnapshots()} />
    </>
  );
}
