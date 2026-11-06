/**
 * Chart components and renderer contracts. Use `@k2b/ui/charts/core` for Solid-free SVG work.
 */

export * from "./charts/core";
export type { ChartKindProps, ChartLabels, ChartProps, ChartRenderOptions } from "./content/Chart";
export { default as Chart } from "./content/Chart";
export { type BarChartLayout, type BarChartOptions, barChartLayout, renderBarChartSvg } from "./content/chart-bar";
