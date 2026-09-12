import type { PublicWorkflowRun, PublicWorkflowStepRun } from "../workspace/workspace-public-state-model";

export type PublicWorkflowRunEventSummary = Pick<
  PublicWorkflowRun,
  | "id"
  | "workflowId"
  | "launcherId"
  | "baseId"
  | "workflowRevision"
  | "mode"
  | "channel"
  | "status"
  | "error"
  | "resultMessage"
  | "createdAt"
  | "startedAt"
  | "finishedAt"
> & {
  operatorMessage?: string | null;
  documentConfirmation?: PublicWorkflowRun["documentConfirmation"];
};

export type PublicWorkflowRunStepSummary = Pick<
  PublicWorkflowStepRun,
  | "runId"
  | "key"
  | "sourcePath"
  | "iterationPath"
  | "kind"
  | "action"
  | "status"
  | "outcome"
  | "executionGeneration"
  | "startedAt"
  | "finishedAt"
>;

export type PublicWorkflowRunEvent = {
  v: 1;
  baseId: string;
  workflowId: string | null;
  run: PublicWorkflowRunEventSummary;
  steps: PublicWorkflowRunStepSummary[];
  scope: { kind: "workflow" };
};
