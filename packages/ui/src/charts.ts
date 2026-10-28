/**
 * Pure chart renderers that share the `Chart` component's drawing without its Solid wrapper, for hosts that draw
 * SVG themselves, such as server previews and app frames.
 */
export { type BarChartLayout, type BarChartOptions, barChartLayout, renderBarChartSvg } from "./content/chart-bar";
