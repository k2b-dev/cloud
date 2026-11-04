import { CloudResourceRefSchema } from "@k2b/cloud/contracts";
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
/** Core's operational activation failure; no target rights or manager presentation. */
export const CodeActivationFailureSchema = z.object({
  target: CloudResourceRefSchema.nullable(),
  code: z.string(),
  reason: z.string(),
});
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
/** Who may switch on, as far as this person can do it from where they are. Phone and non-interactive credentials cannot. */
export const CodeActivationAllowedSchema = z.discriminatedUnion("allowed", [
  z.object({ allowed: z.literal(true) }).strict(),
  z.object({ allowed: z.literal(false), reason: z.enum(["phone", "credential"]) }).strict(),
]);
/**
 * Version and approval state before switching on. Reading this never checks or changes target rights.
 */
export const CodeActivationPreviewSchema = z
  .object({
    codeId: CodeIdSchema,
    title: z.string(),
    ownerKind: z.enum(["person", "resource", "app"]),
    automations: z.array(z.object({ entrypoint: z.string(), title: z.string().optional() }).strict()).optional(),
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
  read: {
    input: z.object({ codeId: CodeIdSchema, activationId: z.uuid().describe("Durable activation UUID.") }).strict(),
    data: CodeActivationSchema,
  },
  cancel: {
    input: z.object({ codeId: CodeIdSchema, activationId: z.uuid().describe("Unfinished activation to cancel and roll back.") }).strict(),
    data: CodeActivationSchema,
  },
  preview: {
    input: z.object({ codeId: CodeIdSchema, versionId: z.uuid().describe("Submitted immutable version UUID.") }).strict(),
    data: CodeActivationPreviewSchema,
  },
} as const;
