import type { WorkflowFieldSchema } from "@k2b/cloud/workflows";
import { createWorkflowManifest } from "@k2b/cloud/workflows/language";
import { GRIDS_WORKFLOW_ACTION_METADATA } from "./action-metadata";

const text = (description: string, optional = false, maxLength = 1_000): WorkflowFieldSchema => ({
  kind: "string",
  minLength: 1,
  maxLength,
  optional,
  description,
});

const value = (description: string, optional = false): WorkflowFieldSchema => ({ kind: "value", optional, description });

const object = (properties: Record<string, WorkflowFieldSchema>): WorkflowFieldSchema & { kind: "object" } => ({
  kind: "object",
  properties,
});

const commonInputProperties = {
  label: text("Label shown when collecting this input.", true, 120),
  description: text("Additional guidance shown to the operator.", true),
  required: { kind: "boolean", optional: true, description: "Whether callers must provide this input." },
} satisfies Record<string, WorkflowFieldSchema>;

export const gridsWorkflowManifest = createWorkflowManifest({
  id: "grids",
  version: 1,
  limits: {
    maxInputs: 100,
    maxSteps: 1_000,
    maxDepth: 20,
    maxConditions: 1_000,
    maxConditionDepth: 20,
    maxLoopItems: 10_000,
  },
  inputs: [
    {
      kind: "record",
      label: "Record",
      description: "One record from a configured table.",
      valueType: "grids.record",
      config: object({ table: text("Table name or ID."), ...commonInputProperties }),
    },
    {
      kind: "recordList",
      label: "Record list",
      description: "An ordered list of records from one configured table.",
      valueType: "grids.recordList",
      config: object({ table: text("Table name or ID."), ...commonInputProperties }),
    },
    ...(["text", "number", "boolean", "date", "dateTime"] as const).map((kind) => ({
      kind,
      label: kind === "dateTime" ? "Date and time" : `${kind[0]!.toUpperCase()}${kind.slice(1)}`,
      description: `A ${kind} value supplied when the workflow starts.`,
      valueType: `core.${kind}`,
      config: object(commonInputProperties),
    })),
    {
      kind: "select",
      label: "Select",
      description: "One value from a fixed set of options.",
      valueType: "core.text",
      config: object({
        ...commonInputProperties,
        options: {
          kind: "array",
          items: text("Option value.", false, 200),
          minItems: 1,
          maxItems: 200,
          description: "Allowed values.",
        },
      }),
    },
  ],
  triggers: [
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
    {
      kind: "recordEvent",
      label: "Record event",
      description: "Starts when a record is created, updated, deleted, or commented on.",
      snippet: "recordEvent:\n  event: updated\n  table: Items\n  with:\n    item: ${{ trigger.record }}",
      eventValues: {
        record: "grids.record",
        event: "core.text",
        occurredAt: "core.dateTime",
      },
      config: object({
        event: { kind: "string", enum: ["created", "updated", "deleted", "commented"], description: "Record event to observe." },
        table: text("Optional table restriction.", true, 200),
        filter: value("Optional server-side Grids filter tree.", true),
      }),
    },
  ],
  actions: GRIDS_WORKFLOW_ACTION_METADATA,
});
