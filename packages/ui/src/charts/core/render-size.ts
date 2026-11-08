import { barChartLayout } from "../../content/chart-bar";
import { stateTimelineHeight } from "../../content/chart-state-timeline";
import { hbarLayout } from "./hbar";
import type { ChartRenderOptions } from "./render";
import { sankeyFrame } from "./sankey-size";
import { renderHeader } from "./svg-renderers";
import type { ChartKind } from "./types";

/** Standard logical height, or compact bar-gauge rows for a host without an explicit height. */
export const chartRenderHeight = (props: ChartRenderOptions, sizing: { contentHeight?: boolean } = {}): number => {
  if (props.kind === "sankey") return sankeyFrame(props).height;
  if (props.kind === "stateTimeline") return stateTimelineHeight(props.rows.length, props.legend !== false);
  if (props.kind === "pareto") return Math.max(280, props.data.length * 34 + renderHeader(480, props.title, props.subtitle).height + 72);
  if (props.kind === "bar") return barChartLayout(props).height;
  if (props.kind === "hbar") return hbarLayout(props).height;
  if (props.kind === "barGauge")
    return Math.max(sizing.contentHeight ? 80 : 280, (props.title || props.subtitle ? 42 : 16) + props.data.length * 28 + 14);
  return 280;
};

export const preservesAspectRatio = (kind: ChartKind) =>
  kind === "map" || kind === "pie" || kind === "donut" || kind === "gauge" || kind === "radar";
