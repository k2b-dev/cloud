// Lightweight chart, view and text-AI contracts for the chat runner SDK, without the full browser entrypoint.

// Self-contained BalanceFlow frames map and format inside their lazy asset.
export {
  chartBaseRenderOptions as cloudAiBaseChartRenderOptions,
  chartBaseRows as cloudAiBaseChartRows,
} from "@k2b/editor/charts";
export {
  type CloudAiChartTable,
  cloudAiChartMarkKey,
  cloudAiChartRenderOptions,
  cloudAiChartRows,
  cloudAiChartTooltip,
} from "./chart-block";
export { type CloudAiChartInput, type CloudAiFormat, type CloudAiNumberFormat, cloudAiAppChartSchema } from "./default-tool-contracts";
export { type AiTaskRequestInput, AiTaskRequestSchema } from "./task-contracts";
export { CloudAiViewSummarySchema } from "./view-block";
