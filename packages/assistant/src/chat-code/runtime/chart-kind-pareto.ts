import { renderParetoSvg } from "@k2b/ui/charts/core";
import type { ChartDrawing, RareChart } from "./chart-renderer-types";

export const pareto = (mapped: Extract<RareChart, { kind: "pareto" }>, common: ChartDrawing): string => {
  return renderParetoSvg({ ...mapped, ...common, displayWidth: common.width });
};
