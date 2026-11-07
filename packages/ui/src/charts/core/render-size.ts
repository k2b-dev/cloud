import { barChartLayout } from "../../content/chart-bar";
import { stateTimelineHeight } from "../../content/chart-state-timeline";
import type { ChartRenderOptions } from "./render";
import { sankeyFrame } from "./sankey-size";
import type { ChartKind } from "./types";

/** Keep the fixed 28-unit bar-gauge rows inside the shared SSR/browser coordinate space. */
export const chartRenderHeight = (props: ChartRenderOptions): number => {
  if (props.kind === "sankey") return sankeyFrame(props).height;
  if (props.kind === "stateTimeline") return stateTimelineHeight(props.rows.length, props.legend !== false);
  if (props.kind === "bar") return barChartLayout(props).height;
  if (props.kind === "barGauge") return Math.max(280, (props.title || props.subtitle ? 42 : 16) + props.data.length * 28 + 14);
  return 280;
};

export const preservesAspectRatio = (kind: ChartKind) => kind === "map" || kind === "pie" || kind === "donut" || kind === "gauge";
