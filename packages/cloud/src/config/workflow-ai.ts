import { z } from "zod";

export const workflowAiBudgetSchema = z
  .object({
    maxStepsPerSource: z.number().int().positive(),
    tasksPerMinute: z.number().int().positive(),
    burst: z.number().int().positive(),
    sourcesPer24Hours: z.number().int().positive(),
    scopeConcurrent: z.number().int().positive(),
    globalConcurrent: z.number().int().positive(),
  })
  .strict();
export const DEFAULT_WORKFLOW_AI_BUDGET = {
  maxStepsPerSource: 2,
  tasksPerMinute: 10,
  burst: 20,
  sourcesPer24Hours: 2_000,
  scopeConcurrent: 1,
  globalConcurrent: 4,
};
export const validateWorkflowAiBudget = (value: unknown): string | undefined => {
  try {
    if (typeof value === "string" && workflowAiBudgetSchema.safeParse(JSON.parse(value)).success) return;
  } catch {
    /* invalid JSON */
  }
  return "Workflow AI budget must be a JSON object with positive whole numbers for maxStepsPerSource, tasksPerMinute, burst, sourcesPer24Hours, scopeConcurrent and globalConcurrent, without extra fields";
};
