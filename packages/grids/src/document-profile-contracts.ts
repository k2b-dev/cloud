import { z } from "zod";

const DocumentProfileIdSchema = z.string().regex(/^[a-z][a-z0-9.-]{2,99}$/);

export const PrimaryDocumentArtifactSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
    mediaType: z
      .string()
      .max(255)
      .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/),
  })
  .strict();
export type PrimaryDocumentArtifact = z.infer<typeof PrimaryDocumentArtifactSchema>;

const boundedIdentity = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !value.includes("\0"), "must not contain NUL");

export const DocumentProfileSummarySchema = z
  .object({
    id: DocumentProfileIdSchema,
    version: z.number().int().positive(),
    title: boundedIdentity(200),
    description: boundedIdentity(1_000),
    rendererVersion: boundedIdentity(200),
    validatorVersion: boundedIdentity(200),
    primaryArtifact: PrimaryDocumentArtifactSchema,
  })
  .strict();
export type DocumentProfileSummary = z.infer<typeof DocumentProfileSummarySchema>;

export const DocumentProfileReferenceSchema = DocumentProfileSummarySchema.extend({
  inputSchema: z.record(z.string(), z.unknown()),
});
export type DocumentProfileReference = z.infer<typeof DocumentProfileReferenceSchema>;
