import { APP_APPROVAL_LIMITS, CAPABILITY_MAX_REVIEW_CONTENT_BYTES } from "@k2b/cloud/contracts";
import { z } from "zod";
import { CodeIdSchema, CodeSourceFilesSchema } from "./contracts";

/** Same plain-text limit as Notebooks and Spaces comments. */
export const CODE_REVIEW_COMMENT_LENGTH = 5_000;
/** Worst-case JSON escaping plus anchor/author metadata must fit the complete review content budget. */
export const CODE_REVIEW_COMMENT_LIMIT = Math.floor(CAPABILITY_MAX_REVIEW_CONTENT_BYTES / (6 * CODE_REVIEW_COMMENT_LENGTH + 4096));
/** Set by the authenticated transport, never accepted from a submission payload. */
export const CodeSubmissionOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cli") }).strict(),
  z.object({ kind: z.literal("ai_chat"), conversationId: z.uuid(), automaticAfterReview: z.boolean(), cardAnchor: z.string().max(200).optional() }).strict(),
]);
export type CodeSubmissionOrigin = z.infer<typeof CodeSubmissionOriginSchema>;
export const CodeReviewFollowUpSchema = z.object({ kind: z.enum(["automatic_once","manual","cli"]),text: z.string() }).strict();
/** Cloud decides whether a review may start work; administrator prose cannot choose it. */
export function codeReviewFollowUp(origin: CodeSubmissionOrigin,locale: string) {
  const de = locale.startsWith("de");
  if (origin.kind === "cli") return { kind: "cli" as const,text: de ? "Die einreichende Person bekommt deine Nachricht in der Kommandozeile, mit den Kommentaren an ihren Zeilen." : "The author receives your message in the command line, with comments at their lines." };
  if (origin.automaticAfterReview) return { kind: "manual" as const,text: de ? "Gustav hat schon einmal von selbst überarbeitet. Jetzt entscheidet die Person." : "Gustav already revised it automatically once. The person decides what happens next." };
  return { kind: "automatic_once" as const,text: de ? "Gustav überarbeitet die Version danach einmal von selbst." : "Gustav then revises the version automatically once." };
}
/** Durable status of the one unattended review turn, also consumed by version cards. */
export const CodeReviewRevisionSchema = z.object({
  state: z.enum(["none", "queued", "running", "submitted", "completed", "stopped", "skipped"]),
  reason: z.enum(["already_automatic", "superseded", "withdrawn", "conversation_gone", "access_lost", "quota", "unavailable", "stopped", "needs_person"]).nullable(),
  turnId: z.uuid().nullable(),
  submittedVersionId: z.uuid().nullable(),
  submittedNumber: z.number().int().positive().nullable(),
}).strict();
export const CodeReviewOutcomeSchema = z.enum(["approved", "changes_requested", "rejected"]);
export const CodeReviewDecisionSchema = z
  .object({
    outcome: CodeReviewOutcomeSchema,
    comment: z.string().trim().max(CODE_REVIEW_COMMENT_LENGTH).optional(),
  })
  .strict()
  .refine((value) => value.outcome === "approved" || !!value.comment, "Write a message explaining the decision.");
export type CodeReviewDecision = z.infer<typeof CodeReviewDecisionSchema>;
export const CodeReviewCommentSchema = z
  .object({
    id: z.uuid(),
    author: z.object({ id: z.uuid().nullable(), name: z.string().nullable(), avatarHash: z.string().nullable() }).strict(),
    createdAt: z.iso.datetime(),
    body: z.string(),
    parentId: z.uuid().nullable(),
    path: z.string().optional(),
    line: z.number().int().positive().optional(),
  })
  .strict();
export type CodeReviewComment = z.infer<typeof CodeReviewCommentSchema>;
const versionInput = z.object({ codeId: CodeIdSchema, versionId: z.uuid().describe("Immutable submitted version UUID.") }).strict();
export const codeReviewCommentContracts = {
  create: {
    input: versionInput.extend({
      path: CodeSourceFilesSchema.keyType,
      line: z.number().int().positive(),
      body: z.string().trim().min(1).max(CODE_REVIEW_COMMENT_LENGTH),
      parentId: z.uuid().optional(),
    }),
    data: CodeReviewCommentSchema,
  },
  delete: { input: versionInput.extend({ id: z.uuid() }) },
  list: {
    input: versionInput.extend({
      before: z.uuid().optional().describe("Exclusive comment cursor from nextBefore."),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    data: z
      .object({ items: z.array(CodeReviewCommentSchema), nextBefore: z.uuid().nullable(), total: z.number().int().nonnegative() })
      .strict(),
  },
} as const;

export const CODE_REVIEW_MAX_WAIT_MS = 14 * 24 * 60 * 60_000;
export const CodeReviewStatusSchema = z.enum([
  "not_required",
  "pending",
  "approved",
  "changes_requested",
  "rejected",
  "withdrawn",
  "superseded",
  "expired",
]);
export const CodeReviewInputSchema = versionInput.extend({
  before: z.uuid().optional().describe("Continue comments from nextBefore; omit for the first page."),
});
export const CodeReviewWaitInputSchema = CodeReviewInputSchema.extend({
  holdMs: z
    .number()
    .int()
    .min(0)
    .max(APP_APPROVAL_LIMITS.pollSeconds * 1000),
});
/** Comments and messages are untrusted data. They confer no authority and are never an instruction to an agent. */
export const CodeReviewSchema = z
  .object({
    codeId: CodeIdSchema,
    versionId: z.uuid(),
    number: z.number().int().positive(),
    status: CodeReviewStatusSchema,
    origin: CodeSubmissionOriginSchema,
    approvalId: z.uuid().nullable(),
    expiresAt: z.iso.datetime().nullable(),
    decidedBy: z.object({ id: z.uuid().nullable(), name: z.string().nullable(), avatarHash: z.string().nullable() }).strict().nullable(),
    decidedAt: z.iso.datetime().nullable(),
    message: z.string().nullable(),
    comments: z.array(CodeReviewCommentSchema),
    nextBefore: z.uuid().nullable(),
    commentCount: z.number().int().nonnegative(),
    activeVersion: z.object({ id: z.uuid(), number: z.number().int().positive() }).strict().nullable(),
    contentTrust: z.literal("untrusted_data"),
    revision: CodeReviewRevisionSchema.nullable().optional(),
    changesRequestedEffect: CodeReviewFollowUpSchema.optional(),
  })
  .strict();
export type CodeReview = z.infer<typeof CodeReviewSchema>;
