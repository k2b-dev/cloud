import type { AccessSubject } from "../../server/services/access";
import type { AiResolvedModelRef } from "../../shared/ai-models";
import type { JsonValue as WorkflowJsonValue } from "../../shared/canonical-json";
import type { AiTaskRequest as WorkflowAiRequest } from "../task-contracts";

export {
  type AiTaskRequest as WorkflowAiRequest,
  type AiTaskRequestInput as WorkflowAiRequestInput,
  AiTaskRequestSchema as workflowAiRequestSchema,
} from "../task-contracts";

export type WorkflowAiTaskStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

export type WorkflowAiTask = {
  /** Existing user in the run authorization snapshot, when this is user-owned work. */
  usageUserId?: string;
  id: string;
  appId: string;
  runId: string | null;
  /** Authenticated owner of an interactive application task; never supplied by model input. */
  usageSubject?: AccessSubject;
  stepKey: string;
  effectKey: string;
  kind: WorkflowAiRequest["kind"];
  request: WorkflowAiRequest;
  inputHash: string;
  modelId: string;
  modelRef?: AiResolvedModelRef;
  modelConfigHash?: string;
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
