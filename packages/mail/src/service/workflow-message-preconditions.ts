import type { WorkflowJsonValue } from "@k2b/cloud/workflows";
import { type RemoteMessagePrecondition, remoteMessagePreconditionSchema } from "../contracts";

const object = (value: WorkflowJsonValue | undefined): Record<string, WorkflowJsonValue> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;

export const mailWorkflowMessagePrecondition = (
  context: Record<string, WorkflowJsonValue> | undefined,
  target: { messageId: string; remoteMessageRefId: string; folderId: string },
): RemoteMessagePrecondition => {
  const preconditions = object(context?.preconditions);
  const message = object(preconditions?.message);
  const parsed = remoteMessagePreconditionSchema.safeParse(preconditions?.remoteState);
  if (
    message?.id !== target.messageId ||
    message?.remoteMessageRefId !== target.remoteMessageRefId ||
    message?.folderId !== target.folderId ||
    !parsed.success
  ) {
    throw Object.assign(new Error("Frozen remote message preconditions are unavailable"), {
      code: "MAIL_WORKFLOW_PRECONDITION_MISSING",
    });
  }
  return parsed.data;
};
