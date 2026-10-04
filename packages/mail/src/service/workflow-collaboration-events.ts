import type { WorkflowJsonValue } from "@k2b/cloud/workflows";
import { type MailActivityChange, mailLive } from "./live";

const EVENT_KEY = "__mailCollaborationEvent";
export const withMailWorkflowCollaborationEvent = (
  output: Record<string, WorkflowJsonValue>,
  event: MailActivityChange | null,
): Record<string, WorkflowJsonValue> => (event ? { ...output, [EVENT_KEY]: true } : output);

export const publishMailWorkflowCollaborationEventFromOutput = async (output: WorkflowJsonValue | undefined): Promise<void> => {
  if (!output || typeof output !== "object" || Array.isArray(output)) return;
  if (output[EVENT_KEY] !== true) return;
  mailLive.wake();
};
