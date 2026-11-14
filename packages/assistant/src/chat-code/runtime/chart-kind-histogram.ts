import { histogram as drawHistogram } from "@k2b/ui/charts/core";
import type { ChartDrawing, RareChart } from "./chart-renderer-types";

export const histogram = (mapped: Extract<RareChart, { kind: "histogram" }>, common: ChartDrawing): string => {
  return drawHistogram({ ...mapped, ...common });
};
