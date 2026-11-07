import { map } from "./map";
import {
  bar,
  barGauge,
  boxplot,
  donut,
  gauge,
  heatmap,
  histogram,
  line,
  pie,
  scatter,
  sparkline,
  stat,
  stateTimeline,
} from "./svg-renderers";

export { map } from "./map";
export * from "./svg-renderers";

export const charts = {
  scatter,
  line,
  bar,
  pie,
  donut,
  sparkline,
  histogram,
  boxplot,
  gauge,
  barGauge,
  stat,
  heatmap,
  map,
  stateTimeline,
} as const;
