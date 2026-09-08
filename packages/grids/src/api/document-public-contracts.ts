import { z } from "zod";
import { ShortIdSchema } from "../contracts";

export const PUBLIC_DOCUMENT_PAGE_LIMIT = 100;

const PublicDocumentArtifactSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
    filename: z.string().trim().min(1).max(255),
    mimeType: z.string().trim().min(1).max(255),
    sizeBytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const PublicDocumentRendererSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("html") }).strict(),
  z
    .object({
      kind: z.literal("profile"),
      id: z.string().regex(/^[a-z][a-z0-9.-]{2,99}$/),
      version: z.number().int().positive(),
    })
    .strict(),
]);

export const PublicDocumentSchema = z
  .object({
    id: ShortIdSchema,
    baseId: ShortIdSchema,
    tableId: ShortIdSchema,
    recordId: ShortIdSchema,
    templateId: ShortIdSchema,
    number: z.string().min(1).max(200),
    filename: z.string().trim().min(1).max(255),
    createdAt: z.string().datetime(),
    tags: z.array(z.string()),
    createdBy: z.string().uuid().nullable(),
    renderer: PublicDocumentRendererSchema,
    validationStatus: z.enum(["valid", "warning"]).nullable(),
    artifacts: z.array(PublicDocumentArtifactSchema).min(1).max(8),
  })
  .strict();
