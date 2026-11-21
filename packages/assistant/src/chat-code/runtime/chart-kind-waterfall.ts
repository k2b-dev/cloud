import { renderWaterfallLayoutSvg } from "@k2b/ui/charts/core";
import type { ChartDrawing, RareChart } from "./chart-renderer-types";

export const waterfall = (mapped: Extract<RareChart, { kind: "waterfall" }>, common: ChartDrawing): string => {
  if (!common.waterfall) throw new Error("Missing waterfall layout");
  return renderWaterfallLayoutSvg({ ...mapped, ...common }, common.waterfall);
};
