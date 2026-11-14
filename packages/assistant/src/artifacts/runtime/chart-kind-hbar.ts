import { renderHbarLayoutSvg } from "@k2b/ui/charts/core";
import type { ChartDrawing, RareChart } from "./chart-renderer-types";

export const hbar = (mapped: Extract<RareChart, { kind: "hbar" }>, common: ChartDrawing): string => {
  if (!common.hbar) throw new Error("Missing hbar layout");
  return renderHbarLayoutSvg({ ...mapped, ...common }, common.hbar);
};
