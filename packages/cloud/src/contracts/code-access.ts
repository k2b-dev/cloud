import type { SQL } from "bun";
import { z } from "zod";
import type { CapabilityExecutionContext } from "./capabilities";
import { CAPABILITY_MAX_RESULT_BYTES } from "./capability-limits";

/** A Code target is either a qualified resource type or the whole receiving application. */
export const CodeAccessTargetSchema = z
  .object({
    type: z
      .string()
      .max(200)
      .regex(/^(app|[a-z][a-z0-9-]*\.[a-z][a-z0-9._-]*)$/)
      .describe("Qualified resource type, or app for the whole receiving application."),
    id: z.string().min(1).max(512).describe("Resource ID, or the receiving application ID for an app target."),
  })
  .strict();
export type CodeAccessTarget = z.infer<typeof CodeAccessTargetSchema>;
/** One manifest has at most 200 operations. Operations are qualified capability IDs. */
export const CodeAccessOperationsSchema = z
  .array(
    z
      .string()
      .max(200)
      .regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9._-]*$/),
  )
  .max(200)
  .refine((operations) => new Set(operations).size === operations.length, "Operations must be unique");
export const CodeAccessLevelSchema = z
  .string()
  .min(1)
  .max(120)
  .refine((level) => level.toLowerCase() !== "admin", "Code never receives admin");
/** A serialized UUID costs 39 bytes including quotes/separator. The complete set
 * response must also fit CAPABILITY_MAX_RESULT_BYTES; the platform checks its envelope.
 */
export const CODE_ACCESS_MAX_MANAGER_USER_IDS = Math.floor(CAPABILITY_MAX_RESULT_BYTES / 39);
const managerUserIdsSchema = z.array(z.uuid()).max(CODE_ACCESS_MAX_MANAGER_USER_IDS);
export const CodeAccessDecisionSchema = z.discriminatedUnion("granted", [
  z.object({ granted: z.literal(true), level: CodeAccessLevelSchema, managerUserIds: managerUserIdsSchema.optional() }).strict(),
  z.object({ granted: z.literal(false), reason: z.string().min(1).max(1000) }).strict(),
]);
export type CodeAccessDecision = z.infer<typeof CodeAccessDecisionSchema>;
/** Entries describe only this account's explicit Code grants, never inherited or public access. */
export const CodeAccessEntrySchema = z.object({ grantId: z.uuid(), id: z.string().min(1).max(512), level: CodeAccessLevelSchema }).strict();
export type CodeAccessEntry = z.infer<typeof CodeAccessEntrySchema>;
export const CodeAccessGrantSchema = CodeAccessEntrySchema.omit({ id: true }).extend({
  target: CodeAccessTargetSchema,
  principal: z.uuid(),
});
export type CodeAccessGrant = z.infer<typeof CodeAccessGrantSchema>;

/**
 * Implement all four functions at a resource type or at code.access.app.
 * Use only the supplied transaction for reads and writes; no external effects.
 * manages must lock the target's manager authority until this transaction ends,
 * using the same row/table lock as every path that changes that authority.
 * Lock before reading current grants, ownership and membership; never rely on
 * context's cached roles/groups or acquire a separate database connection.
 * For example, lock the target row FOR UPDATE when all manager mutations lock it
 * too. Locking existing share rows alone does not protect absent/new shares.
 * The platform checks installation-admin authority separately in this transaction.
 * A live Cloud admin bypasses manages. grant/revoke must therefore lock and check
 * the target themselves, including its existence; do not assume manages ran.
 * Person listings call manages for multiple targets in one transaction. Prefer
 * shared locks when all manager changes conflict with them; otherwise use the
 * same deterministic target-lock order across listings and domain mutations.
 * Platform grant/account locks precede adapter target locks; never call platform
 * grant cleanup while already holding a target lock in a domain transaction.
 * grant chooses the smallest non-manager level covering all operations, or refuses.
 * Successful dry runs include managerUserIds: the current people managing the target,
 * including inherited group managers, for Core activation notifications.
 * dryRun must return the same decision without effects (the platform also rolls back).
 * Normal target share lists must expose grantId on each Code share so the rights editor
 * can call code.access.rm directly; ordinary shares never carry it.
 * A grantId identifies an explicit Code-only grant; revoke never removes ordinary shares.
 * Successful dry-run decisions identify current human managers in managerUserIds for
 * Core Cloud-admin activation notices; real and replayed sets may omit this metadata. Include direct and group administrators;
 * Core refuses Cloud-admin activation when this metadata is unavailable.
 * Keep grants with different IDs independent, including overlapping grants for the same
 * account and target. Activation rollback removes only its new IDs, preserving older grants.
 */
export type CodeAccessAdapter = {
  manages: (tx: SQL, context: CapabilityExecutionContext, id: string) => boolean | Promise<boolean>;
  grant: (
    tx: SQL,
    input: { id: string; principal: string; operations: readonly string[]; grantId: string; dryRun: boolean },
  ) => CodeAccessDecision | Promise<CodeAccessDecision>;
  revoke: (tx: SQL, input: { id: string; grantId: string }) => boolean | Promise<boolean>;
  list: (tx: SQL, input: { principal: string }) => readonly CodeAccessEntry[] | Promise<readonly CodeAccessEntry[]>;
};
/** App-wide admission and resource types whose resources may own Code. */
export type CodeAccessDeclaration = CodeAccessAdapter | { manages?: never; grant?: never; revoke?: never; list?: never };
export type CapabilityCodeDefinition = { access?: { app?: CodeAccessAdapter }; owners?: readonly string[] };

export const CodeAccessSetInputSchema = z
  .object({
    proof: z
      .string()
      .min(1)
      .max(64 * 1024)
      .describe("Short-lived Core-signed activation proof."),
    target: CodeAccessTargetSchema.describe("Exact target bound by the activation proof."),
    operations: CodeAccessOperationsSchema.describe("Complete set of qualified operations requested at this target."),
    dryRun: z.boolean().optional().describe("Check availability without committing any permission changes."),
  })
  .strict();
/** Stable platform refusal codes for activation and rights-editor recovery. Adapter copy remains separate. */
export const CodeAccessRefusalCodeSchema = z.enum([
  "origin_forbidden",
  "proof_invalid",
  "not_manager",
  "removed",
  "binding_conflict",
  "account_inactive",
  "unsupported_target",
  "operations_invalid",
  "adapter_refused",
  "capacity_exceeded",
]);
export type CodeAccessRefusalCode = z.infer<typeof CodeAccessRefusalCodeSchema>;

export const CodeAccessSetDataSchema = z.discriminatedUnion("granted", [
  z
    .object({ granted: z.literal(true), grantId: z.uuid(), level: CodeAccessLevelSchema, managerUserIds: managerUserIdsSchema.optional() })
    .strict(),
  z.object({ granted: z.literal(false), reasonCode: CodeAccessRefusalCodeSchema, reason: z.string().min(1).max(1000) }).strict(),
]);
export type CodeAccessSetData = z.infer<typeof CodeAccessSetDataSchema>;
export const CodeAccessListInputSchema = z
  .object({ principal: z.uuid().describe("Code service-account ID whose explicit grants are requested.") })
  .strict();
export const CodeAccessListDataSchema = z.array(CodeAccessGrantSchema);
export const CodeAccessRemoveInputSchema = z.object({ grantId: z.uuid().describe("Explicit Code grant identity to remove.") }).strict();
export const CodeAccessRemoveDataSchema = z.object({ removed: z.boolean() }).strict();

/** Discoverable Code targets and owners; functions remain local to the receiving app. */
export const CapabilityCodeManifestSchema = z
  .object({
    access: z.object({ app: z.boolean(), types: z.array(z.string().min(1).max(100)).max(200) }).strict(),
    owners: z.array(z.string().min(1).max(100)).max(200),
  })
  .strict();
export type CapabilityCodeManifest = z.infer<typeof CapabilityCodeManifestSchema>;
