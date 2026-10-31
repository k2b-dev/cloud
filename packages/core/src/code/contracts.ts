import { CloudResourceRefSchema, NormalizedCapabilityCallSchema } from "@k2b/cloud/contracts";
import { z } from "zod";

/** Stable public identity; never changes when a new version is saved. */
export const CodeIdSchema = z.string().regex(/^c_[a-z0-9]{4,16}$/);
/** Exactly one owner. Resource identity is the platform's opaque { type, id } pair. */
export const CodeOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person"), userId: z.uuid() }).strict(),
  z.object({ kind: z.literal("resource"), ref: CloudResourceRefSchema }).strict(),
  z
    .object({
      kind: z.literal("app"),
      appId: z
        .string()
        .regex(/^[a-z][a-z0-9-]*$/)
        .max(100),
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
  codes: "code.codes",
  access: "code.access",
  versions: "code.versions",
  runs: "code.runs",
  calls: "code.calls",
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
    entrypoint: z.string(),
    state: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "skipped"]),
    outcome: z.string().nullable(),
    createdAt: timestamp,
    startedAt: timestamp.nullable(),
    endedAt: timestamp.nullable(),
  })
  .strict();
export type CodeRun = z.infer<typeof CodeRunSchema>;
/** Ordered observational record, not a replay journal or an idempotency reservation. */
export const CodeCallSchema = z
  .object({
    ordinal: z.number().int().positive(),
    kind: z.enum(["query", "action"]),
    call: NormalizedCapabilityCallSchema,
    result: z.json().nullable(),
    state: z.enum(["running", "succeeded", "failed"]),
    startedAt: timestamp,
    endedAt: timestamp.nullable(),
  })
  .strict();
export type CodeCall = z.infer<typeof CodeCallSchema>;
const pageInput = { cursor: z.string().regex(/^\d+$/).max(12).optional(), limit: z.number().int().min(1).max(50).default(20) };
const page = { nextCursor: z.string().nullable() };
/** Public Query inputs/results. Content is chunked to fit the capability transport's result budget. */
export const codeQueryContracts = {
  list: {
    input: z.object({ owner: CodeOwnerSchema.optional(), ...pageInput, limit: z.number().int().min(1).max(20).default(20) }).strict(),
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
        versionId: z.uuid(),
        content: z
          .discriminatedUnion("kind", [
            z.object({ kind: z.literal("source"), path: z.string().min(1).max(512) }).strict(),
            z.object({ kind: z.literal("bundle") }).strict(),
            z.object({ kind: z.literal("manifest") }).strict(),
          ])
          .optional(),
        offset: z.number().int().min(0).default(0),
        length: z.number().int().min(1).max(16_384).default(16_384),
      })
      .strict(),
    data: z
      .object({ version: CodeVersionSchema, content: z.object({ text: z.string(), nextOffset: z.number().int().nullable() }).nullable() })
      .strict(),
  },
  runList: {
    input: z.object({ codeId: CodeIdSchema, ...pageInput }).strict(),
    data: z.object({ items: z.array(CodeRunSchema), ...page }).strict(),
  },
  runRead: {
    input: z.object({ codeId: CodeIdSchema, runId: z.uuid(), cursor: z.number().int().min(0).default(0) }).strict(),
    data: z
      .object({
        run: CodeRunSchema,
        contents: z
          .object({
            input: z.json(),
            output: z.json().nullable(),
            calls: z.array(CodeCallSchema).max(1),
            nextCursor: z.number().int().nullable(),
          })
          .nullable(),
      })
      .strict(),
  },
} as const;
