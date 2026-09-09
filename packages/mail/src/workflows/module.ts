import { AI_WORKFLOW_ACTIONS, defineWorkflowModule, type WorkflowFieldSchema } from "@k2b/cloud/workflows";
import { MAIL_WORKFLOW_ACTIONS } from "./actions";

const text = (description: string, optional = false, maxLength = 1_000): WorkflowFieldSchema => ({
  kind: "string",
  minLength: 1,
  maxLength,
  optional,
  description,
});
const object = (properties: Record<string, WorkflowFieldSchema>): WorkflowFieldSchema & { kind: "object" } => ({
  kind: "object",
  properties,
});
const referenceInput = () =>
  object({ required: { kind: "boolean", optional: true, description: "Whether callers must provide this input." } });

export const mailWorkflows = defineWorkflowModule({
  id: "mail",
  version: 3,
  limits: {
    maxInputs: 20,
    maxSteps: 500,
    maxDepth: 20,
    maxConditions: 500,
    maxConditionDepth: 20,
  },
  inputs: [
    {
      kind: "mailMessage",
      label: "Mail message",
      description: "One message in the workflow mailbox.",
      valueType: "mail.message",
      config: referenceInput(),
    },
    {
      kind: "mailConversation",
      label: "Mail conversation",
      description: "One conversation in the workflow mailbox.",
      valueType: "mail.conversation",
      config: referenceInput(),
    },
  ],
  triggers: [
    {
      kind: "messageReceived",
      label: "Message received",
      description: "Starts once for a stable newly imported message.",
      snippet: 'messageReceived:\n  with:\n    message: "${{ trigger.message }}"\n    conversation: "${{ trigger.conversation }}"',
      eventValues: {
        message: "mail.message",
        conversation: "mail.conversation",
        occurredAt: "core.dateTime",
      },
      config: object({}),
    },
    {
      kind: "schedule",
      label: "Schedule",
      description: "Starts the workflow for future cron slots in an IANA timezone.",
      snippet: 'schedule:\n  cron: "0 8 * * *"\n  timezone: Europe/Berlin\n  with: {}',
      eventValues: { occurredAt: "core.dateTime", slot: "core.dateTime" },
      config: object({
        cron: text("Five-field cron expression.", false, 120),
        timezone: text("IANA timezone. Defaults to UTC.", true, 80),
      }),
    },
  ],
  actions: { ...MAIL_WORKFLOW_ACTIONS, ...AI_WORKFLOW_ACTIONS },
});
