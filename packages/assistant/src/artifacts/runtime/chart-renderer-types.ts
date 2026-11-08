import type { cloudAiChartRenderOptions } from "@k2b/cloud/ai/app-frame";
import type { FunnelLayout, HorizontalBarLayout, WaterfallLayout } from "@k2b/ui/charts/core";

export type MappedChart = ReturnType<typeof cloudAiChartRenderOptions>;
export type ChartDrawing = {
  width: number;
  height: number;
  title?: string;
  subtitle?: string;
  inspect: true;
  funnel?: FunnelLayout;
  hbar?: HorizontalBarLayout;
  waterfall?: WaterfallLayout;
};
export type RareChart = Exclude<MappedChart, { kind: "line" | "pie" | "donut" | "stat" | "sparkline" }>;
export type RareChartRenderer = (mapped: RareChart, common: ChartDrawing) => string;
