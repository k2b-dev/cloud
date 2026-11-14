import { scatter as drawScatter } from "@k2b/ui/charts/core";
import type { ChartDrawing, RareChart } from "./chart-renderer-types";

export const scatter = (mapped: Extract<RareChart, { kind: "scatter" }>, common: ChartDrawing): string => {
  return drawScatter({ ...mapped, ...common });
};
