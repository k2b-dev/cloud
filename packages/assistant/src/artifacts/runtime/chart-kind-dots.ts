import { renderDotMatrixLayoutSvg } from "@k2b/ui/charts/core";
import type { ChartDrawing, RareChart } from "./chart-renderer-types";

export const dots = (mapped: Extract<RareChart, { kind: "dots" }>, common: ChartDrawing): string => {
  if (!common.dotLayout) throw new Error("Missing dot matrix layout");
  return renderDotMatrixLayoutSvg({ ...mapped, ...common }, common.dotLayout);
};
