import { renderBubbleSvg } from "@k2b/ui/charts/core";
import type { ChartDrawing, RareChart } from "./chart-renderer-types";

export const bubble = (mapped: Extract<RareChart, { kind: "bubble" }>, common: ChartDrawing): string => {
  return renderBubbleSvg({ ...mapped, ...common });
};
