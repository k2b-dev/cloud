export { aiQuotas, AiQuotaError } from "./quotas";
/** Server-only AI administration and usage accounting. */

export { type AiModelAccessDraft, type AiModelAccessMap, type AiModelAccessState, aiModelAccess } from "./model-access";
export {
  AI_USAGE_RANGES,
  type AiUsageBackgroundTask,
  type AiUsageFeedback,
  type AiUsageGroup,
  type AiUsageLaunch,
  type AiUsageModel,
  type AiUsageOverview,
  type AiUsagePage,
  type AiUsagePagination,
  type AiUsagePoint,
  type AiUsageRange,
  type AiUsageReport,
  type AiUsageReportOptions,
  type AiUsageRun,
  type AiUsageStats,
  type AiUsageUser,
  aiUsage,
} from "./usage";

import { COMPACTION_OUTPUT_CONTRACT, DEFAULT_COMPACTION_PROMPT } from "./compaction";
import { ENRICH_OUTPUT_CONTRACT, ENRICH_SYSTEM_PROMPT } from "./enrich";
import {
  MEMORY_LEARNING_OUTPUT_CONTRACT,
  MEMORY_LEARNING_PROMPT,
  WORKFLOW_PATTERN_OUTPUT_CONTRACT,
  WORKFLOW_PATTERN_PROMPT,
} from "./memory-learning";
import { buildAiTaskPrompt } from "./task-prompt";

/** Built-in task instructions for the admin viewer; excludes organization guidance and runtime input. */
export const AI_BACKGROUND_TASK_PROMPTS = {
  "ai.chat_enrichment_instructions": [
    buildAiTaskPrompt({ baseInstructions: ENRICH_SYSTEM_PROMPT, outputContract: ENRICH_OUTPUT_CONTRACT }),
  ],
  "ai.memory_learning_instructions": [
    buildAiTaskPrompt({ baseInstructions: MEMORY_LEARNING_PROMPT, outputContract: MEMORY_LEARNING_OUTPUT_CONTRACT }),
    buildAiTaskPrompt({ baseInstructions: WORKFLOW_PATTERN_PROMPT, outputContract: WORKFLOW_PATTERN_OUTPUT_CONTRACT }),
  ],
  "ai.compaction_instructions": [
    buildAiTaskPrompt({ baseInstructions: DEFAULT_COMPACTION_PROMPT, outputContract: COMPACTION_OUTPUT_CONTRACT }),
  ],
};
