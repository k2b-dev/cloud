import { z } from "zod";
import type { GeneratedCodeSdk } from "./types";

/** Administrator budgets for C22. UTF-8 sizes; checkMs covers all child processes together. No environment overrides. */
export const CODE_CHECK_LIMITS = Object.freeze({
  sourceBytes: 256 * 1024,
  bundleBytes: 1024 * 1024,
  checkMs: 15_000,
  memoryBytes: 512 * 1024 * 1024,
  outputBytes: 2 * 1024 * 1024,
  files: 64,
  requestBytes: 8 * 1024 * 1024,
});
/** Compiler-owned recursion guard: TS2589 at depth 100 (or the compiler's instantiation-count guard).
 * tsgo has no supported depth switch; the wall-clock and RSS guards also cover expensive types below this depth. */
export const CODE_CHECK_TYPE_INSTANTIATION_DEPTH = 100;
export const CodeCheckLimitsSchema = z
  .object({
    sourceBytes: z.number().int().positive().safe(),
    bundleBytes: z.number().int().positive().safe(),
    checkMs: z.number().int().positive().safe(),
    memoryBytes: z.number().int().positive().safe(),
    outputBytes: z.number().int().positive().safe(),
    files: z.number().int().positive().safe(),
    requestBytes: z.number().int().positive().safe(),
  })
  .strict();
export type CodeCheckLimits = z.infer<typeof CodeCheckLimitsSchema>;

const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Null id means a dynamic personal/code_run target. Null target means an app-wide operation.
 * Resource-owned Code never produces a dynamic id. A ref contributes another permission for the same operation. */
export const CodePermissionSchema = z
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
export type CodePermission = z.infer<typeof CodePermissionSchema>;
/** Immutable checked-version contract consumed by C8. Store it with the exact source and bundle, never as a grant.
 * entrypoint is the named ESM export understood by the runner and by manual-start/scheduler callers.
 * source hashes { entry, files: sorted [path, source] pairs }; sdk hashes canonical recursively key-sorted SDK JSON.
 * bundle hashes the exact UTF-8 ESM returned by checkCode. All hashes use SHA-256. */
export const CodeVersionManifestSchema = z
  .object({
    version: z.literal(1),
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
    permissions: z.array(CodePermissionSchema),
    ai: z.boolean(),
    internet: z.boolean().optional(),
    hashes: z.object({ source: hash, sdk: hash, bundle: hash }).strict(),
  })
  .strict();
/** Immutable checked version stored with its exact source and bundle; validate with CodeVersionManifestSchema. */
export type CodeVersionManifest = z.infer<typeof CodeVersionManifestSchema>;

/** Stable checker diagnostics for CLI/chat. Lines and columns are one-based; no user code is executed by checking. */
export type CodeCheckDiagnostic = { code: string; message: string; file: string; line: number; column: number };
/** The host supplies current grants and AI operation IDs from trusted platform metadata, never from source files. */
export type CodeCheckRequest = {
  files: Record<string, string>;
  entry: string;
  sdk: GeneratedCodeSdk;
  aiOperations: readonly string[];
  existingPermissions?: readonly Pick<CodePermission, "operation" | "target">[];
  limits?: CodeCheckLimits;
};
/** Failed checks have no bundle or manifest. Successful permissions retain source locations and mark newly needed access. */
export type CodeCheckResult =
  | { ok: false; diagnostics: CodeCheckDiagnostic[] }
  | {
      ok: true;
      diagnostics: [];
      bundle: string;
      manifest: CodeVersionManifest;
      permissions: Array<CodePermission & { status: "new" | "existing" }>;
    };

/** Strict JSON result returned by the isolated checker and validated again by Core. */
export const CodeCheckResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(false),
      diagnostics: z.array(
        z
          .object({
            code: z.string(),
            message: z.string(),
            file: z.string(),
            line: z.number().int().positive(),
            column: z.number().int().positive(),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      diagnostics: z.tuple([]),
      bundle: z.string(),
      manifest: CodeVersionManifestSchema,
      permissions: z.array(CodePermissionSchema.extend({ status: z.enum(["new", "existing"]) }).strict()),
    })
    .strict(),
]);
