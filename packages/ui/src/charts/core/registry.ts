import { renderBarChartSvg } from "../../content/chart-bar";
import { renderStateTimelineSvg } from "../../content/chart-state-timeline";
import { renderAreaSvg } from "./area";
import { renderHeatmapSvg } from "./calendar";
import { renderParetoSvg } from "./pareto";
import { charts } from "./svg";
import { renderTreemapSvg } from "./treemap";

// Add one renderer here: its key defines the discriminator, ChartKind and the capitalized Chart namespace member.
// Keep kind-specific adaptations in renderChartSvg and add a fixture to the namespace parity test.
export const chartRenderers = {
  area: renderAreaSvg,
  line: charts.line,
  bar: renderBarChartSvg,
  pie: charts.pie,
  donut: charts.donut,
  scatter: charts.scatter,
  sparkline: charts.sparkline,
  histogram: charts.histogram,
  boxplot: charts.boxplot,
  gauge: charts.gauge,
  barGauge: charts.barGauge,
  stat: charts.stat,
  heatmap: renderHeatmapSvg,
  map: charts.map,
  stateTimeline: renderStateTimelineSvg,
  treemap: renderTreemapSvg,
  pareto: renderParetoSvg,
};
type Kind = keyof typeof chartRenderers;
type ChartKinds = { [K in Kind as Capitalize<K>]: K };
// Object.entries loses literal keys; names are constructed from those same keys here.
export const chartKinds = Object.fromEntries(
  Object.keys(chartRenderers).map((kind) => [kind[0]!.toUpperCase() + kind.slice(1), kind]),
) as ChartKinds;
