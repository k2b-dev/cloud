import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
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
    .refine((rows) => new Set(rows).size === rows.length, "Policy classifications must be unique"),
});
/** Checked immutable version classifications; policyRows contains each used row once. */
export type CodePolicyManifest = z.infer<typeof CodePolicyManifestSchema>;
/** C16 checker permission, retaining separate source rows for targets and refs. Null id is a dynamic personal target. */
export const CodeVersionPermissionSchema = z
  .object({
    operation: z.string().min(1),
    target: z
      .object({ type: z.string().min(1), id: z.string().min(1).nullable() })
      .strict()
      .nullable(),
    file: z.string().min(1),
    line: z.number().int().positive(),
  })
  .strict();
/** One permission emitted by C16, with its source location. */
export type CodeVersionPermission = z.infer<typeof CodeVersionPermissionSchema>;
/** C16's immutable manifest plus the host's original check entry and C7 policyRows.
 * Copy version/entrypoints/permissions/ai/hashes unchanged from checkCode's result.
 * entry comes from CodeCheckRequest.entry; policyRows comes from trusted operation metadata.
 * A manifest is evidence, never execution authority: dispatch checks each actual call.
 */
export const CodeCheckedVersionManifestSchema = CodePolicyManifestSchema.extend({
  version: z.literal(1),
  entry: z.string().min(1),
  entrypoints: z.array(
    z
      .object({
        kind: z.enum(["schedule", "manual"]),
        entrypoint: z.string().min(1),
        cron: z.string().nullable(),
        file: z.string().min(1),
        line: z.number().int().positive(),
      })
      .strict(),
  ),
  permissions: z.array(CodeVersionPermissionSchema),
  ai: z.boolean(),
  hashes: z.object({ source: hash, sdk: hash, bundle: hash }).strict(),
})
  .strict()
  .superRefine((manifest, ctx) => {
    if (manifest.ai && !manifest.policyRows.includes("ai"))
      ctx.addIssue({ code: "custom", message: "AI classification missing from policyRows" });
  });
/** C16 evidence enriched by the trusted host for submission, activation, CLI and chat tools. */
export type CodeCheckedVersionManifest = z.infer<typeof CodeCheckedVersionManifestSchema>;
