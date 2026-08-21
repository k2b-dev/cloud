import { z } from "zod";
import { ShortIdSchema } from "./contracts";

export const BusinessDocumentProfileIdSchema = z.string().regex(/^[a-z][a-z0-9.-]{2,99}$/);
export const BusinessDocumentArtifactKeySchema = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/);
export const BusinessDocumentRelationshipSchema = z.enum(["original", "correction", "replacement"]);
export type BusinessDocumentRelationship = z.infer<typeof BusinessDocumentRelationshipSchema>;

const boundedIdentity = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !value.includes("\0"), "must not contain NUL");

export const BusinessDocumentSourceSchema = z
  .object({
    appId: boundedIdentity(100),
    resourceType: boundedIdentity(100),
    resourceId: boundedIdentity(500),
  })
  .strict();
export type BusinessDocumentSource = z.infer<typeof BusinessDocumentSourceSchema>;

export const BusinessDocumentSourceRevisionSchema = z
  .object({
    id: boundedIdentity(500),
    observedAt: z.string().datetime({ offset: true }),
    evidence: z.record(z.string().max(100), z.unknown()).default({}),
  })
  .strict();
export type BusinessDocumentSourceRevision = z.infer<typeof BusinessDocumentSourceRevisionSchema>;

export const BusinessDocumentArtifactSchema = z
  .object({
    key: BusinessDocumentArtifactKeySchema,
    filename: boundedIdentity(255),
    mediaType: boundedIdentity(255),
    sizeBytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const BusinessDocumentSchema = z
  .object({
    id: ShortIdSchema,
    baseId: ShortIdSchema,
    profileId: BusinessDocumentProfileIdSchema,
    profileVersion: z.number().int().positive(),
    source: BusinessDocumentSourceSchema,
    sourceRevision: BusinessDocumentSourceRevisionSchema,
    snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
    number: z.string().min(1).max(200),
    relationship: BusinessDocumentRelationshipSchema,
    predecessorId: ShortIdSchema.nullable(),
    rendererVersion: z.string().min(1).max(200),
    validatorVersion: z.string().min(1).max(200),
    validationStatus: z.enum(["valid", "warning"]),
    validationReport: z.record(z.string(), z.unknown()),
    issuedAt: z.string().datetime({ offset: true }),
    artifacts: z.array(BusinessDocumentArtifactSchema).min(2).max(8),
  })
  .strict();
export type BusinessDocument = z.infer<typeof BusinessDocumentSchema>;

export const BusinessDocumentProfileSummarySchema = z
  .object({
    id: BusinessDocumentProfileIdSchema,
    version: z.number().int().positive(),
    title: boundedIdentity(200),
    description: boundedIdentity(1_000),
    rendererVersion: boundedIdentity(200),
    validatorVersion: boundedIdentity(200),
  })
  .strict();
export type BusinessDocumentProfileSummary = z.infer<typeof BusinessDocumentProfileSummarySchema>;

const BusinessDocumentIssueBaseSchema = z
  .object({
    profileId: BusinessDocumentProfileIdSchema,
    profileVersion: z.number().int().positive(),
    idempotencyKey: boundedIdentity(200),
    source: BusinessDocumentSourceSchema,
    sourceRevision: BusinessDocumentSourceRevisionSchema,
    snapshot: z.record(z.string(), z.unknown()),
    relationship: BusinessDocumentRelationshipSchema.default("original"),
    predecessorId: ShortIdSchema.optional(),
  })
  .strict();

const validateRelationship = (value: { relationship: BusinessDocumentRelationship; predecessorId?: string }, ctx: z.RefinementCtx) => {
  if (value.relationship === "original" && value.predecessorId !== undefined) {
    ctx.addIssue({ code: "custom", path: ["predecessorId"], message: "Original documents cannot name a predecessor" });
  }
  if (value.relationship !== "original" && value.predecessorId === undefined) {
    ctx.addIssue({ code: "custom", path: ["predecessorId"], message: "Corrections and replacements require a predecessor" });
  }
};

export const BusinessDocumentIssueSchema = BusinessDocumentIssueBaseSchema.superRefine(validateRelationship);
export type BusinessDocumentIssue = z.infer<typeof BusinessDocumentIssueSchema>;

export const BusinessDocumentIssueResponseSchema = z
  .object({
    document: BusinessDocumentSchema,
    replayed: z.boolean(),
  })
  .strict();

export const BusinessDocumentGqlIssueSchema = BusinessDocumentIssueBaseSchema.omit({
  source: true,
  sourceRevision: true,
  snapshot: true,
})
  .extend({
    query: z.string().trim().min(1).max(20_000),
    observedAt: z.string().datetime({ offset: true }),
    currentTableId: ShortIdSchema.optional(),
    currentSource: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("table"), tableId: ShortIdSchema }),
        z.object({ kind: z.literal("view"), viewId: ShortIdSchema }),
      ])
      .optional(),
  })
  .superRefine(validateRelationship);

export const BusinessDocumentListSchema = z
  .object({
    items: z.array(BusinessDocumentSchema),
    cursor: z.string().nullable(),
    hasMore: z.boolean(),
  })
  .strict();

export const BusinessDocumentListQuerySchema = z
  .object({
    profileId: BusinessDocumentProfileIdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(1_000).optional(),
  })
  .strict();
