import { CodeCheckedVersionManifestSchema, CodeSecretVersionBindingSchema, CodeVersionPermissionSchema } from "@k2b/cloud/contracts";

export {
  type CodeCheckedVersionManifest,
  CodeCheckedVersionManifestSchema,
  type CodeVersionPermission,
  CodeVersionPermissionSchema,
} from "@k2b/cloud/contracts";

import { z } from "zod";
import { CodeIdSchema, CodeSourceFilesSchema, CodeVersionSchema } from "./contracts";
import { CodePolicyRowSchema } from "./policy-contracts";

const hash = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .describe("Lowercase SHA-256 digest from the unchanged version binding.");
/** Exact comparison evidence. Decisions must send this unchanged from version.diff or submit. */
export const CodeVersionBindingSchema = z
  .object({
    codeId: CodeIdSchema,
    versionId: z.uuid().describe("Immutable version UUID returned by submission or version history."),
    sourceHash: hash,
    bundleHash: hash,
    manifestHash: hash,
    comparisonVersionId: z.uuid().nullable().describe("Exact previous version UUID, or null for an empty comparison."),
    comparisonSourceHash: hash.nullable().describe("Previous source digest, or null for an empty comparison."),
    comparisonBundleHash: hash.nullable().describe("Previous bundle digest, or null for an empty comparison."),
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
/** C8 capability schemas. Base conflicts carry latestVersionId and diffRead in error.details; rows are included when the transport budget permits. */
export const codeVersionContracts = {
  submit: {
    input: z
      .object({
        codeId: CodeIdSchema,
        sourceFiles: CodeSourceFilesSchema.describe("Complete relative-path to exact source text map from the checker request."),
        bundle: z.string().describe("Exact checked UTF-8 ESM bundle; do not reformat it."),
        manifest: CodeCheckedVersionManifestSchema.describe(
          "Complete immutable checker evidence with the original entry and current policy classifications.",
        ),
        baseVersionId: z.uuid().nullable().describe("Latest saved version UUID, or null for the first push."),
      })
      .strict(),
    data: submission,
  },
  diff: {
    input: z.object({ codeId: CodeIdSchema, versionId: z.uuid().describe("Immutable version UUID to compare.") }).strict(),
    data: z
      .object({
        binding: CodeVersionBindingSchema,
        staleComparison: z.boolean(),
        files: z.array(CodeVersionDiffFileSchema),
        secrets: z.array(CodeSecretVersionBindingSchema),
        permissions: z.array(CodeVersionPermissionSchema),
        policyRows: z.array(CodePolicyRowSchema),
      })
      .strict(),
  },
  diffRead: {
    input: z
      .object({
        codeId: CodeIdSchema,
        versionId: z.uuid().describe("Immutable version UUID returned by submission or version history."),
        comparisonVersionId: z.uuid().nullable().describe("Exact previous version UUID, or null for an empty comparison."),
        offset: z.number().int().nonnegative().default(0).describe("UTF-16 offset returned by the previous content chunk; start at zero."),
        // At most 3 UTF-8 bytes per UTF-16 character (JSON escaping costs at most 2), leaving room under 256 KiB.
        length: z.number().int().min(1).max(65_536).default(65_536).describe("Maximum UTF-16 characters in this chunk, up to 65536."),
      })
      .strict(),
    data: z.object({ content: z.object({ text: z.string(), nextOffset: z.number().int().nullable() }).strict() }).strict(),
  },
  list: {
    input: z
      .object({
        codeId: CodeIdSchema,
        before: z.number().int().positive().optional().describe("Version number from nextBefore, exclusive."),
        limit: z.number().int().min(1).max(50).default(20).describe("Maximum receipts in this byte-bounded page, up to 50."),
      })
      .strict(),
    data: z.object({ items: z.array(submission), nextBefore: z.number().int().positive().nullable() }).strict(),
  },
  decide: { input: CodeVersionBindingSchema, data: submission },
  pause: { input: z.object({ codeId: CodeIdSchema }).strict(), data: z.object({ state: z.literal("paused") }).strict() },
  resume: { input: z.object({ codeId: CodeIdSchema }).strict(), data: z.object({ state: z.literal("active") }).strict() },
} as const;
