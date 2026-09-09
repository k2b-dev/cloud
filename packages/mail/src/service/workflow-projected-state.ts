import type { WorkflowBoundPlan, WorkflowJsonValue, WorkflowStepOutcome } from "@k2b/cloud/workflows";
import type { WorkflowActionStep, WorkflowExecuteActionContext } from "@k2b/cloud/workflows/runtime";
import type { FrozenMailWorkflowSource } from "./workflow-data";

export type MailWorkflowProjectedObject = Record<string, WorkflowJsonValue>;

export const isMailWorkflowProjectedObject = (value: WorkflowJsonValue | undefined): value is MailWorkflowProjectedObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const createMailWorkflowProjectedState = (
  plan: WorkflowBoundPlan,
  source: FrozenMailWorkflowSource | Record<string, never>,
  invocationInputs: Record<string, WorkflowJsonValue>,
): { source: FrozenMailWorkflowSource | Record<string, never>; inputs: Record<string, WorkflowJsonValue> } => {
  const projectedSource = structuredClone(source);
  const inputs: Record<string, WorkflowJsonValue> = { ...structuredClone(invocationInputs) };
  if ("message" in projectedSource) {
    for (const input of plan.inputs) {
      if (input.type === "mailMessage") inputs[input.name] = projectedSource.message;
      else if (input.type === "mailConversation") inputs[input.name] = projectedSource.conversation;
    }
  }
  return { source: projectedSource, inputs };
};

export const applyMailMessageTransition = (
  message: MailWorkflowProjectedObject,
  action:
    | "addKeyword"
    | "removeKeyword"
    | "moveMessage"
    | "copyMessage"
    | "archiveMessage"
    | "trashMessage"
    | "junkMessage"
    | "addFlag"
    | "removeFlag",
  value: WorkflowJsonValue,
): boolean => {
  if (action === "copyMessage") return true;
  if (action === "moveMessage" || action === "archiveMessage" || action === "trashMessage" || action === "junkMessage") {
    if (typeof value !== "string" || message.folderId === value) return false;
    message.folderId = value;
    return true;
  }
  if (typeof value !== "string") return false;
  const field = action === "addFlag" || action === "removeFlag" ? "flags" : "keywords";
  const current = Array.isArray(message[field]) ? message[field].filter((item): item is string => typeof item === "string") : [];
  const index = current.findIndex((item) => item.toLocaleLowerCase("und") === value.toLocaleLowerCase("und"));
  if ((action === "addKeyword" || action === "addFlag") && index < 0) {
    message[field] = [...current, value].sort((left, right) => left.localeCompare(right, "und"));
    return true;
  }
  if ((action === "removeKeyword" || action === "removeFlag") && index >= 0) {
    message[field] = current.filter((_, itemIndex) => itemIndex !== index);
    return true;
  }
  return false;
};

export const applyMailConversationTransition = (
  conversation: MailWorkflowProjectedObject,
  action: "assignConversation" | "setConversationStatus" | "setConversationSummary",
  value: WorkflowJsonValue,
): boolean => {
  if (action === "assignConversation") {
    if ((typeof value !== "string" && value !== null) || conversation.assigneeUserId === value) return false;
    conversation.assigneeUserId = value;
  } else if (action === "setConversationStatus") {
    if (typeof value !== "string" || conversation.workStatus === value) return false;
    conversation.workStatus = value;
  } else {
    if (typeof value !== "string" || conversation.summary === value) return false;
    conversation.summary = value;
    conversation.summaryRevision = Number(conversation.summaryRevision ?? 0) + 1;
  }
  conversation.revision = Number(conversation.revision ?? 0) + 1;
  return true;
};

export const mailMessageTransitionChanges = (
  message: MailWorkflowProjectedObject,
  action:
    | "addKeyword"
    | "removeKeyword"
    | "moveMessage"
    | "copyMessage"
    | "archiveMessage"
    | "trashMessage"
    | "junkMessage"
    | "addFlag"
    | "removeFlag",
  value: WorkflowJsonValue,
): boolean => applyMailMessageTransition(structuredClone(message), action, value);

export const mailConversationTransitionChanges = (
  conversation: MailWorkflowProjectedObject,
  action: "assignConversation" | "setConversationStatus" | "setConversationSummary",
  value: WorkflowJsonValue,
): boolean => applyMailConversationTransition(structuredClone(conversation), action, value);

const restoredConfig = async (ctx: WorkflowExecuteActionContext, step: WorkflowActionStep): Promise<Record<string, WorkflowJsonValue>> => {
  const value = await ctx.evaluate(step.config as WorkflowJsonValue, ["config"]);
  return isMailWorkflowProjectedObject(value) ? value : {};
};

const restoredObject = async (
  ctx: WorkflowExecuteActionContext,
  step: WorkflowActionStep,
  config: Record<string, WorkflowJsonValue>,
  field: "message" | "conversation",
): Promise<MailWorkflowProjectedObject | null> => {
  const value = config[field];
  if (isMailWorkflowProjectedObject(value)) return value;
  if (typeof value !== "string") return null;
  const resolved = await ctx.resolveReference(value, [...step.sourcePath, step.action, field]);
  return isMailWorkflowProjectedObject(resolved) ? resolved : null;
};

export const restoreMailWorkflowProjectedState = async (
  ctx: WorkflowExecuteActionContext,
  step: WorkflowActionStep,
  outcome: Extract<WorkflowStepOutcome, { state: "completed" }>,
): Promise<void> => {
  if (!isMailWorkflowProjectedObject(outcome.output)) return;
  const output = outcome.output;
  const config = await restoredConfig(ctx, step);

  if (
    output.applied === true &&
    typeof output.action === "string" &&
    [
      "addKeyword",
      "removeKeyword",
      "moveMessage",
      "copyMessage",
      "archiveMessage",
      "trashMessage",
      "junkMessage",
      "addFlag",
      "removeFlag",
    ].includes(output.action)
  ) {
    const message = await restoredObject(ctx, step, config, "message");
    if (message && output.value !== undefined) {
      applyMailMessageTransition(message, output.action as Parameters<typeof applyMailMessageTransition>[1], output.value);
    }
    return;
  }

  if (
    output.applied === true &&
    (output.action === "assignConversation" || output.action === "setConversationStatus" || output.action === "setConversationSummary")
  ) {
    const conversation = await restoredObject(ctx, step, config, "conversation");
    if (conversation && output.value !== undefined) {
      applyMailConversationTransition(conversation, output.action, output.value);
      if (typeof output.revision === "number") conversation.revision = output.revision;
      if (typeof output.summaryRevision === "number") conversation.summaryRevision = output.summaryRevision;
    }
    return;
  }

  const conversation = await restoredObject(ctx, step, config, "conversation");
  const revision =
    step.action === "ensureConversationReference"
      ? output.conversationRevision
      : ["addLocalTag", "removeLocalTag"].includes(step.action)
        ? output.revision
        : null;
  if (conversation && typeof revision === "number") conversation.revision = revision;
};
