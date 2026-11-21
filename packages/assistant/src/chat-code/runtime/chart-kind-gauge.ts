import { gauge as drawGauge } from "@k2b/ui/charts/core";
import type { ChartDrawing, RareChart } from "./chart-renderer-types";

export const gauge = (mapped: Extract<RareChart, { kind: "gauge" }>, common: ChartDrawing): string => {
  return drawGauge({ ...mapped, ...common });
};
