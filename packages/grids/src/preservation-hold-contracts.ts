import { PaginationQuerySchema, PaginationResponseSchema } from "@k2b/cloud/contracts";
import { z } from "zod";
import { ShortIdSchema } from "./contracts";

export const PRESERVATION_HOLD_REASON_MAX_LENGTH = 1000;

const PreservationHoldReasonSchema = z.string().trim().min(1).max(PRESERVATION_HOLD_REASON_MAX_LENGTH);

const PreservationHoldScopeInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("base") }).strict(),
  z.object({ type: z.literal("table"), tableId: ShortIdSchema }).strict(),
]);

export const PreservationHoldInputSchema = z.object({ reason: PreservationHoldReasonSchema }).strict();
export type PreservationHoldInput = z.infer<typeof PreservationHoldInputSchema>;

export const CreatePreservationHoldInputSchema = z
  .object({
    reason: PreservationHoldReasonSchema,
    scope: PreservationHoldScopeInputSchema.optional().default({ type: "base" }),
  })
  .strict();
export type CreatePreservationHoldInput = z.infer<typeof CreatePreservationHoldInputSchema>;

const PreservationHoldStatusSchema = z.enum(["active", "released"]);

const PreservationHoldScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("base") }).strict(),
  z.object({ type: z.literal("table"), tableId: ShortIdSchema, tableName: z.string().min(1) }).strict(),
]);

export const PreservationHoldSchema = z
  .object({
    id: ShortIdSchema,
    baseId: ShortIdSchema,
    scope: PreservationHoldScopeSchema,
    reason: PreservationHoldReasonSchema,
    status: PreservationHoldStatusSchema,
    createdByDisplayName: z.string().nullable(),
    createdAt: z.string().datetime({ offset: true }),
    releaseReason: PreservationHoldReasonSchema.nullable(),
    releasedByDisplayName: z.string().nullable(),
    releasedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type PreservationHold = z.infer<typeof PreservationHoldSchema>;

export const PreservationHoldsQuerySchema = z
  .object({
    ...PaginationQuerySchema.shape,
    q: z.string().trim().max(200).optional(),
    status: z.enum(["active", "released", "all"]).optional().default("active"),
    scope: z.enum(["base", "table", "all"]).optional().default("all"),
    tableId: ShortIdSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.tableId && value.scope !== "table") {
      context.addIssue({ code: "custom", path: ["tableId"], message: "tableId requires table scope" });
    }
  });

export const PreservationHoldsResponseSchema = z
  .object({ items: z.array(PreservationHoldSchema), pagination: PaginationResponseSchema })
  .strict();
export type PreservationHoldsResponse = z.infer<typeof PreservationHoldsResponseSchema>;
