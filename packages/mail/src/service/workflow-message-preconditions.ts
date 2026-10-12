import type { WorkflowJsonValue } from "@k2b/cloud/workflows";
import { type RemoteMessagePrecondition, remoteMessagePreconditionSchema, standardMessageFlagSchema } from "../contracts";
import type { MailWorkflowMessageStateTransition } from "./workflow-projected-state";

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

/** Apply only this run's successful transitions; retain receipt-time checks until its first write. */
export const projectMailWorkflowMessagePrecondition = (
  frozen: RemoteMessagePrecondition,
  transitions: readonly MailWorkflowMessageStateTransition[],
): RemoteMessagePrecondition => {
  if (transitions.length === 0) return frozen;
  const expected = { ...frozen, modseq: undefined };
  const apply = <T extends string>(current: T[] | undefined, value: T, add: boolean): T[] | undefined => {
    if (current === undefined) return undefined;
    const matches = (item: string): boolean => item.toLocaleLowerCase("und") === value.toLocaleLowerCase("und");
    return add ? (current.some(matches) ? current : [...current, value]) : current.filter((item) => !matches(item));
  };
  for (const transition of transitions) {
    if (transition.field === "flags") {
      // Frozen remote flags use standard names; provider spellings may contain a backslash.
      const flag = standardMessageFlagSchema.parse(transition.value.replace(/^\\/u, "").toLowerCase());
      expected.flags = apply(expected.flags, flag, transition.add);
    } else {
      expected.keywords = apply(expected.keywords, transition.value, transition.add);
    }
  }
  return expected;
};
