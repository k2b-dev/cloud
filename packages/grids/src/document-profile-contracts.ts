import { z } from "zod";
export const DocumentProfileIdSchema = z.string().regex(/^[a-z][a-z0-9.-]{2,99}$/);
export const DocumentRelationshipSchema = z.enum(["original", "correction", "replacement"]);
export type DocumentRelationship = z.infer<typeof DocumentRelationshipSchema>;

const boundedIdentity = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !value.includes("\0"), "must not contain NUL");

export const DocumentSourceSchema = z
  .object({
    appId: boundedIdentity(100),
    resourceType: boundedIdentity(100),
    resourceId: boundedIdentity(500),
  })
  .strict();
export type DocumentSource = z.infer<typeof DocumentSourceSchema>;

export const DocumentSourceRevisionSchema = z
  .object({
    id: boundedIdentity(500),
    observedAt: z.string().datetime({ offset: true }),
    evidence: z.record(z.string().max(100), z.unknown()).default({}),
  })
  .strict();
export type DocumentSourceRevision = z.infer<typeof DocumentSourceRevisionSchema>;

export const DocumentProfileSummarySchema = z
  .object({
    id: DocumentProfileIdSchema,
    version: z.number().int().positive(),
    title: boundedIdentity(200),
    description: boundedIdentity(1_000),
    rendererVersion: boundedIdentity(200),
    validatorVersion: boundedIdentity(200),
  })
  .strict();
export type DocumentProfileSummary = z.infer<typeof DocumentProfileSummarySchema>;
