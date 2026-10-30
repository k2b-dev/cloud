import { CLOUD_AI_CHART_MAX_SERIES, CLOUD_AI_CHART_MAX_VALUES, chartDrawingIssue, cloudAiChartSchema } from "@k2b/cloud/ai/browser";
import type { MarkdownChartOptions } from "@k2b/editor/markdown/lib/chart-blocks";
import { QUERY_MAX_BLOCKS } from "./query-blocks";
export const CHART_MAX_BLOCKS = QUERY_MAX_BLOCKS;
export const notebookChartOptions: MarkdownChartOptions = {
  maxBlocks: CHART_MAX_BLOCKS,
  maxSeries: CLOUD_AI_CHART_MAX_SERIES,
  maxValues: CLOUD_AI_CHART_MAX_VALUES,
  schema: cloudAiChartSchema(),
  drawingIssue: chartDrawingIssue,
};
