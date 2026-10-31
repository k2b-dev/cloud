import { z } from "zod";
import { CloudResourceRefSchema } from "./capabilities";

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
/** Checker evidence for a statically resolved operation, its exact target and source location. */
export const CodeVersionPermissionSchema = z
  .object({
    operation: z.string().min(1),
    kind: z.enum(["query", "action"]),
    target: CloudResourceRefSchema.nullable(),
    refs: z.record(z.string(), CloudResourceRefSchema),
    row: CodePolicyRowSchema,
    entrypoint: z.string().min(1),
    location: z.object({ path: z.string().min(1), line: z.number().int().positive() }).strict(),
  })
  .strict();
/** One statically resolved permission in the immutable checked manifest. */
export type CodeVersionPermission = z.infer<typeof CodeVersionPermissionSchema>;
/** G6 checker fixture contract until C16 supplies its producer. Hashes cover the exact submitted snapshot.
 * policyRows includes all operation rows plus AI/internet use; permissions are complete static checker evidence.
 * A caller-supplied manifest never grants execution authority: dispatch still checks every actual call.
 */
export const CodeCheckedVersionManifestSchema = CodePolicyManifestSchema.extend({
  formatVersion: z.literal(1),
  sourceHash: hash,
  bundleHash: hash,
  permissions: z.array(CodeVersionPermissionSchema),
})
  .strict()
  .superRefine((manifest, ctx) => {
    for (const permission of manifest.permissions) {
      if (!manifest.policyRows.includes(permission.row))
        ctx.addIssue({ code: "custom", message: "Operation classification missing from policyRows" });
      if (permission.kind === "query" && permission.row !== "read")
        ctx.addIssue({ code: "custom", message: "Queries require the read classification" });
      if (permission.kind === "action" && ["read", "ai", "internet"].includes(permission.row))
        ctx.addIssue({ code: "custom", message: "Actions require an Action classification" });
    }
  });
/** Immutable manifest consumed by submission, activation, CLI, chat tools and the checker. */
export type CodeCheckedVersionManifest = z.infer<typeof CodeCheckedVersionManifestSchema>;
