import { renderBalanceFlowHtml } from "@k2b/ui/charts/core";
import type { ChartDrawing, RareChart } from "./chart-renderer-types";

export const balanceFlow = (mapped: Extract<RareChart, { kind: "balanceFlow" }>, common: ChartDrawing): string =>
  renderBalanceFlowHtml({ ...mapped, ...common, displayWidth: common.width });
