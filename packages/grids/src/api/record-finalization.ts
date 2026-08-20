import { z } from "zod";
import { ShortIdSchema } from "../contracts";
import { projectPublicIds } from "../service/public-resources";
import type { RecordFinalizationReadiness, RecordFinalizationStatus } from "../service/record-finalization";

export const PublicRecordFinalizationStatusSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false), durableHistory: z.enum(["disabled", "activating", "active"]) }).strict(),
  z
    .object({
      enabled: z.literal(true),
      durableHistory: z.literal("active"),
      enabledAt: z.string().datetime(),
      finalizedCount: z.number().int().nonnegative(),
      canDisable: z.boolean(),
      mode: z.enum(["direct", "fourEyes"]),
      approverGroupId: z.string().uuid().nullable(),
      approverGroupName: z.string().nullable(),
      policyRevision: z.number().int().positive(),
    })
    .strict(),
]);

const FinalizationFieldSchema = z.object({ fieldId: ShortIdSchema, fieldName: z.string() }).strict();
export const PublicRecordFinalizationRequestSchema = z
  .object({
    id: ShortIdSchema,
    status: z.enum(["pending", "approved", "rejected", "superseded"]),
    recordVersion: z.number().int().nonnegative(),
    requestedBy: z.string().uuid(),
    requestedByDisplayName: z.string(),
    requestComment: z.string().nullable(),
    requestedAt: z.string().datetime(),
    resolvedBy: z.string().uuid().nullable(),
    resolvedByDisplayName: z.string().nullable(),
    resolutionComment: z.string().nullable(),
    resolvedAt: z.string().datetime().nullable(),
  })
  .strict();
export const PublicFinalizationPolicyInputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("direct") }).strict(),
  z.object({ mode: z.literal("fourEyes"), approverGroupId: z.string().uuid() }).strict(),
]);
export const PublicFinalizationRequestInputSchema = z
  .object({ comment: z.string().trim().min(1).max(2_000).nullable().optional() })
  .strict();
export const PublicFinalizationResolutionInputSchema = z
  .object({ requestId: ShortIdSchema, comment: z.string().trim().min(1).max(2_000).nullable().optional() })
  .strict();
export const PublicRecordFinalizationReadinessSchema = z
  .object({
    enabled: z.boolean(),
    mode: z.enum(["direct", "fourEyes"]).nullable(),
    finalized: z.boolean(),
    finalizedAt: z.string().datetime().nullable(),
    request: PublicRecordFinalizationRequestSchema.nullable(),
    canResolveRequest: z.boolean(),
    resolutionDisabledReason: z.string().nullable(),
    missing: z.array(FinalizationFieldSchema.extend({ message: z.string() })),
    assignedOnFinalization: z.array(FinalizationFieldSchema),
  })
  .strict();

export type PublicRecordFinalizationStatus = z.infer<typeof PublicRecordFinalizationStatusSchema>;
export type PublicRecordFinalizationReadiness = z.infer<typeof PublicRecordFinalizationReadinessSchema>;
export type PublicRecordFinalizationRequest = z.infer<typeof PublicRecordFinalizationRequestSchema>;

export const toPublicRecordFinalizationStatus = (status: RecordFinalizationStatus): PublicRecordFinalizationStatus => status;

export const toPublicRecordFinalizationReadiness = async (
  readiness: RecordFinalizationReadiness,
): Promise<PublicRecordFinalizationReadiness> => {
  const ids = await projectPublicIds("field", [
    ...readiness.missing.map((item) => item.fieldId),
    ...readiness.assignedOnFinalization.map((item) => item.fieldId),
  ]);
  const field = <T extends { fieldId: string }>(item: T) => ({ ...item, fieldId: ids.get(item.fieldId) ?? "" });
  return PublicRecordFinalizationReadinessSchema.parse({
    ...readiness,
    missing: readiness.missing.map(field),
    assignedOnFinalization: readiness.assignedOnFinalization.map(field),
  });
};
