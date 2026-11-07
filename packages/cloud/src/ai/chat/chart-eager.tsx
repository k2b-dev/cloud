import type { ComponentProps } from "solid-js";
import { isServer } from "solid-js/web";
import { CloudChartBlock as Block, CloudChartGroupView as Group, CloudChartView as View } from "./chart-block";
import { drawingKey } from "./chart-handoff";
import { CloudExplorerView as Explorer } from "./explorer-block";

// The marker lets the browser retain a server drawing until its code is ready, including history navigation.
export const CloudChartBlock = (props: ComponentProps<typeof Block>) => (
  <cloud-chart-drawing
    class="contents"
    data-cloud-chart-drawing
    data-cloud-chart-server={isServer ? "" : undefined}
    data-cloud-chart-key={drawingKey("Block", props)}
  >
    <Block {...props} />
  </cloud-chart-drawing>
);
export const CloudChartView = (props: ComponentProps<typeof View>) => (
  <cloud-chart-drawing
    class="contents"
    data-cloud-chart-drawing
    data-cloud-chart-server={isServer ? "" : undefined}
    data-cloud-chart-key={drawingKey("View", props)}
  >
    <View {...props} />
  </cloud-chart-drawing>
);
export const CloudChartGroupView = (props: ComponentProps<typeof Group>) => (
  <cloud-chart-drawing
    class="contents"
    data-cloud-chart-drawing
    data-cloud-chart-server={isServer ? "" : undefined}
    data-cloud-chart-key={drawingKey("Group", props)}
  >
    <Group {...props} />
  </cloud-chart-drawing>
);
export const CloudExplorerView = (props: ComponentProps<typeof Explorer>) => (
  <cloud-chart-drawing
    class="contents"
    data-cloud-chart-drawing
    data-cloud-chart-server={isServer ? "" : undefined}
    data-cloud-chart-key={drawingKey("Explorer", props)}
  >
    <Explorer {...props} />
  </cloud-chart-drawing>
);
