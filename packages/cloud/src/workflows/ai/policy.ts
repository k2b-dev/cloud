import type { AiModelProfile } from "../../ai/types";
import { canonicalWorkflowJson } from "../language/canonical";

export type WorkflowAiBudget = {
  maxStepsPerSource: number;
  tasksPerMinute: number;
  burst: number;
  sourcesPer24Hours: number;
  scopeConcurrent: number;
  globalConcurrent: number;
};

/** Application-owned source identity/revision, within the run's durable scope. */
export type WorkflowAiScope = {
  sourceId: string;
  sourceRevision: string;
  budget: WorkflowAiBudget;
  recompute?: boolean;
};

export class WorkflowAiAdmissionError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: string) {
    super(
      code === "WORKFLOW_AI_MODEL_CHANGED"
        ? "Workflow AI model configuration changed. Retry the workflow to use the current model configuration."
        : `${code}: Workflow AI admission is unavailable. Retry after capacity or the rolling budget recovers, or inspect the source manually.`,
    );
    this.retryable = code === "WORKFLOW_AI_CAPACITY" || code === "WORKFLOW_AI_RATE_LIMIT";
  }
}

export const workflowAiHash = (value: unknown): string => new Bun.CryptoHasher("sha256").update(canonicalWorkflowJson(value)).digest("hex");

/** v1 identifies the executor's prompt suffixes, schemas, temperature and token policy. */
export const workflowAiModelHash = (profile: AiModelProfile): string =>
  workflowAiHash({
    executor: 1,
    profile: {
      provider: profile.provider,
      model: profile.model,
      baseURL: profile.baseURL,
      contextWindow: profile.contextWindow,
      temperature: profile.temperature,
      maxOutputTokens: profile.maxOutputTokens,
      reasoningEffort: profile.reasoningEffort,
      extraBody: profile.extraBody,
    },
  });
