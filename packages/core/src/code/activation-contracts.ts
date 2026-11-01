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
/** The refusal names a few managers, enough for someone to know whom to ask. */
export const CODE_ACTIVATION_MANAGER_NAMES = 5;
/** Exactly one failed target, with its stable refusal and provider-authored explanation. No permission request is created. */
export const CodeActivationFailureSchema = z
  .object({
    target: CodeAccessTargetSchema.nullable(),
    code: z.string(),
    reason: z.string(),
    readable: z.boolean().optional(),
    title: z.string().max(500).optional(),
    managerUserIds: z.array(z.uuid()).max(CODE_ACCESS_MAX_MANAGER_USER_IDS).optional(),
    /** Display names of the first managers, added to a status answer only after the current reader check. Never stored. */
    managerNames: z.array(z.string()).max(CODE_ACTIVATION_MANAGER_NAMES).optional(),
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
/**
 * What each target would answer if the person switched this version on now, asked before they do. Nothing is written.
 * `granted`: the target accepts this person. `refused`: it does not, with the same reader-checked failure an activation
 * reports. `unknown`: the target did not answer, and only activating decides. A target left out needs no new answer,
 * because the running version already holds its access. Activation checks everything again.
 */
export const CodeActivationCheckSchema = z
  .object({
    targets: z.array(
      z
        .object({
          target: CodeAccessTargetSchema,
          state: z.enum(["granted", "refused", "unknown"]),
          failure: CodeActivationFailureSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type CodeActivationCheck = z.infer<typeof CodeActivationCheckSchema>;
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
/** Who may switch on, as far as this person can do it from where they are. Phone and non-interactive credentials cannot. */
export const CodeActivationAllowedSchema = z.discriminatedUnion("allowed", [
  z.object({ allowed: z.literal(true) }).strict(),
  z.object({ allowed: z.literal(false), reason: z.enum(["phone", "credential"]) }).strict(),
]);
/** One target a version needs and what this person's switching on would do there, decided by the target itself. */
export const CodeActivationPreviewRowSchema = z
  .object({
    target: CodeAccessTargetSchema,
    /** Empty for an owner that is only checked. */
    operations: z.array(z.string()),
    own: z.boolean(),
    /** The running version does not have this access yet. */
    isNew: z.boolean(),
    /** `manages`: the target agrees. `blocked`: it refuses this person. `has`: the running version's grant stays. `unknown`: it did not answer. */
    check: z.enum(["manages", "blocked", "has", "unknown"]),
    /** Only after the target's own reader check; otherwise null and the row shows its ID. */
    title: z.string().nullable(),
    typeTitle: z.string().nullable(),
    /** The target type's icon, with its title. */
    icon: z.string().nullable(),
    /** Who manages a refusing target, only for a person who may read it. */
    managers: z.array(z.object({ name: z.string(), firstName: z.string().nullable() }).strict()).max(CODE_ACTIVATION_MANAGER_NAMES),
  })
  .strict();
export type CodeActivationPreviewRow = z.infer<typeof CodeActivationPreviewRowSchema>;
/**
 * What switching on one submitted version would do for this person, before they click. Read-only: every check is a
 * target's own dry run, so nothing is granted and no activation exists. Only the latest waiting version is checked.
 */
export const CodeActivationPreviewSchema = z
  .object({
    codeId: CodeIdSchema,
    title: z.string(),
    ownerKind: z.enum(["person", "resource", "app"]),
    versionId: z.uuid(),
    number: z.number().int().positive(),
    /** The running version's number; null when none runs. */
    running: z.number().int().positive().nullable(),
    /** The newest submitted version's number. */
    latest: z.number().int().positive(),
    /** Set when this is the running version: when it was switched on and by whom, as far as this person may see it. */
    activated: z.object({ at: z.iso.datetime(), byYou: z.boolean(), byName: z.string().nullable() }).strict().nullable(),
    allowed: CodeActivationAllowedSchema,
    /** `ready`, or what must happen first; `refused` carries Core's own reason for a version that can never switch on as it is. */
    readiness: z.discriminatedUnion("state", [
      z.object({ state: z.literal("ready") }).strict(),
      z.object({ state: z.literal("approval_pending") }).strict(),
      z.object({ state: z.literal("refused"), code: z.string(), message: z.string() }).strict(),
    ]),
    /** The resource that holds this Code, as far as this person may read it; null otherwise and for personal Code. */
    place: z.object({ title: z.string(), typeTitle: z.string().nullable(), href: z.string().nullable() }).strict().nullable(),
    rows: z.array(CodeActivationPreviewRowSchema),
  })
  .strict();
export type CodeActivationPreview = z.infer<typeof CodeActivationPreviewSchema>;
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
  check: {
    input: z.object({ codeId: CodeIdSchema, versionId: z.uuid().describe("Submitted immutable version UUID.") }).strict(),
    data: CodeActivationCheckSchema,
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
  preview: {
    input: z.object({ codeId: CodeIdSchema, versionId: z.uuid().describe("Submitted immutable version UUID.") }).strict(),
    data: CodeActivationPreviewSchema,
  },
} as const;
