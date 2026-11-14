import { z } from "zod";
import { RecordCreateInputSchema, RecordUpdateInputSchema } from "./capability-contracts";
import { DslQueryExecuteBodySchema, ShortIdSchema } from "./contracts";

export const RecordTargetSchema = z
  .object({
    tableId: ShortIdSchema.describe("Public stored Table ID."),
    recordId: ShortIdSchema.describe("Public Record ID in this Table."),
  })
  .strict();
export const RecordVersionTargetSchema = RecordTargetSchema.extend({
  ifVersion: z.number().int().positive().safe().describe("Current Record version; rejected if it changed."),
});
export const AtomicRecordsInputSchema = z
  .object({
    baseId: ShortIdSchema.describe("Public Base ID; every target must belong to it."),
    locks: z
      .array(RecordTargetSchema)
      .min(1)
      .max(100)
      .describe("Existing coordination Records locked before checks; at most 100 distinct locks including changes and checks."),
    checks: z
      .array(
        z.union([
          z
            .object({
              query: DslQueryExecuteBodySchema.shape.query.describe("Current-state GQL assertion; use a bounded selection."),
              assert: z.enum(["empty", "notEmpty"]).describe("Whether the current query result must be empty or nonempty."),
            })
            .strict(),
          RecordVersionTargetSchema.extend({
            values: RecordCreateInputSchema.shape.values.optional().describe("Optional expected Field values, keyed by public Field IDs."),
          }),
        ]),
      )
      .max(50)
      .default([])
      .describe("Current-state assertions evaluated after every coordination lock."),
    changes: z
      .array(
        z.discriminatedUnion("kind", [
          RecordCreateInputSchema.extend({
            tableId: RecordTargetSchema.shape.tableId,
            kind: z.literal("create").describe("Create one new Record."),
          }),
          RecordUpdateInputSchema.extend({
            tableId: RecordTargetSchema.shape.tableId,
            kind: z.literal("update").describe("Update one existing Record."),
          }),
        ]),
      )
      .min(1)
      .max(50)
      .describe("Ordered create/update operations; all roll back if any operation or check fails."),
  })
  .strict();
export const FinalizeRecordInputSchema = RecordVersionTargetSchema.extend({
  expectedPolicyRevision: z.number().int().positive().describe("Finalization policy revision returned by record.finalization.read."),
  approvalRequestId: ShortIdSchema.optional().describe("Existing Four-eyes request; only its eligible independent approver may finalize."),
});
export const CorrectionDraftInputSchema = RecordVersionTargetSchema.extend({
  typeFieldId: ShortIdSchema.describe("Single-select Field identifying the correction or cancellation."),
  typeValue: z.string().min(1).max(200).describe("Existing option ID for the correction or cancellation."),
  originalFieldId: ShortIdSchema.describe("Single self-relation Field pointing at the immutable original."),
  values: RecordCreateInputSchema.shape.values
    .refine((v) => Object.keys(v).length <= 50, "At most 50 prefill Fields")
    .describe("Explicit draft values; reserved type and original Fields cannot be overridden."),
});
export const IntegrityRecordDataSchema = z
  .object({ id: ShortIdSchema, tableId: ShortIdSchema, version: z.number().int().positive() })
  .strict();
export const AtomicRecordsDataSchema = z.object({ records: z.array(IntegrityRecordDataSchema).max(50) }).strict();
