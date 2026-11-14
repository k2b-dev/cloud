import { boxplot as drawBoxplot } from "@k2b/ui/charts/core";
import type { ChartDrawing, RareChart } from "./chart-renderer-types";

export const boxplot = (mapped: Extract<RareChart, { kind: "boxplot" }>, common: ChartDrawing): string => {
  return drawBoxplot({ ...mapped, ...common });
};
