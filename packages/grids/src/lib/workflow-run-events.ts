import type { GridsWorkflowRun, GridsWorkflowStepRun } from "../workflows/contracts";

type WorkflowRunStepSummary = Pick<
  GridsWorkflowStepRun,
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

type WorkflowRunEventSummary = Pick<
  GridsWorkflowRun,
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
};

export type GridsWorkflowRunEvent = {
  v: 1;
  baseId: string;
  workflowId: string | null;
  run: WorkflowRunEventSummary;
  steps: WorkflowRunStepSummary[];
  scope: { kind: "workflow" };
};
export type WorkflowRunEventScope = GridsWorkflowRunEvent["scope"];

export const toWorkflowRunEventSummary = (run: GridsWorkflowRun): WorkflowRunEventSummary => ({
  id: run.id,
  workflowId: run.workflowId,
  launcherId: run.launcherId,
  baseId: run.baseId,
  workflowRevision: run.workflowRevision,
  mode: run.mode,
  channel: run.channel,
  status: run.status,
  error: run.error,
  resultMessage: run.resultMessage,
  createdAt: run.createdAt,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
});

export const toWorkflowRunStepSummary = ({
  runId,
  key,
  sourcePath,
  iterationPath,
  kind,
  action,
  status,
  outcome,
  executionGeneration,
  startedAt,
  finishedAt,
}: GridsWorkflowStepRun): WorkflowRunStepSummary => ({
  runId,
  key,
  sourcePath,
  iterationPath,
  kind,
  action,
  status,
  outcome,
  executionGeneration,
  startedAt,
  finishedAt,
});
