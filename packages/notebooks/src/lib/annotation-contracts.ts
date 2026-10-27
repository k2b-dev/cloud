import { z } from "zod";

export const ANNOTATION_QUOTE_MAX_LENGTH = 2_000;
export const ANNOTATION_CONTEXT_LENGTH = 32;
export const ANNOTATION_BODY_MAX_LENGTH = 5_000;
// A replacement is bounded like the passage it replaces, including an empty deletion.
export const ANNOTATION_SUGGESTION_MAX_LENGTH = ANNOTATION_QUOTE_MAX_LENGTH;
// Existing comment lists use 30 per page; replies have the same independent pagination.
export const ANNOTATION_PAGE_SIZE = 30;
// Leave six KiB for capability metadata and refs inside its 256 KiB envelope.
export const ANNOTATION_RESULT_MAX_BYTES = 250 * 1024;
export const AnnotationIdSchema = z.uuid();
export const AnnotationKeySchema = z.string().trim().min(1).max(200);
export const AnnotationCreateSchema = z
  .object({
    quote: z.string().min(1).max(ANNOTATION_QUOTE_MAX_LENGTH).describe("Exact selected Markdown passage, up to 2,000 UTF-16 characters."),
    prefix: z.string().max(ANNOTATION_CONTEXT_LENGTH).default("").describe("Exact adjacent Markdown context, up to 32 UTF-16 characters."),
    suffix: z.string().max(ANNOTATION_CONTEXT_LENGTH).default("").describe("Exact adjacent Markdown context, up to 32 UTF-16 characters."),
    occurrence: z.number().int().positive().optional().describe("1-based exact occurrence of quote in the current note Markdown."),
    offsetHint: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Optional UTF-16 start offset in note Markdown, excluding mirror front matter."),
    body: z
      .string()
      .trim()
      .max(ANNOTATION_BODY_MAX_LENGTH)
      .default("")
      .describe("Markdown comment text, up to 5,000 characters; may be empty when a suggestion changes the quote."),
    suggestion: z
      .string()
      .max(ANNOTATION_SUGGESTION_MAX_LENGTH)
      .nullable()
      .optional()
      .describe("Optional replacement passage, up to 2,000 characters. Empty means deletion; null means no suggestion."),
    idempotencyKey: AnnotationKeySchema.describe("Stable author-scoped retry key for this exact payload."),
  })
  .strict()
  .refine((value) => value.body.length > 0 || (value.suggestion != null && value.suggestion !== value.quote), {
    message: "A comment needs text or a suggestion that changes the passage",
  });
export const AnnotationReplySchema = z
  .object({
    body: z
      .string()
      .trim()
      .max(ANNOTATION_BODY_MAX_LENGTH)
      .default("")
      .describe("Markdown reply, up to 5,000 characters; may be empty with a replacement suggestion."),
    suggestion: z
      .string()
      .max(ANNOTATION_SUGGESTION_MAX_LENGTH)
      .nullable()
      .optional()
      .describe("Replacement for the thread passage; empty means deletion, null means no suggestion."),
    idempotencyKey: AnnotationKeySchema.describe("Stable author-scoped retry key for this exact payload."),
  })
  .strict();
export const AnnotationEditSchema = z
  .object({
    body: z.string().trim().max(ANNOTATION_BODY_MAX_LENGTH).describe("Replacement comment or reply text, up to 5,000 characters."),
    suggestion: z
      .string()
      .max(ANNOTATION_SUGGESTION_MAX_LENGTH)
      .nullable()
      .optional()
      .describe("Optional replacement passage, up to 2,000 characters. Empty means deletion; null means no suggestion."),
  })
  .strict();
export const AnnotationPageSchema = z
  .object({
    cursor: z.string().max(500).optional().describe("Opaque nextCursor or repliesNextCursor from the preceding page."),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(ANNOTATION_PAGE_SIZE)
      .default(ANNOTATION_PAGE_SIZE)
      .describe("Maximum comments or replies in a page, 1–30; byte limits can shorten it."),
  })
  .strict();
export const AnnotationListSchema = AnnotationPageSchema.extend({
  state: z
    .enum(["open", "resolved", "accepted", "all"])
    .default("all")
    .describe("Exact thread state; all includes every non-deleted thread."),
  author: z
    .union([z.uuid(), z.literal("me")])
    .optional()
    .describe("Root author UUID (user or service account), or me for the authenticated actor."),
});
export const AnnotationRejectSchema = z
  .object({
    replyId: z.uuid().optional().describe("Reply carrying the suggestion; omit for the root suggestion."),
    rejected: z
      .boolean()
      .default(true)
      .describe("True rejects the suggestion; false reopens a rejected suggestion. Never changes note text."),
  })
  .strict();
export const AnnotationOperationSchema = z
  .object({
    operationId: z.uuid().describe("Caller-stable operation UUID. Reuse it to recover an uncertain accept or undo outcome."),
    expectedText: z
      .string()
      .max(ANNOTATION_QUOTE_MAX_LENGTH)
      .optional()
      .describe("Expected current passage; defaults to the quote on accept and inserted text on undo."),
  })
  .strict();
export const AnnotationAcceptSchema = AnnotationOperationSchema.extend({
  replyId: z.uuid().optional().describe("Reply carrying the suggestion to accept; omit for the root suggestion."),
});
export const AnnotationPersonSchema = z.object({
  kind: z.enum(["user", "service_account"]),
  id: z.uuid(),
  name: z.string(),
  avatarHash: z.string().nullable().optional(),
});
const suggestionData = {
  suggestion: z.string().nullable(),
  suggestionState: z.enum(["open", "accepted", "rejected"]).nullable(),
  suggestionStateBy: AnnotationPersonSchema.nullable(),
  suggestionStateAt: z.string().nullable(),
  suggestionStateVia: z.enum(["assistant", "mcp"]).nullable(),
};
export const AnnotationReplyDataSchema = z.object({
  ...suggestionData,
  id: z.uuid(),
  author: AnnotationPersonSchema,
  via: z.enum(["assistant", "mcp"]).nullable(),
  body: z.string(),
  createdAt: z.string(),
  editedAt: z.string().nullable(),
  canEdit: z.boolean(),
  canDelete: z.boolean(),
});
export const AnnotationDataSchema = z.object({
  id: z.uuid(),
  noteId: z.string(),
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  orphan: z.boolean(),
  startRel: z.string(),
  endRel: z.string(),
  restoreRevision: z.string(),
  quote: z.string(),
  prefix: z.string(),
  suffix: z.string(),
  body: z.string(),
  ...suggestionData,
  state: z.enum(["open", "resolved", "accepted"]),
  stateBy: AnnotationPersonSchema.nullable(),
  stateAt: z.string().nullable(),
  stateVia: z.enum(["assistant", "mcp"]).nullable(),
  author: AnnotationPersonSchema,
  via: z.enum(["assistant", "mcp"]).nullable(),
  createdAt: z.string(),
  editedAt: z.string().nullable(),
  canEdit: z.boolean(),
  canDelete: z.boolean(),
  replies: z.array(AnnotationReplyDataSchema),
  repliesNextCursor: z.string().nullable(),
  headingPath: z.array(z.string()),
  acceptedOperationId: z.uuid().nullable(),
});
export const AnnotationProjectionSchema = z.object({
  text: z.string(),
  contentHash: z.string(),
  cursor: z.string().nullable(),
  restoreRevision: z.string(),
  items: z.array(AnnotationDataSchema),
  nextCursor: z.string().nullable(),
});
export type Annotation = z.infer<typeof AnnotationDataSchema>;
export type AnnotationProjection = z.infer<typeof AnnotationProjectionSchema>;
