/** Portable chart contracts. This entry never imports Solid or browser APIs. */

export {
  type BarChartLayout,
  type BarChartOptions,
  barChartLayout,
  rankedBarLayout,
  renderBarChartSvg,
  seriesBarLayout,
} from "../../content/chart-bar";
export {
  renderStateTimelineSvg,
  type StateTimelineChartOptions,
  type StateTimelineDomain,
  stateTimelineDomain,
  stateTimelineHeight,
} from "../../content/chart-state-timeline";
export { type ChartTimeAxis } from "../../content/chart-time-axis";
export { type AreaOptions, areaLayout, renderAreaSvg } from "./area";
export * from "./bubble";
export * from "./calendar";
export { type FunnelLayout, type FunnelOptions, funnelLayout, renderFunnelLayoutSvg, renderFunnelSvg } from "./funnel";
export { type HorizontalBarLayout, type HorizontalBarOptions, hbarLayout, renderHbarLayoutSvg, renderHbarSvg } from "./hbar";
export * from "./inspection";
export { map } from "./map";
export * from "./pareto";

export * from "./radar";
export * from "./render";
export { chartRenderHeight, preservesAspectRatio } from "./render-size";
export * from "./snapshot";
export { charts } from "./svg";
export {
  type AxisOptions,
  arcPathD,
  autoBin,
  type BarItem,
  bar,
  barGauge,
  boxplot,
  type ChartOptions,
  chartDatumSvg,
  computeBoxStats,
  computeDomain,
  donut,
  escapeXml,
  extendDomainToNice,
  gauge,
  heatmap,
  histogram,
  type LineStyle,
  line,
  linearRegression,
  linePathD,
  type MapOptions,
  type MapPoint,
  type MapSeries,
  type MapViewport,
  type MarkerShape,
  mapLog,
  mapRange,
  markerPath,
  niceLogTicks,
  niceStep,
  normalizePadding,
  type Padding,
  type Point,
  pie,
  type ReferenceLine,
  type Series,
  type SliceItem,
  scatter,
  smoothPathD,
  sparkline,
  stat,
  stateTimeline,
  stepPathD,
  svgRoot,
} from "./svg-renderers";
export * from "./treemap";
export {
  type ChartDateFormat,
  type ChartDatum,
  type ChartDatumRole,
  type ChartFormat,
  type ChartKind,
  type ChartNumberFormat,
  chartDatumRoles,
} from "./types";

export { renderWaterfallLayoutSvg, renderWaterfallSvg, type WaterfallLayout, type WaterfallOptions, waterfallLayout } from "./waterfall";
