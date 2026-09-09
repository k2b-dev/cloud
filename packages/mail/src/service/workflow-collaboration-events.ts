import type { WorkflowJsonValue } from "@k2b/cloud/workflows";
import type { MailConversationChangedEvent } from "./events";
import { notifyMailInvalidations } from "./events";

const EVENT_KEY = "__mailCollaborationEvent";
type CollaborationEvent = Omit<MailConversationChangedEvent, "type" | "at">;

export const withMailWorkflowCollaborationEvent = (
  output: Record<string, WorkflowJsonValue>,
  event: CollaborationEvent | null,
): Record<string, WorkflowJsonValue> => (event ? { ...output, [EVENT_KEY]: true } : output);

export const publishMailWorkflowCollaborationEventFromOutput = async (output: WorkflowJsonValue | undefined): Promise<void> => {
  if (!output || typeof output !== "object" || Array.isArray(output)) return;
  if (output[EVENT_KEY] !== true) return;
  await notifyMailInvalidations();
};
