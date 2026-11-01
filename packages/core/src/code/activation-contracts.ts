import { CODE_ACCESS_MAX_MANAGER_USER_IDS, CodeAccessTargetSchema } from "@k2b/cloud/contracts";
import { z } from "zod";
import { CodeIdSchema } from "./contracts";

/** Durable activation states. waiting retries automatically; rolling_back retains failed cleanup until it succeeds. */
export const CodeActivationStateSchema = z.enum([
  "pending",
  "preflight",
  "applying",
  "waiting",
  "rolling_back",
  "failed",
  "active",
  "cancelled",
]);
export type CodeActivationState = z.infer<typeof CodeActivationStateSchema>;
/** Exactly one failed target, with its stable refusal and provider-authored explanation. No permission request is created. */
export const CodeActivationFailureSchema = z
  .object({
    target: CodeAccessTargetSchema.nullable(),
    code: z.string(),
    reason: z.string(),
    readable: z.boolean().optional(),
    title: z.string().max(500).optional(),
    managerUserIds: z.array(z.uuid()).max(CODE_ACCESS_MAX_MANAGER_USER_IDS).optional(),
    /**
     * The target's managers as the reader sees them: only for a target the reader may read, and only names directory
     * visibility allows (members see other people, guests only themselves). Accounts that are gone are left out.
     */
    managers: z
      .array(z.object({ id: z.uuid(), name: z.string() }).strict())
      .max(CODE_ACCESS_MAX_MANAGER_USER_IDS)
      .optional(),
  })
  .strict();
export type CodeActivationFailure = z.infer<typeof CodeActivationFailureSchema>;
/** Stable status for C10/C18a/C23/C25. A process ID survives retries and is also the idempotency identity. */
export const CodeActivationSchema = z
  .object({
    id: z.uuid(),
    codeId: CodeIdSchema,
    versionId: z.uuid(),
    state: CodeActivationStateSchema,
    failure: CodeActivationFailureSchema.nullable(),
    mandateId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type CodeActivation = z.infer<typeof CodeActivationSchema>;
/** Live target access is an observation. Reading or reconciling it never restores a removed grant. */
export const CodeTargetAccessSchema = z
  .object({
    grantId: z.uuid(),
    target: CodeAccessTargetSchema,
    operations: z.array(z.string()),
    /** Person whose activation created this grant; null after that account was deleted. */
    activatedBy: z.uuid().nullable(),
    /** When that activation became active; null while it has not finished. */
    activatedAt: z.iso.datetime().nullable(),
    /** The version whose activation created this grant; later versions with the same permission reuse it. */
    activatedVersionId: z.uuid(),
    state: z.enum(["present", "removed", "unavailable"]),
    /**
     * For a removed grant: the person whose `code.access.rm` removed it and when, from that removal's audit event.
     * Null when no such event is known, for example after audit retention or for a removal by Core's cleanup.
     */
    removedBy: z.uuid().nullable(),
    removedAt: z.iso.datetime().nullable(),
  })
  .strict();
export type CodeTargetAccess = z.infer<typeof CodeTargetAccessSchema>;
/** Core HTTP/service contracts; activation always enters Core with the original interactive authority. */
export const codeActivationContracts = {
  activate: {
    input: z
      .object({
        codeId: CodeIdSchema,
        versionId: z.uuid().describe("Submitted immutable version UUID."),
        activationId: z.uuid().describe("Caller-generated activation UUID; reuse after a lost response."),
      })
      .strict(),
    data: CodeActivationSchema,
  },
  read: {
    input: z.object({ codeId: CodeIdSchema, activationId: z.uuid().describe("Durable activation UUID.") }).strict(),
    data: CodeActivationSchema,
  },
  cancel: {
    input: z.object({ codeId: CodeIdSchema, activationId: z.uuid().describe("Unfinished activation to cancel and roll back.") }).strict(),
    data: CodeActivationSchema,
  },
  access: { input: z.object({ codeId: CodeIdSchema }).strict(), data: z.array(CodeTargetAccessSchema) },
} as const;
