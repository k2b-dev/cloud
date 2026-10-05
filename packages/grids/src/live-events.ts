import { z } from "zod";
import { ShortIdSchema } from "./contracts";
import type { PublicWorkflowRunEvent } from "./frontend/_components/workflows/workflow-run-public-event";

/**
 * A record change that open views of a table apply, on the live channel
 * `records`. `grids.enqueue_record_event()` writes it in SQL, so its shape is
 * fixed there too.
 */
export const GridsRecordLiveEventSchema = z
  .object({
    type: z.enum(["record.created", "record.updated", "record.deleted", "record.restored", "record.finalized"]),
    tableId: ShortIdSchema,
    recordId: ShortIdSchema,
    version: z.number().int().positive().nullable(),
  })
  .strict();

/** A change of a Base's structure or access, on the live channel `metadata`. Open pages check the workspace revision. */
export const GridsMetadataLiveEventSchema = z
  .object({
    type: z.enum([
      "base.updated",
      "base.deleted",
      "base.restored",
      "table.created",
      "table.updated",
      "table.deleted",
      "table.restored",
      "field.created",
      "field.updated",
      "field.deleted",
      "field.restored",
      "field.reordered",
      "view.created",
      "view.updated",
      "view.deleted",
      "view.restored",
      "form.created",
      "form.updated",
      "form.deleted",
      "form.restored",
      "workflow.created",
      "workflow.updated",
      "workflow.deleted",
      "workflow.restored",
      "access.changed",
    ]),
  })
  .strict();

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Checks what readers of a run update rely on; the summary's remaining fields are the run API's. */
const isRunLiveEvent = (value: unknown): value is PublicWorkflowRunEvent =>
  isRecord(value) &&
  value.v === 1 &&
  ShortIdSchema.safeParse(value.workflowId).success &&
  isRecord(value.run) &&
  ShortIdSchema.safeParse(value.run.id).success &&
  value.run.workflowId === value.workflowId &&
  typeof value.run.status === "string" &&
  Array.isArray(value.steps) &&
  value.steps.every((step) => isRecord(step) && typeof step.key === "string");

/** A transition of a workflow run with its changed steps, on the live channel `runs`. */
export const GridsRunLiveEventSchema = z.custom<PublicWorkflowRunEvent>(isRunLiveEvent, "Invalid workflow run update");

export const GridsLiveEventSchema = z.union([GridsRecordLiveEventSchema, GridsMetadataLiveEventSchema, GridsRunLiveEventSchema]);

export type GridsRecordLiveEvent = z.infer<typeof GridsRecordLiveEventSchema>;
export type GridsMetadataLiveEvent = z.infer<typeof GridsMetadataLiveEventSchema>;
