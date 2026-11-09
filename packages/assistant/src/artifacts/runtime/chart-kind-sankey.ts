import { renderSankeySvg } from "@k2b/ui/charts/core";
import type { ChartDrawing, RareChart } from "./chart-renderer-types";

export const sankey = (mapped: Extract<RareChart, { kind: "sankey" }>, common: ChartDrawing): string =>
  renderSankeySvg({ ...mapped, ...common, displayWidth: common.width });
