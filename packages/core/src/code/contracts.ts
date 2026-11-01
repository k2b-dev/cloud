import { CAPABILITY_MAX_RESULT_BYTES, CloudResourceRefSchema } from "@k2b/cloud/contracts";
import { z } from "zod";

/** Stable public identity; never changes when a new version is saved. */
export const CodeIdSchema = z
  .string()
  .regex(/^c_[a-z0-9]{4,16}$/)
  .describe("Stable Code ID returned by core.code.list or core.code.read.");
/** Exactly one owner. Resource identity is the platform's opaque { type, id } pair. */
export const CodeOwnerSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("person").describe("Personal Code owner."), userId: z.uuid().describe("UUID of the owning person.") })
    .strict(),
  z
    .object({
      kind: z.literal("resource").describe("Resource Code owner."),
      ref: CloudResourceRefSchema.describe("Exact resource owning the Code."),
    })
    .strict(),
  z
    .object({
      kind: z.literal("app").describe("Application Code owner."),
      appId: z
        .string()
        .regex(/^[a-z][a-z0-9-]*$/)
        .max(80)
        .describe("Registered owner application ID."),
    })
    .strict(),
]);
export type CodeOwner = z.infer<typeof CodeOwnerSchema>;
/** Editors also read run contents; readers see only run metadata. Owner administrators are live editors. */
export const CodePermissionSchema = z.enum(["editor", "reader"]);
export type CodePermission = z.infer<typeof CodePermissionSchema>;
/** Source paths are relative POSIX paths; content and bundle are exact UTF-8 text. */
export const CodeSourceFilesSchema = z.record(
  z
    .string()
    .min(1)
    .max(512)
    .refine(
      (path) =>
        !path.startsWith("/") &&
        !/[\\\u0000-\u001f\u007f]/.test(path) &&
        path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
      "Expected a relative source path",
    ),
  z.string(),
);
export type CodeSourceFiles = z.infer<typeof CodeSourceFilesSchema>;
/** Immutable checked-version manifest slot. C8/C16 own its eventual schema, not the SDK generation manifest. */
export const CodeVersionManifestSchema = z.record(z.string(), z.json());
export type CodeVersionManifest = z.infer<typeof CodeVersionManifestSchema>;
/** Core-owned tables; other applications consume capabilities, never these tables. */
export const CODE_TABLES = {
  secrets: "code.secrets",
  secretBindings: "code.secret_bindings",
  codes: "code.codes",
  shares: "code.shares",
  versions: "code.versions",
  runs: "code.runs",
  calls: "code.calls",
  versionSubmissions: "code.version_submissions",
  versionDecisions: "code.version_decisions",
  versionBaselines: "code.version_baselines",
  activations: "code.activations",
  targetGrants: "code.target_grants",
  versionGrants: "code.version_grants",
  activationNotices: "code.activation_notices",
  activationOutbox: "code.activation_outbox",
  policy: "code.policy",
  policyRules: "code.policy_rules",
  policyCoverage: "code.policy_coverage",
  policyPauseOutbox: "code.policy_pause_outbox",
} as const;
const timestamp = z.iso.datetime();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const CodeSchema = z
  .object({
    id: CodeIdSchema,
    owner: CodeOwnerSchema,
    title: z.string(),
    serviceAccountId: z.uuid().nullable(),
    state: z.enum(["draft", "active", "paused", "deleting"]),
    activeVersionId: z.uuid().nullable(),
    pauseReason: z.string().nullable(),
    pauseRows: z.array(z.string()),
    pausePolicyRevision: z.number().int().positive().nullable(),
    createdBy: z.uuid().nullable(),
    createdAt: timestamp,
  })
  .strict();
export type Code = z.infer<typeof CodeSchema>;
export const CodeVersionSchema = z
  .object({
    id: z.uuid(),
    codeId: CodeIdSchema,
    number: z.number().int().positive(),
    sourceHash: hash,
    bundleHash: hash,
    files: z.array(z.string()),
    sourceBytes: z.number().int().nonnegative(),
    bundleBytes: z.number().int().nonnegative(),
    manifestAvailable: z.boolean(),
    createdBy: z.uuid().nullable(),
    createdAt: timestamp,
  })
  .strict();
export type CodeVersion = z.infer<typeof CodeVersionSchema>;
/** One attempt, never a resumable workflow. Scheduling/leases belong to C13. */
export const CodeRunSchema = z
  .object({
    id: z.uuid(),
    codeId: CodeIdSchema,
    versionId: z.uuid(),
    trigger: z.enum(["manual", "schedule", "event", "path"]),
    /** Declared handler name; never a concrete request URL or payload. Safe run metadata for readers. */
    entrypoint: z.string(),
    state: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "skipped"]),
    outcome: z.string().nullable(),
    createdAt: timestamp,
    startedAt: timestamp.nullable(),
    endedAt: timestamp.nullable(),
  })
  .strict();
export type CodeRun = z.infer<typeof CodeRunSchema>;
/** Results use Postgres json (exact JSON text), so the public capability result byte budget applies without expansion. */
export const CODE_RESULT_STORAGE_BYTES = CAPABILITY_MAX_RESULT_BYTES;
/** Inline JSON and text chunks share the capability response budget. Larger values remain complete in Postgres. */
export const CODE_INLINE_JSON_BYTES = 16_384;
/** Ordered observational record, not a replay journal or an idempotency reservation. */
export const CodeCallSchema = z
  .object({
    ordinal: z.number().int().positive(),
    kind: z.enum(["query", "action"]),
    capability: z.string(),
    /** Historical normalized JSON; output validation must not depend on the current invocation schema. */
    call: z.json().nullable(),
    callChunked: z.boolean(),
    resultChunked: z.boolean(),
    result: z.json().nullable(),
    state: z.enum(["running", "succeeded", "failed", "uncertain"]),
    startedAt: timestamp,
    endedAt: timestamp.nullable(),
  })
  .strict();
export type CodeCall = z.infer<typeof CodeCallSchema>;
const pageInput = {
  cursor: z.string().max(100).optional().describe("Opaque cursor returned by the previous page."),
  limit: z.number().int().min(1).max(50).default(20).describe("Maximum run metadata items in this page."),
};
const page = { nextCursor: z.string().nullable() };
const textChunkInput = {
  offset: z.number().int().min(0).default(0).describe("UTF-16 offset, starting at zero or returned as nextOffset."),
  length: z
    .number()
    .int()
    .min(1)
    .max(16_384)
    .default(16_384)
    .describe("Target UTF-16 code units; a single surrogate pair may use two units."),
};
const textChunk = z.object({ text: z.string(), nextOffset: z.number().int().nullable() }).strict();
/** Exact timestamp precision is retained in the cursor, including Postgres microseconds. */
export const CodeRunCursorSchema = z
  .string()
  .max(100)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\|[a-f0-9-]{36}$/)
  .refine((value) => z.iso.datetime().safeParse(value.split("|")[0]).success && z.uuid().safeParse(value.split("|")[1]).success)
  .describe("Opaque run history cursor returned by the previous page.");
/** Public Query inputs/results. Content is chunked to fit the capability transport's result budget. */
export const codeQueryContracts = {
  list: {
    input: z
      .object({
        owner: CodeOwnerSchema.optional().describe("Filter by one exact Code owner."),
        ...pageInput,
        cursor: CodeIdSchema.optional().describe("Last Code ID returned as nextCursor."),
        limit: z.number().int().min(1).max(20).default(20).describe("Maximum Code candidates checked in this page."),
      })
      .strict(),
    data: z.object({ items: z.array(CodeSchema.extend({ permission: CodePermissionSchema })), ...page }).strict(),
  },
  read: {
    input: z.object({ codeId: CodeIdSchema }).strict(),
    data: z.object({ code: CodeSchema, permission: CodePermissionSchema }).strict(),
  },
  versionRead: {
    input: z
      .object({
        codeId: CodeIdSchema,
        versionId: z.uuid().describe("Immutable version UUID belonging to this Code."),
        content: z
          .discriminatedUnion("kind", [
            z
              .object({
                kind: z.literal("source").describe("Read a source file."),
                path: z.string().min(1).max(512).describe("Relative source path from version metadata."),
              })
              .strict(),
            z.object({ kind: z.literal("bundle").describe("Read the exact runner bundle.") }).strict(),
            z.object({ kind: z.literal("manifest").describe("Read the checked version manifest as JSON text.") }).strict(),
          ])
          .optional()
          .describe("Select version text to read; omit for metadata only."),
        offset: z.number().int().min(0).default(0).describe("UTF-16 offset, starting at zero or returned as nextOffset."),
        length: z
          .number()
          .int()
          .min(1)
          .max(16_384)
          .default(16_384)
          .describe("Target UTF-16 code units; a single surrogate pair may use two units."),
      })
      .strict(),
    data: z
      .object({ version: CodeVersionSchema, content: z.object({ text: z.string(), nextOffset: z.number().int().nullable() }).nullable() })
      .strict(),
  },
  runList: {
    input: z.object({ codeId: CodeIdSchema, ...pageInput, cursor: CodeRunCursorSchema.optional() }).strict(),
    data: z.object({ items: z.array(CodeRunSchema), ...page }).strict(),
  },
  runRead: {
    input: z
      .object({
        codeId: CodeIdSchema,
        runId: z.uuid().describe("Run UUID belonging to this Code."),
        cursor: z.number().int().min(0).default(0).describe("Last call ordinal from nextCursor, or zero for the first call."),
        content: z
          .discriminatedUnion("kind", [
            z.object({ kind: z.literal("input").describe("Read the full run input as JSON text.") }).strict(),
            z.object({ kind: z.literal("output").describe("Read the full run output as JSON text.") }).strict(),
            z
              .object({
                kind: z.literal("call").describe("Read the full normalized call as JSON text."),
                ordinal: z.number().int().positive().describe("Call ordinal from the call page."),
              })
              .strict(),
            z
              .object({
                kind: z.literal("result").describe("Read the full call result as JSON text."),
                ordinal: z.number().int().positive().describe("Call ordinal from the call page."),
              })
              .strict(),
          ])
          .optional()
          .describe("Optional full JSON content selector for a large payload."),
        ...textChunkInput,
      })
      .strict(),
    data: z
      .object({
        run: CodeRunSchema,
        contents: z
          .object({
            input: z.json(),
            output: z.json().nullable(),
            inputChunked: z.boolean(),
            outputChunked: z.boolean(),
            content: textChunk.nullable(),
            calls: z.array(CodeCallSchema).max(1),
            nextCursor: z.number().int().nullable(),
          })
          .nullable(),
      })
      .strict(),
  },
} as const;
