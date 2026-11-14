import { renderRadarSvg } from "@k2b/ui/charts/core";
import type { ChartDrawing, RareChart } from "./chart-renderer-types";

export const radar = (mapped: Extract<RareChart, { kind: "radar" }>, common: ChartDrawing): string => {
  return renderRadarSvg({ ...mapped, ...common });
};
