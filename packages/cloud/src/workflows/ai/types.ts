import type { AiTaskRequest as WorkflowAiRequest } from "../../ai/task-contracts";
import type { WorkflowJsonValue } from "../contracts";

export {
  type AiTaskRequest as WorkflowAiRequest,
  type AiTaskRequestInput as WorkflowAiRequestInput,
  AiTaskRequestSchema as workflowAiRequestSchema,
} from "../../ai/task-contracts";

export type WorkflowAiTaskStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

export type WorkflowAiTask = {
  /** Existing user in the run authorization snapshot, when this is user-owned work. */
  usageUserId?: string;
  id: string;
  appId: string;
  runId: string;
  stepKey: string;
  effectKey: string;
  kind: WorkflowAiRequest["kind"];
  request: WorkflowAiRequest;
  inputHash: string;
  modelProfileId: string;
  status: WorkflowAiTaskStatus;
  output: WorkflowJsonValue | null;
  usage: WorkflowJsonValue | null;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  cancelRequestedAt: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
};
