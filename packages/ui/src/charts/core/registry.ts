import { renderBarChartSvg } from "../../content/chart-bar";
import { renderStateTimelineSvg } from "../../content/chart-state-timeline";
import { renderAreaSvg } from "./area";
import { renderBubbleSvg } from "./bubble";
import { renderHeatmapSvg } from "./calendar";
import { renderFunnelSvg } from "./funnel";
import { renderHbarSvg } from "./hbar";
import { map } from "./map";
import { renderParetoSvg } from "./pareto";

import { renderRadarSvg } from "./radar";
import { barGauge, boxplot, donut, gauge, histogram, line, pie, scatter, sparkline, stat } from "./svg-renderers";
import { renderTreemapSvg } from "./treemap";
import { renderWaterfallSvg } from "./waterfall";

// Add one renderer here: its key defines the discriminator, ChartKind and the capitalized Chart namespace member.
// Keep kind-specific adaptations in renderChartSvg and add a fixture to the namespace parity test.
const createChartRenderers = () => ({
  waterfall: renderWaterfallSvg,
  area: renderAreaSvg,
  line: line,
  bar: renderBarChartSvg,
  hbar: renderHbarSvg,
  funnel: renderFunnelSvg,
  pie: pie,
  donut: donut,
  scatter: scatter,
  sparkline: sparkline,
  histogram: histogram,
  boxplot: boxplot,
  gauge: gauge,
  barGauge: barGauge,
  stat: stat,
  heatmap: renderHeatmapSvg,
  map: map,
  stateTimeline: renderStateTimelineSvg,
  treemap: renderTreemapSvg,
  pareto: renderParetoSvg,

  bubble: renderBubbleSvg,
  radar: renderRadarSvg,
});
export const chartRenderers = /* @__PURE__ */ createChartRenderers();
type Kind = keyof typeof chartRenderers;
type ChartKinds = { [K in Kind as Capitalize<K>]: K };
// Object.entries loses literal keys; names are constructed from those same keys here.
const kinds = () =>
  Object.fromEntries(Object.keys(chartRenderers).map((kind) => [kind[0]!.toUpperCase() + kind.slice(1), kind])) as ChartKinds;
export const chartKinds = /* @__PURE__ */ kinds();
