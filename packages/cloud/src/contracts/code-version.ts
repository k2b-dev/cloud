import { z } from "zod";
import { CodeSecretVersionBindingSchema } from "./code-secrets";

const hash = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .describe("Lowercase SHA-256 digest produced by the checker.");
/** Classification rows shared by the checker, activation, dispatcher and administration. */
export const CODE_POLICY_ROWS = [
  "read",
  "silent_you",
  "silent_draft",
  "silent_shared",
  "ask_sends",
  "ask_deletes",
  "ask_cannot_undo",
  "ask_involves_people",
  "ask_changes_access",
  "ask_keeps_working",
  "ask_sensitive",
  "ask_app_asks",
  "ai",
  "internet",
] as const;
export const CodePolicyRowSchema = z.enum(CODE_POLICY_ROWS);
/** Stable call classification shared by checker, activation, dispatcher and administration. */
export type CodePolicyRow = z.infer<typeof CodePolicyRowSchema>;
/** Required checked-manifest field. Missing/invalid classifications fail closed in the pause sweep. */
export const CodePolicyManifestSchema = z.object({
  policyRows: z
    .array(CodePolicyRowSchema)
    .max(CODE_POLICY_ROWS.length)
    .refine((rows) => new Set(rows).size === rows.length, "Policy classifications must be unique")
    .describe("Unique policy classifications covering every declared operation and AI or internet use."),
});
/** Checked immutable version classifications; policyRows contains each used row once. */
export type CodePolicyManifest = z.infer<typeof CodePolicyManifestSchema>;
/** Checker permission, retaining separate source rows for targets and refs. Null id is a dynamic personal target. */
export const CodeVersionPermissionSchema = z
  .object({
    operation: z.string().min(1).describe("Fully qualified operation ID from the capability catalog."),
    target: z
      .object({
        type: z.string().min(1).describe("Fully qualified target resource Type."),
        id: z.string().min(1).nullable().describe("Literal target ID, or null for a dynamic personal target."),
      })
      .strict()
      .nullable()
      .describe("Exact operation target, or null for an app-wide operation."),
    file: z.string().min(1).describe("Relative source file containing this declaration or operation."),
    line: z.number().int().positive().describe("One-based source line."),
  })
  .strict();
/** One permission emitted by the checker, with its source location. */
export type CodeVersionPermission = z.infer<typeof CodeVersionPermissionSchema>;
/** The checker's immutable manifest plus the host's original check entry and policyRows.
 * Copy version/entrypoints/permissions/ai/hashes unchanged from checkCode's result.
 * entry comes from CodeCheckRequest.entry; policyRows comes from trusted operation metadata.
 * A manifest is evidence, never execution authority: dispatch checks each actual call.
 */
export const CodeCheckedVersionManifestSchema = CodePolicyManifestSchema.extend({
  version: z.literal(1).describe("Checker manifest format version, currently 1."),
  entry: z.string().min(1).describe("Original checker entry path, included in the source hash."),
  entrypoints: z
    .array(
      z
        .object({
          kind: z.enum(["schedule", "manual"]).describe("Scheduled or manually invoked entrypoint."),
          entrypoint: z.string().min(1).describe("Named ESM export selected by the runner."),
          cron: z.string().nullable().describe("Five-field schedule expression, or null for manual execution."),
          file: z.string().min(1).describe("Relative source file containing this declaration or operation."),
          line: z.number().int().positive().describe("One-based source line."),
        })
        .strict(),
    )
    .describe("All named executable entrypoints detected by the checker."),
  permissions: z.array(CodeVersionPermissionSchema).describe("Every detected operation and target with its source location."),
  secrets: z
    .array(CodeSecretVersionBindingSchema)
    .refine((items) => new Set(items.map((item) => item.name)).size === items.length, "Secret names must be unique")
    .optional()
    .describe("Exact secret bindings reviewed with this version; absent means no secret access."),
  internet: z.boolean().optional().describe("Whether static SDK calls use public HTTPS."),
  ai: z.boolean().describe("Whether detected operations use AI."),
  hashes: z
    .object({ source: hash, sdk: hash, bundle: hash })
    .strict()
    .describe("Source, generated SDK and exact bundle digests from checking."),
})
  .strict()
  .superRefine((manifest, ctx) => {
    if (manifest.internet && !manifest.policyRows.includes("internet"))
      ctx.addIssue({ code: "custom", message: "Internet classification missing from policyRows" });
    if (manifest.secrets?.length && !manifest.policyRows.includes("internet"))
      ctx.addIssue({ code: "custom", message: "Secret bindings require internet classification" });
    if (manifest.ai && !manifest.policyRows.includes("ai"))
      ctx.addIssue({ code: "custom", message: "AI classification missing from policyRows" });
  });
/** Checker evidence enriched by the trusted host for submission, activation, CLI and chat tools. */
export type CodeCheckedVersionManifest = z.infer<typeof CodeCheckedVersionManifestSchema>;
