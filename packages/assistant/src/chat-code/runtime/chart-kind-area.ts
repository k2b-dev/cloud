import { renderAreaSvg } from "@k2b/ui/charts/core";
import type { ChartDrawing, RareChart } from "./chart-renderer-types";

export const area = (mapped: Extract<RareChart, { kind: "area" }>, common: ChartDrawing): string => {
  return renderAreaSvg({ ...mapped, ...common });
};
