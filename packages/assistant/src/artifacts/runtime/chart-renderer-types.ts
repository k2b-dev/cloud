import type { CloudAiChartInput, cloudAiChartRenderOptions } from "@k2b/cloud/ai/app-frame";
import type { mountBalanceFlowController } from "@k2b/ui/charts";
import type { balanceFlowRenderOptions, FunnelLayout, HorizontalBarLayout, WaterfallLayout } from "@k2b/ui/charts/core";

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
  balanceFlow?: {
    input: Extract<CloudAiChartInput, { kind: "balanceFlow" }>;
    formats: NonNullable<Parameters<typeof balanceFlowRenderOptions>[2]>["formats"];
  };
};
export type RareChart = Exclude<MappedChart, { kind: "bar" | "pie" | "donut" | "stat" | "sparkline" }>;
export type RareChartRenderer = (mapped: RareChart, common: ChartDrawing, locale?: string) => string;
export type ChartInteraction = typeof mountBalanceFlowController;
