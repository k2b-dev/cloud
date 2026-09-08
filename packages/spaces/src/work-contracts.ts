import { z } from "zod";

// Work notes share the existing description/comment budget.
export const WorkTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(5000)
  .describe("Full Markdown work note, including decisions, next steps or verification evidence.");
export const WorkActorSchema = z.object({ kind: z.enum(["user", "service_account"]), id: z.uuid() }).strict();
export const WorkClaimSchema = z.object({ id: z.uuid(), actor: WorkActorSchema, claimedAt: z.string().datetime() }).strict();
export const WorkNoteSchema = z.object({ content: WorkTextSchema, actor: WorkActorSchema, at: z.string().datetime() }).strict();
export const WorkResultSchema = WorkNoteSchema.extend({
  commit: z
    .string()
    .regex(/^[a-fA-F0-9]{7,64}$/)
    .nullable(),
}).strict();
export const TaskWorkSchema = z
  .object({ claim: WorkClaimSchema.nullable(), progress: WorkNoteSchema.nullable(), result: WorkResultSchema.nullable() })
  .strict();
export const ClaimTaskSchema = z
  .object({ claimId: z.uuid().describe("Caller-generated ID; reuse only when retrying this claim.") })
  .strict();
export const ReleaseTaskSchema = ClaimTaskSchema.extend({
  force: z.boolean().optional().describe("Admin recovery: release the exact observed claim, including another actor's claim."),
});
export const ProgressTaskSchema = z
  .object({ content: WorkTextSchema, claimId: z.uuid().optional().describe("Current worker claim ID; required when the task is claimed.") })
  .strict();
export const CompletionFields = {
  result: WorkTextSchema.optional().describe("Full completion result including verification; saved atomically with completion."),
  commit: WorkResultSchema.shape.commit.unwrap().optional().describe("Commit SHA implementing this result; requires result."),
  claimId: z.uuid().optional().describe("Current worker claim ID; required when the task is claimed."),
};
export const CompletionInputSchema = z
  .object({
    completed: z.boolean().describe("True completes an unblocked task; false reopens it without erasing its result."),
    ...CompletionFields,
  })
  .superRefine((value, ctx) => {
    if (
      (!value.completed && (value.result !== undefined || value.commit !== undefined)) ||
      (value.commit !== undefined && value.result === undefined)
    )
      ctx.addIssue({ code: "custom", message: "A completion result is required with a commit; results can only be saved when completing" });
  });
export type TaskWork = z.infer<typeof TaskWorkSchema>;
export type WorkActor = z.infer<typeof WorkActorSchema>;
