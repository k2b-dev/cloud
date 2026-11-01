import { z } from "zod";
import { CloudResourceRefSchema, NormalizedCapabilityCallSchema } from "../contracts/capabilities";
import type { CodeCheckDiagnostic, CodeVersionManifest } from "./checker-contract";
import type { GeneratedCodeSdk } from "./types";

const positive = z.number().int().positive().safe();
const errorCode = z.string().regex(/^[a-z][a-z0-9_]{0,127}$/);
/** Declarative reply. No functions, executable fixtures, filesystem paths or real credentials. */
export const CodeTestMockSchema = z
  .object({
    operation: z.string().min(1),
    target: CloudResourceRefSchema.nullable(),
    /** Optional exact input/refs matcher. More specific matches take precedence; ambiguity fails. */
    input: z.json().optional(),
    refs: z.record(z.string(), CloudResourceRefSchema).optional(),
    replies: z
      .array(
        z.discriminatedUnion("ok", [
          z.object({ ok: z.literal(true), data: z.json() }).strict(),
          z.object({ ok: z.literal(false), error: errorCode }).strict(),
        ]),
      )
      .min(1),
  })
  .strict();
/** One ordered, payload-bearing observation, including replayed calls and refusals. */
export const CodeTestCallSchema = z
  .object({
    sequence: positive,
    operation: z.string(),
    call: NormalizedCapabilityCallSchema,
    idempotencyKey: z.string().nullable(),
    replayed: z.boolean(),
    result: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), data: z.json() }).strict(),
      z.object({ ok: z.literal(false), error: errorCode }).strict(),
    ]),
  })
  .strict();
/** One explicit invocation; now is Unix milliseconds. Schedules are fired by name, never by sleeping for cron. */
export const CodeTestRunSchema = z
  .object({
    entrypoint: z.string().min(1),
    input: z.json().default(null),
    now: z.number().int().min(0).max(8_640_000_000_000_000).optional(),
    expect: z
      .object({
        ok: z.boolean().optional(),
        error: errorCode.optional(),
        value: z.json().optional(),
        /** Exact ordered call subset; omitted fields are not asserted. Length is always exact. */
        calls: z.array(CodeTestCallSchema.partial()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
/** A test/NAME.json case. Repeated runs share receipts and mock cursors; cases share no state. */
export const CodeTestCaseSchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1),
    now: z.number().int().min(0).max(8_640_000_000_000_000),
    seed: z.number().int().min(0).max(0xffffffff),
    mocks: z.array(CodeTestMockSchema),
    runs: z.array(CodeTestRunSchema).min(1),
  })
  .strict();
/** Host-assigned file identity is separate from author JSON. Simulations use null. */
export const CodeTestExecutionCaseSchema = z.object({ file: z.string().min(1).nullable(), fixture: CodeTestCaseSchema }).strict();
export type CodeTestExecutionCase = z.infer<typeof CodeTestExecutionCaseSchema>;
/** Trusted host budgets, derived from Administration > Code and the checker/transport budgets. No author overrides. */
export const CodeTestLimitsSchema = z
  .object({
    requestBytes: positive,
    outputBytes: positive.min(256),
    cases: positive,
    runs: positive,
    calls: positive,
    wallClockMs: positive,
  })
  .strict();
export type CodeTestLimits = z.infer<typeof CodeTestLimitsSchema>;
export type CodeTestMock = z.infer<typeof CodeTestMockSchema>;
export type CodeTestCase = z.infer<typeof CodeTestCaseSchema>;
export type CodeTestCall = z.infer<typeof CodeTestCallSchema>;
export type CodeTestRun = z.infer<typeof CodeTestRunSchema>;

/** Stable version-1 CLI/chat wire result. No durations, process IDs, random IDs, stacks or credentials. */
export const CodeTestResultSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["test", "simulate"]),
    ok: z.boolean(),
    error: errorCode.nullable(),
    /** --trace adds run boundaries; calls always retain the full ordered effect list. */
    trace: z
      .array(
        z
          .object({
            case: z.string(),
            file: z.string().nullable(),
            run: positive,
            entrypoint: z.string(),
            event: z.enum(["start", "complete"]),
            error: errorCode.nullable(),
          })
          .strict(),
      )
      .optional(),
    diagnostics: z.array(z.object({ code: z.string(), message: z.string(), file: z.string(), line: positive, column: positive }).strict()),
    cases: z.array(
      z
        .object({
          name: z.string(),
          file: z.string().nullable(),
          ok: z.boolean(),
          runs: z.array(
            z
              .object({
                entrypoint: z.string(),
                ok: z.boolean(),
                error: errorCode.nullable(),
                value: z.json(),
                calls: z.array(CodeTestCallSchema),
                /** Paths of failed assertions, without duplicating potentially large values. */
                failures: z.array(z.string()),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();
export type CodeTestResult = z.infer<typeof CodeTestResultSchema>;
/** JSON Schema for clients that do not use Zod. The version discriminator is the compatibility boundary. */
export const CODE_TEST_RESULT_JSON_SCHEMA = z.toJSONSchema(CodeTestResultSchema);
/** A successfully checked immutable bundle plus declarative cases. SDK and manifest come from the trusted checker host. */
export type CodeTestExecution = {
  mode: "test" | "simulate";
  bundle: string;
  manifest: CodeVersionManifest;
  sdk: GeneratedCodeSdk;
  cases: CodeTestExecutionCase[];
  trace?: boolean;
};
/** Runner-only fake execution seam. Implementations never accept a production bridge or a run token. */
export type CodeTestExecutor = (request: CodeTestExecution, signal?: AbortSignal) => Promise<CodeTestResult>;
/** Construct the same bounded error envelope for check, fixture and execution failures. */
export const codeTestFailure = (
  mode: CodeTestExecution["mode"],
  error: string,
  diagnostics: CodeCheckDiagnostic[] = [],
): CodeTestResult => ({
  version: 1,
  mode,
  ok: false,
  error,
  diagnostics,
  cases: [],
});
