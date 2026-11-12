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
/** A target or event place as the Code page names it, from registry manifests alone. */
const PreviewTargetSchema = z
  .object({
    key: z.string(),
    ref: z.object({ type: z.string(), id: z.string() }).strict(),
    title: z.string().nullable(),
    typeTitle: z.string().nullable(),
    icon: z.string().nullable(),
    own: z.boolean(),
    href: z.string().nullable(),
  })
  .strict();
/**
 * Version and approval state before switching on. Reading this never checks or changes target rights.
 */
export const CodeActivationPreviewSchema = z
  .object({
    codeId: CodeIdSchema,
    title: z.string(),
    ownerKind: z.enum(["person", "resource", "app"]),
    /** For Code of an app: the app's name from the registry, which names its service account; null when unknown. */
    appName: z.string().nullable().optional(),
    automations: z
      .array(
        z
          .object({
            entrypoint: z.string(),
            title: z.string().optional(),
            route: z.object({ method: z.string(), path: z.string(), public: z.boolean() }).strict().optional(),
            /** The event it follows: its title from the catalog, null when unknown, and its place named as a target. */
            event: z.object({ type: z.string(), title: z.string().nullable(), place: PreviewTargetSchema }).strict().optional(),
            /** A repeating schedule's five-field expression, so the card can say when it runs. */
            cron: z.string().optional(),
            /** A one-time schedule's instant and the zone it is read in. */
            at: z.string().optional(),
            timeZone: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    /** Every internet origin the version may call, as the Code page lists them. */
    internet: z.array(z.string()).optional(),
    /** The names of the secrets the version may send, each only to its own origin. */
    secrets: z.array(z.object({ name: z.string(), origin: z.string() }).strict()).optional(),
    /** Whether the version uses its own database. */
    database: z.boolean().optional(),
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
    /** The Code page of a resource Code, from the `code.pages` pattern its owner's app declares; null when it declares none. */
    page: z.string().nullable().optional(),
    /**
     * For the version that would switch on next: each target its checked manifest calls, with the operations there and
     * whether that is new compared with the running version, as the Code page lists them. A null target collects the
     * calls whose target the Code picks while it runs. Review evidence, never a grant: each call checks current access.
     */
    /** Titles and app names of the operations in `targets`, as the Code page names them; unknown ones are left out. */
    operationLabels: z.record(z.string(), z.object({ title: z.string(), app: z.string().nullable() }).strict()).optional(),
    targets: z
      .array(
        z
          .object({
            target: PreviewTargetSchema.nullable(),
            operations: z.array(z.string()),
            isNew: z.boolean(),
          })
          .strict(),
      )
      .optional(),
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
