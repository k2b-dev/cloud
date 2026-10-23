import { TextTableActionReceiptSchema, TextTableActionRequestSchema, TextTableFocusSchema } from "@k2b/cloud/browser/shared-text";
import { z } from "zod";
import { draftEditableContentInputSchema } from "../contracts";

// Query transport also binds browser WebSocket handshakes, which cannot set custom headers.
export const DRAFT_DOCUMENT_EXPECTED_USER_QUERY = "expectedUserId";

// Same 2 Mi UTF-16 body and 8 MB base64 update envelope as the shared editor.
export const MAX_DRAFT_DOCUMENT_PAYLOAD = 8_000_000;
export const draftGenerationSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .max(19)
  .refine((value) => value.length <= 19 && /^[1-9]\d*$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n);
export const draftDocumentUpdateSchema = z
  .object({
    generation: draftGenerationSchema,
    baseCursor: z.string().max(256).nullable(),
    payload: z.string().min(1).max(MAX_DRAFT_DOCUMENT_PAYLOAD),
  })
  .strict();
export const draftDocumentSnapshotSchema = z.object({
  state: z.string(),
  cursor: z.string().nullable(),
  content: draftEditableContentInputSchema,
});
export const draftDocumentSessionSchema = z.object({
  generation: draftGenerationSchema,
  revision: z.number().int().positive(),
  lifecycle: z.string(),
  historyComplete: z.boolean(),
  fresh: draftDocumentSnapshotSchema,
  durable: draftDocumentSnapshotSchema,
  frozen: z
    .object({ state: z.string(), cursor: z.string(), generation: draftGenerationSchema, revision: z.number().int().positive() })
    .nullable(),
});
export type DraftDocumentSession = z.infer<typeof draftDocumentSessionSchema>;

export const draftDocumentRestSchema = z
  .object({
    generation: draftGenerationSchema,
    clientId: z.string().uuid(),
    state: z.string().min(1).max(MAX_DRAFT_DOCUMENT_PAYLOAD),
  })
  .strict();

export const draftTableActionRequestSchema = TextTableActionRequestSchema.omit({ restoreRevision: true })
  .extend({ generation: draftGenerationSchema })
  .strict();

export const draftDocumentSaveSchema = z.object({
  generation: draftGenerationSchema,
  status: z.enum(["saved", "covered"]),
  revision: z.number().int().positive(),
  durable: draftDocumentSnapshotSchema,
});
export const draftDocumentAdmissionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("accepted"),
    cursor: z.string(),
    revision: z.number().int().positive(),
    durable: draftDocumentSnapshotSchema,
  }),
  z.object({ status: z.literal("pendingPersistence"), cursor: z.string(), message: z.string() }),
  z.object({ status: z.literal("recoveryRequired"), message: z.string() }),
]);
export const draftTableActionResponseSchema = z.object({
  changed: z.boolean(),
  accepted: z.boolean().nullable(),
  persisted: z.boolean(),
  cursor: z.string().nullable(),
  receipt: TextTableActionReceiptSchema.nullable(),
  focus: TextTableFocusSchema.nullable(),
});
