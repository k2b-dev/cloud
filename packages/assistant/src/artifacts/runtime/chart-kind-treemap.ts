import { renderTreemapSvg } from "@k2b/ui/charts/core";
import type { ChartDrawing, RareChart } from "./chart-renderer-types";

export const treemap = (mapped: Extract<RareChart, { kind: "treemap" }>, common: ChartDrawing): string => {
  return renderTreemapSvg({ ...mapped, ...common, displayWidth: common.width });
};
