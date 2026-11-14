import { renderFunnelLayoutSvg } from "@k2b/ui/charts/core";
import type { ChartDrawing, RareChart } from "./chart-renderer-types";

export const funnel = (mapped: Extract<RareChart, { kind: "funnel" }>, common: ChartDrawing): string => {
  if (!common.funnel) throw new Error("Missing funnel layout");
  return renderFunnelLayoutSvg({ ...mapped, ...common }, common.funnel);
};
