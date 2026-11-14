import { barGauge as drawBarGauge } from "@k2b/ui/charts/core";
import type { ChartDrawing, RareChart } from "./chart-renderer-types";

export const barGauge = (mapped: Extract<RareChart, { kind: "barGauge" }>, common: ChartDrawing): string => {
  return drawBarGauge({ ...mapped, ...common });
};
