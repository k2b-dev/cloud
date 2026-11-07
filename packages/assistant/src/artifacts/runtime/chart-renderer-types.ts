import type { cloudAiChartRenderOptions } from "@k2b/cloud/ai/app-frame";

export type MappedChart = ReturnType<typeof cloudAiChartRenderOptions>;
export type ChartDrawing = { width: number; height: number; title?: string; subtitle?: string; inspect: true };
export type RareChart = Exclude<MappedChart, { kind: "bar" | "pie" | "donut" | "stat" | "sparkline" }>;
export type RareChartRenderer = (mapped: RareChart, common: ChartDrawing, locale?: string) => string;
