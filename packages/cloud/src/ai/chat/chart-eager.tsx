import type { ComponentProps } from "solid-js";
import { CloudChartBlock as Block, CloudChartGroupView as Group, CloudChartView as View } from "./chart-block";
import { CloudExplorerView as Explorer } from "./explorer-block";

// The marker lets the browser retain a server drawing until its code is ready, including history navigation.
export const CloudChartBlock = (props: ComponentProps<typeof Block>) => (
  <div class="contents" data-cloud-chart-drawing>
    <Block {...props} />
  </div>
);
export const CloudChartView = (props: ComponentProps<typeof View>) => (
  <div class="contents" data-cloud-chart-drawing>
    <View {...props} />
  </div>
);
export const CloudChartGroupView = (props: ComponentProps<typeof Group>) => (
  <div class="contents" data-cloud-chart-drawing>
    <Group {...props} />
  </div>
);
export const CloudExplorerView = (props: ComponentProps<typeof Explorer>) => (
  <div class="contents" data-cloud-chart-drawing>
    <Explorer {...props} />
  </div>
);
