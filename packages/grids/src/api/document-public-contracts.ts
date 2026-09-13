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

const DocumentShapeSchema = z
  .object({
    id: ShortIdSchema,
    baseId: ShortIdSchema,
    tableId: ShortIdSchema.nullable(),
    recordId: ShortIdSchema.nullable(),
    templateId: ShortIdSchema.nullable(),
    number: z.string().min(1).max(200),
    filename: z.string().trim().min(1).max(255),
    createdAt: z.string().datetime(),
    tags: z.array(z.string()),
    createdBy: z.string().uuid().nullable(),
    renderer: PublicDocumentRendererSchema,
    validationStatus: z.enum(["valid", "warning"]).nullable(),
    artifacts: z.array(PublicDocumentArtifactSchema).min(1).max(8),
    primaryArtifactKey: PublicDocumentArtifactSchema.shape.key,
    sourceRecordCount: z.number().int().nonnegative().nullable(),
    dataSnapshot: z
      .object({
        rowCount: z.number().int().nonnegative(),
        capturedAt: z.string().datetime(),
      })
      .strict()
      .nullable(),
  })
  .strict();

const hasCompleteRecordBinding = (document: Pick<z.infer<typeof DocumentShapeSchema>, "tableId" | "recordId" | "templateId">) =>
  [document.tableId, document.recordId, document.templateId].every((id) => id === null) ||
  [document.tableId, document.recordId, document.templateId].every((id) => id !== null);
const bindingError = "Document record bindings must be all present or all absent";

export const PublicDocumentSchema = DocumentShapeSchema.refine(hasCompleteRecordBinding, bindingError);
export const DocumentCapabilityDataSchema = DocumentShapeSchema.omit({ tags: true, createdBy: true })
  .strip()
  .refine(hasCompleteRecordBinding, bindingError);
