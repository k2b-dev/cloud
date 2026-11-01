import { CodeCheckedVersionManifestSchema, CodeVersionPermissionSchema } from "@k2b/cloud/contracts";

export {
  type CodeCheckedVersionManifest,
  CodeCheckedVersionManifestSchema,
  type CodeVersionPermission,
  CodeVersionPermissionSchema,
} from "@k2b/cloud/contracts";

import { z } from "zod";
import { CodeIdSchema, CodeSourceFilesSchema, CodeVersionSchema } from "./contracts";
import { CodePolicyRowSchema } from "./policy-contracts";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
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
  diffRead: {
    input: z
      .object({
        codeId: CodeIdSchema,
        versionId: z.uuid(),
        comparisonVersionId: z.uuid().nullable(),
        offset: z.number().int().nonnegative().default(0),
        length: z.number().int().min(1).max(16_384).default(16_384),
      })
      .strict(),
    data: z.object({ content: z.object({ text: z.string(), nextOffset: z.number().int().nullable() }).strict() }).strict(),
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
