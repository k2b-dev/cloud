import { z } from "zod";

const DocumentProfileIdSchema = z.string().regex(/^[a-z][a-z0-9.-]{2,99}$/);

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
  })
  .strict();
export type DocumentProfileSummary = z.infer<typeof DocumentProfileSummarySchema>;
