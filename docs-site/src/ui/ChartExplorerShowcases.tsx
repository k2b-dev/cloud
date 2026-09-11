import ChartExplorerDemo from "./ChartExplorerDemo.island";
import { explorerSnapshots, explorerSteps, explorerSeries, queueSeries } from "./chart-explorer-data";

export function ChartExplorerShowcases() {
  return (
    <div class="ui-demo-grid">
      <ChartExplorerDemo kind="scatter" snapshots={explorerSnapshots("scatter")} steps={explorerSteps} legend={explorerSeries} />
      <ChartExplorerDemo kind="bar" snapshots={explorerSnapshots("bar")} steps={explorerSteps} legend={queueSeries} />
    </div>
  );
}
