import { z } from "zod";
import { ShortIdSchema } from "./contracts";

export const CONTROLLED_DESTRUCTION_BATCH_MAX = 100;

const ControlledDestructionCandidateSchema = z
  .object({
    fileId: ShortIdSchema,
    tableId: ShortIdSchema,
    tableName: z.string().min(1),
    filename: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    unreferencedAt: z.string().datetime({ offset: true }),
    notBefore: z.string().datetime({ offset: true }),
  })
  .strict();

const ControlledDestructionPreviewSchema = z
  .object({
    observedAt: z.string().datetime({ offset: true }),
    minimumDays: z.number().int().positive().nullable(),
    counts: z
      .object({
        total: z.number().int().nonnegative(),
        eligible: z.number().int().nonnegative(),
        retained: z.number().int().nonnegative(),
        held: z.number().int().nonnegative(),
        unknown: z.number().int().nonnegative(),
        eligibleBytes: z.number().int().nonnegative(),
      })
      .strict(),
    items: z.array(ControlledDestructionCandidateSchema).max(CONTROLLED_DESTRUCTION_BATCH_MAX),
    truncated: z.boolean(),
  })
  .strict();
export type ControlledDestructionPreview = z.infer<typeof ControlledDestructionPreviewSchema>;

export const StartControlledDestructionInputSchema = z
  .object({
    fileIds: z.array(ShortIdSchema).min(1).max(CONTROLLED_DESTRUCTION_BATCH_MAX),
    confirmation: z.string().min(1).max(500),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.fileIds).size !== value.fileIds.length) {
      context.addIssue({ code: "custom", path: ["fileIds"], message: "File IDs must be unique" });
    }
  });
export type StartControlledDestructionInput = z.infer<typeof StartControlledDestructionInputSchema>;

const ControlledDestructionRunStatusSchema = z.enum([
  "queued",
  "running",
  "cancel_requested",
  "completed",
  "partial",
  "canceled",
  "failed",
]);

const ControlledDestructionItemStatusSchema = z.enum(["pending", "destroyed", "skipped", "failed"]);

export const ControlledDestructionRunSchema = z
  .object({
    id: ShortIdSchema,
    baseId: ShortIdSchema,
    status: ControlledDestructionRunStatusSchema,
    requestedByDisplayName: z.string().nullable(),
    requestedAt: z.string().datetime({ offset: true }),
    startedAt: z.string().datetime({ offset: true }).nullable(),
    completedAt: z.string().datetime({ offset: true }).nullable(),
    counts: z
      .object({
        total: z.number().int().nonnegative(),
        processed: z.number().int().nonnegative(),
        destroyed: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
      })
      .strict(),
    items: z.array(
      z
        .object({
          fileId: ShortIdSchema,
          tableId: ShortIdSchema,
          tableName: z.string().min(1),
          filename: z.string().min(1),
          sizeBytes: z.number().int().nonnegative(),
          status: ControlledDestructionItemStatusSchema,
          message: z.string().nullable(),
        })
        .strict(),
    ),
    error: z.string().nullable(),
  })
  .strict();
export type ControlledDestructionRun = z.infer<typeof ControlledDestructionRunSchema>;

export const ControlledDestructionOverviewSchema = z
  .object({ preview: ControlledDestructionPreviewSchema, runs: z.array(ControlledDestructionRunSchema) })
  .strict();
export type ControlledDestructionOverview = z.infer<typeof ControlledDestructionOverviewSchema>;
