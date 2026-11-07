/**
 * Drawing helpers and portable chart contracts. Import the Solid Chart component from `@k2b/ui`.
 */

export * from "./charts/core";
export type { ChartKindProps, ChartLabels, ChartProps, ChartRenderOptions } from "./content/Chart";
export { type BarChartLayout, type BarChartOptions, barChartLayout, renderBarChartSvg } from "./content/chart-bar";

export { calendarInspectionNavigation, mountCalendarScroll } from "./content/chart-calendar";
