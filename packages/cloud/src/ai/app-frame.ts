// The chart, view and task contracts that an HTML app frame draws and checks. Its prelude is inlined in every app
// document, so it imports this entry instead of `./browser`, whose schemas and skill parser (with YAML) it never uses.

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
