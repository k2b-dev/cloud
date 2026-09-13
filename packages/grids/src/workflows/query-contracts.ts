import { z } from "zod";
import { DslQueryExecuteBodySchema, ShortIdSchema } from "../contracts";

// Same row budget as workflow record lists and loops; byte and SQL budgets
// additionally apply. A limit never authorizes a silently partial capture.
export const MAX_WORKFLOW_QUERY_ROWS = 10_000;

export const WorkflowDocumentConfirmationSchema = z
  .object({
    receiptId: ShortIdSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const WorkflowPendingDocumentConfirmationSchema = WorkflowDocumentConfirmationSchema.extend({ runId: ShortIdSchema });

export const documentConfirmationFromDependency = (value: unknown) => {
  const parsed = z
    .object({
      kind: z.literal("grids.document-confirmation"),
      key: ShortIdSchema,
      data: WorkflowDocumentConfirmationSchema,
    })
    .safeParse(value);
  return parsed.success && parsed.data.key === parsed.data.data.receiptId ? parsed.data.data : undefined;
};

export const WorkflowQueryPayloadSchema = z
  .object({
    version: z.literal(1),
    columns: z.array(z.object({ key: z.string().min(1), label: z.string().min(1), type: z.string(), sqlType: z.string() }).strict()),
    rows: z.array(z.record(z.string(), z.json())).max(MAX_WORKFLOW_QUERY_ROWS),
    rowOrigins: z
      .array(
        z
          .object({
            recordId: ShortIdSchema.nullable(),
            tableId: ShortIdSchema.nullable(),
            version: z.number().int().positive().safe().optional(),
          })
          .strict(),
      )
      .max(MAX_WORKFLOW_QUERY_ROWS),
    rowCount: z.number().int().min(0).max(MAX_WORKFLOW_QUERY_ROWS),
    capturedAt: z.string().datetime(),
    complete: z.literal(true),
    selectionLimit: z.number().int().positive().nullable(),
    source: DslQueryExecuteBodySchema.shape.query,
    schemaHash: z.string().regex(/^[a-f0-9]{64}$/),
    context: z.record(z.string(), z.json()),
    tableIds: z.array(z.string().uuid()).min(1),
  })
  .strict()
  .refine((value) => value.rows.length === value.rowCount && value.rowOrigins.length === value.rowCount, "Inconsistent row count");

export type WorkflowQueryCapture = {
  payload: z.infer<typeof WorkflowQueryPayloadSchema>;
  sha256: string;
  rowCount: number;
  capturedAt: string;
};

// Version 1 remains the exact stored GQL payload: changing its shape would
// change the hashes of already issued documents. New sources declare their
// provenance instead of inventing a query or schema hash.
export const WorkflowValuesPayloadSchema = z
  .object({
    ...WorkflowQueryPayloadSchema.shape,
    version: z.literal(2),
    source: z.object({ kind: z.literal("values") }).strict(),
    schemaHash: z.null(),
    context: z.object({}).strict(),
    tableIds: z.array(z.string().uuid()).length(0),
    selectionLimit: z.null(),
    rowOrigins: z.array(z.object({ recordId: z.null(), tableId: z.null() }).strict()).max(MAX_WORKFLOW_QUERY_ROWS),
  })
  .strict()
  .refine((value) => value.rows.length === value.rowCount && value.rowOrigins.length === value.rowCount, "Inconsistent row count");

export const WorkflowDocumentSnapshotPayloadSchema = z
  .object({
    ...WorkflowValuesPayloadSchema.shape,
    version: z.literal(3),
    source: z.object({ kind: z.literal("documents"), ids: z.array(ShortIdSchema).min(1).max(MAX_WORKFLOW_QUERY_ROWS) }).strict(),
  })
  .strict()
  .refine(
    (value) =>
      value.rows.length === value.rowCount && value.rowOrigins.length === value.rowCount && value.source.ids.length === value.rowCount,
    "Inconsistent row count",
  );

export const WorkflowRecordSnapshotPayloadSchema = z
  .object({
    ...WorkflowDocumentSnapshotPayloadSchema.shape,
    version: z.literal(4),
    source: z.object({ kind: z.literal("recordSnapshots"), ids: z.array(ShortIdSchema).min(1).max(MAX_WORKFLOW_QUERY_ROWS) }).strict(),
    tableIds: z.array(z.uuid()).min(1),
  })
  .strict()
  .refine(
    (value) =>
      value.rows.length === value.rowCount && value.rowOrigins.length === value.rowCount && value.source.ids.length === value.rowCount,
    "Inconsistent row count",
  );

export const WorkflowDocumentDataPayloadSchema = z.union([
  WorkflowQueryPayloadSchema,
  WorkflowValuesPayloadSchema,
  WorkflowDocumentSnapshotPayloadSchema,
  WorkflowRecordSnapshotPayloadSchema,
]);
export type WorkflowDocumentDataCapture = Omit<WorkflowQueryCapture, "payload"> & {
  payload: z.infer<typeof WorkflowDocumentDataPayloadSchema>;
};
