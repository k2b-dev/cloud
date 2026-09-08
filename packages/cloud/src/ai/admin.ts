/** Server-only AI administration and usage accounting. */
export {
  type AiUsageRun,
  type AiUsageStats,
  type AiUsageGroup,
  type AiUsagePage,
  AI_USAGE_RANGES,
  type AiUsageBackgroundTask,
  type AiUsageCapability,
  type AiUsageFeedback,
  type AiUsageLaunch,
  type AiUsageModel,
  type AiUsageOverview,
  type AiUsagePoint,
  type AiUsageRange,
  type AiUsagePagination,
  type AiUsageReportOptions,
  type AiUsageReport,
  type AiUsageUser,
  aiUsage,
} from "./usage";

export { type AiModelAccessDraft, type AiModelAccessMap, type AiModelAccessState, aiModelAccess } from "./model-access";

import { ENRICH_SYSTEM_PROMPT, ENRICH_OUTPUT_CONTRACT } from "./enrich";
import {
  MEMORY_LEARNING_PROMPT,
  MEMORY_LEARNING_OUTPUT_CONTRACT,
  WORKFLOW_PATTERN_PROMPT,
  WORKFLOW_PATTERN_OUTPUT_CONTRACT,
} from "./memory-learning";
import { DEFAULT_COMPACTION_PROMPT, COMPACTION_OUTPUT_CONTRACT } from "./compaction";
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
