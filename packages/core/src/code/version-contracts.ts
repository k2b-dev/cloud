import { CloudResourceRefSchema } from "@k2b/cloud/contracts";
import { z } from "zod";
import { CodeIdSchema, CodeSourceFilesSchema, CodeVersionSchema } from "./contracts";
import { CodePolicyManifestSchema, CodePolicyRowSchema } from "./policy-contracts";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
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
/** Exact comparison evidence. Decisions must send this unchanged from version.diff or submit. */
export const CodeVersionBindingSchema = z
  .object({
    codeId: CodeIdSchema,
    versionId: z.uuid(),
    sourceHash: hash,
    bundleHash: hash,
    manifestHash: hash,
    comparisonVersionId: z.uuid().nullable(),
    comparisonSourceHash: hash.nullable(),
    comparisonBundleHash: hash.nullable(),
  })
  .strict();
/** Hash and baseline binding, also persisted independently of expiring platform requests. */
export type CodeVersionBinding = z.infer<typeof CodeVersionBindingSchema>;
/** Full ordered rows, directly assignable to @k2b/ui CodeDiffFile; no hunk truncation or hidden context. */
export const CodeVersionDiffFileSchema = z
  .object({
    path: z.string(),
    lines: z.array(z.object({ kind: z.enum(["same", "add", "del"]), text: z.string() }).strict()),
  })
  .strict();
/** Full file rows for CodeDiff, including unchanged files and deleted files. */
export type CodeVersionDiffFile = z.infer<typeof CodeVersionDiffFileSchema>;
export const CodeVersionDecisionSchema = z
  .object({
    approved: z.boolean(),
    decidedBy: z.uuid().nullable(),
    decidedAt: z.iso.datetime(),
    soleAdmin: z.boolean(),
    label: z.string(),
  })
  .strict();
/** Receipt for version lists; sole-admin self-approval is explicitly labelled in the requested locale. */
export type CodeVersionDecision = z.infer<typeof CodeVersionDecisionSchema>;
const submission = z
  .object({
    version: CodeVersionSchema,
    binding: CodeVersionBindingSchema,
    status: z.enum(["submitted", "pending", "approved", "rejected", "expired", "cancelled"]),
    approvalId: z.uuid().nullable(),
    decision: CodeVersionDecisionSchema.nullable(),
  })
  .strict();
/** Submission metadata consumed by version lists, activation, CLI and approval UI. */
export type CodeVersionSubmission = z.infer<typeof submission>;
/** C8 capability schemas. A base conflict returns code_version_conflict with latestVersionId and full files in error.details. */
export const codeVersionContracts = {
  submit: {
    input: z
      .object({
        codeId: CodeIdSchema,
        sourceFiles: CodeSourceFilesSchema,
        bundle: z.string(),
        manifest: CodeCheckedVersionManifestSchema,
        baseVersionId: z.uuid().nullable().describe("Latest saved version UUID, or null for the first push."),
      })
      .strict(),
    data: submission,
  },
  diff: {
    input: z.object({ codeId: CodeIdSchema, versionId: z.uuid() }).strict(),
    data: z
      .object({
        binding: CodeVersionBindingSchema,
        staleComparison: z.boolean(),
        files: z.array(CodeVersionDiffFileSchema),
        permissions: z.array(CodeVersionPermissionSchema),
        policyRows: z.array(CodePolicyRowSchema),
      })
      .strict(),
  },
  list: {
    input: z
      .object({
        codeId: CodeIdSchema,
        before: z.number().int().positive().optional().describe("Version number from nextBefore, exclusive."),
        limit: z.number().int().min(1).max(50).default(20),
      })
      .strict(),
    data: z.object({ items: z.array(submission), nextBefore: z.number().int().positive().nullable() }).strict(),
  },
  decide: { input: CodeVersionBindingSchema, data: submission },
  pause: { input: z.object({ codeId: CodeIdSchema }).strict(), data: z.object({ state: z.literal("paused") }).strict() },
  resume: { input: z.object({ codeId: CodeIdSchema }).strict(), data: z.object({ state: z.literal("active") }).strict() },
} as const;
