import { renderHeatmapSvg } from "@k2b/ui/charts/core";
import type { ChartDrawing, RareChart } from "./chart-renderer-types";

export const heatmap = (mapped: Extract<RareChart, { kind: "heatmap" }>, common: ChartDrawing): string => {
  return renderHeatmapSvg({ ...mapped, ...common });
};
