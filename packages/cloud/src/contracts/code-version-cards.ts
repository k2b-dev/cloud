import { z } from "zod";
import { CodePageLinksSchema } from "./code-routes";

/** Same receipt window as code.version.list; callers split longer histories into bounded pages. */
export const CODE_VERSION_CARD_BATCH_LIMIT = 50;
const identity = z.strictObject({
  codeId: z
    .string()
    .regex(/^c_[a-z0-9]{4,16}$/)
    .describe("Stable Code ID."),
  versionId: z.uuid().describe("UUID of the saved version."),
});
const person = z.strictObject({ id: z.string().nullable(), name: z.string().nullable(), avatarHash: z.string().nullable() });
export const CodeVersionCardSnapshotSchema = z.strictObject({
  preview: identity.extend({
    title: z.string(),
    ownerKind: z.enum(["person", "resource", "app"]),
    page: z.string().nullable(),
    number: z.number().int().positive(),
    running: z.number().int().positive().nullable(),
    latest: z.number().int().positive(),
    activated: z.strictObject({ at: z.iso.datetime(), byYou: z.boolean(), byName: z.string().nullable() }).nullable(),
    allowed: z.discriminatedUnion("allowed", [
      z.strictObject({ allowed: z.literal(true) }),
      z.strictObject({ allowed: z.literal(false), reason: z.enum(["phone", "credential"]) }),
    ]),
    readiness: z.discriminatedUnion("state", [
      z.strictObject({ state: z.literal("ready") }),
      z.strictObject({ state: z.literal("approval_pending"), selfApproval: z.boolean().optional() }),
      z.strictObject({ state: z.literal("refused"), code: z.string(), message: z.string() }),
    ]),
  }),
  review: z
    .strictObject({
      status: z.enum(["not_required", "pending", "approved", "changes_requested", "rejected", "withdrawn", "superseded", "expired"]),
      origin: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("cli") }),
        z.strictObject({ kind: z.literal("ai_chat"), conversationId: z.string(), automaticAfterReview: z.boolean() }),
      ]),
      decidedBy: person.nullable(),
      message: z.string().nullable(),
      commentCount: z.number().int().nonnegative(),
      revision: z
        .strictObject({
          state: z.enum(["none", "queued", "running", "submitted", "completed", "stopped", "skipped"]),
          reason: z
            .enum([
              "already_automatic",
              "superseded",
              "withdrawn",
              "conversation_gone",
              "access_lost",
              "quota",
              "unavailable",
              "stopped",
              "needs_person",
            ])
            .nullable(),
          submittedNumber: z.number().int().nullable(),
        })
        .nullable(),
    })
    .nullable(),
  facts: z.array(z.string()).max(3),
  code: z.strictObject({
    state: z.enum(["draft", "active", "paused", "deleting"]),
    activeVersionId: z.string().nullable(),
    pausedAt: z.iso.datetime().nullable(),
    pausedBy: z.strictObject({ name: z.string() }).nullable(),
  }),
  /** Absent only when the caller already holds these immutable links and still has permission to open them. Null means unavailable, never an empty list. */
  pages: CodePageLinksSchema.nullable().optional(),
  latest: z.strictObject({ id: z.uuid(), number: z.number().int().positive() }).nullable(),
  permission: z.enum(["reader", "editor"]),
  canActivate: z.boolean(),
  canManage: z.boolean(),
});
export type CodeVersionCardSnapshot = z.infer<typeof CodeVersionCardSnapshotSchema>;
export const codeVersionCardsContract = {
  input: z.strictObject({
    versions: z
      .array(identity)
      .min(1)
      .max(CODE_VERSION_CARD_BATCH_LIMIT)
      .describe("Displayed Code/version pairs; at most the 50 receipts of code.version.list."),
    knownPages: z
      .array(z.uuid())
      .max(CODE_VERSION_CARD_BATCH_LIMIT)
      .default([])
      .describe("Versions whose immutable page links the view already holds. Every read still rechecks rights."),
  }),
  data: z.strictObject({
    items: z
      .array(
        z.discriminatedUnion("state", [
          identity.extend({ state: z.literal("available"), snapshot: CodeVersionCardSnapshotSchema }),
          identity.extend({ state: z.literal("denied") }),
        ]),
      )
      .max(CODE_VERSION_CARD_BATCH_LIMIT),
  }),
};
export type CodeVersionCards = z.infer<typeof codeVersionCardsContract.data>;
