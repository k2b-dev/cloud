import { createHash } from "node:crypto";
import {
  type CodeTestExecution,
  CodeTestExecutionCaseSchema,
  type CodeTestExecutor,
  type CodeTestLimits,
  CodeTestLimitsSchema,
  type CodeTestResult,
  CodeTestResultSchema,
  CodeVersionManifestSchema,
  codeSdkHash,
  codeTestFailure,
  createCodeTestBridge,
} from "@k2b/cloud/code";
import { RunnerCallError, type RunnerConfig, type RunnerLease } from "@k2b/cloud/code/runner";
import { z } from "zod";
import { WorkerdEngine } from "./engine";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const CompletionSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.json() }).strict(),
  z.object({ ok: z.literal(false), error: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/) }).strict(),
]);
const COMPLETE = "__code_test_complete";
const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.entries(a),
    right = Object.entries(b);
  return left.length === right.length && left.every(([key, value]) => Object.hasOwn(b, key) && equal(value, Reflect.get(b, key)));
};
const subset = (expected: unknown, actual: unknown): boolean => {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) return equal(expected, actual);
  return (
    !!actual &&
    typeof actual === "object" &&
    Object.entries(expected).every(([key, value]) => Object.hasOwn(actual, key) && subset(value, Reflect.get(actual, key)))
  );
};

/** Preserve the checked ESM byte-for-byte between a trusted clock prelude and a wrapper.
 * workerd resolves the wrapper's self-import to this module's namespace; the supervisor never parses Code.
 * The hash-derived identifier avoids collisions with author/bundler variable names. */
function harness(bundle: string, now: number, seedValue: number) {
  const entrypoint = `__code_test_${hash(bundle)}`;
  const source = `;(() => {
  const now = ${JSON.stringify(now)};
  const RealDate = Date;
  globalThis.Date = new Proxy(RealDate, {
    apply: () => new RealDate(now).toString(),
    construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [now], newTarget),
    get: (target, key, receiver) => key === "now" ? () => now : Reflect.get(target, key, receiver),
  });
  let seed = ${JSON.stringify(seedValue)} >>> 0;
  Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
})();
${bundle}
import * as ${entrypoint}_module from "./bundle.js";
export async function ${entrypoint}(input, cloud) {
  try {
    const value = await ${entrypoint}_module[input.entrypoint](input.value, cloud);
    await cloud.call(${JSON.stringify(COMPLETE)}, { ok: true, value: value === undefined ? null : value });
  } catch (error) {
    const code = typeof error?.message === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(error.message) ? error.message : "code_test_execution_failed";
    await cloud.call(${JSON.stringify(COMPLETE)}, { ok: false, error: code });
  }
}`;
  return { source, entrypoint };
}

/** Production workerd engine with a fake-only bridge. No RunnerBridge, Core URL, app proof or token is accepted.
 * A fresh engine and isolate are used for each invocation; finally closes/reaps them on every path.
 * limits/config originate from the trusted host's administrator budgets, never from fixture JSON. */
export function createCodeTestExecutor(config: RunnerConfig, suppliedLimits: CodeTestLimits): CodeTestExecutor {
  const limits = CodeTestLimitsSchema.parse(suppliedLimits);
  return async (request: CodeTestExecution, signal?: AbortSignal): Promise<CodeTestResult> => {
    const fail = (error: string) => codeTestFailure(request.mode, error);
    if (Buffer.byteLength(JSON.stringify(request)) > limits.requestBytes) return fail("code_test_request_limit");
    const parsed = z.array(CodeTestExecutionCaseSchema).safeParse(request.cases);
    const manifest = CodeVersionManifestSchema.safeParse(request.manifest);
    if (!parsed.success || !manifest.success) return fail("code_test_invalid_fixture");
    if (
      request.cases.length === 0 ||
      request.cases.length > limits.cases ||
      request.cases.reduce((n, value) => n + value.fixture.runs.length, 0) > limits.runs
    )
      return fail("code_test_case_limit");
    if (hash(request.bundle) !== manifest.data.hashes.bundle || Buffer.byteLength(request.bundle) > config.bundleBytes)
      return fail("code_test_bundle_mismatch");
    if (codeSdkHash(request.sdk) !== manifest.data.hashes.sdk) return fail("code_test_sdk_mismatch");
    const controller = new AbortController();
    const abort = () => controller.abort("code_test_cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timeout = setTimeout(() => controller.abort("code_test_time_limit"), limits.wallClockMs);
    const result: CodeTestResult = {
      version: 1,
      mode: request.mode,
      ok: true,
      error: null,
      diagnostics: [],
      cases: [],
      ...(request.trace ? { trace: [] } : {}),
    };
    const checkOutput = () => {
      if (Buffer.byteLength(JSON.stringify(result)) > limits.outputBytes) throw new Error("code_test_output_limit");
    };
    try {
      for (const { file, fixture } of parsed.data) {
        const bridge = createCodeTestBridge(request.sdk.manifest, fixture.mocks);
        const caseResult: CodeTestResult["cases"][number] = { name: fixture.name, file, ok: true, runs: [] };
        result.cases.push(caseResult);
        for (const [index, run] of fixture.runs.entries()) {
          controller.signal.throwIfAborted();
          if (!manifest.data.entrypoints.some((entry) => entry.entrypoint === run.entrypoint))
            throw new Error("code_test_missing_entrypoint");
          result.trace?.push({ case: fixture.name, file, run: index + 1, entrypoint: run.entrypoint, event: "start", error: null });
          bridge.begin();
          let completion: z.infer<typeof CompletionSchema> | undefined;
          let callCount = 0;
          let callBytes = 0;
          let callFailure: string | null = null;
          const engine = new WorkerdEngine();
          const { source, entrypoint } = harness(request.bundle, run.now ?? fixture.now, fixture.seed);
          // These are synthetic, local-only lease labels, never signed or sent to Core.
          const lease: RunnerLease = {
            runId: `test-${index}`,
            codeId: "test",
            versionId: "test",
            organizationId: "test",
            trustTier: "test",
            entrypoint,
            generation: 1,
            mandateRevision: 1,
            bundleHash: hash(source),
            token: "fake-only",
            deadlineAt: Date.now() + limits.wallClockMs,
            leaseExpiresAt: Date.now() + limits.wallClockMs,
            heartbeatMs: 1000,
            input: { entrypoint: run.entrypoint, value: run.input },
          };
          let outcome: string;
          try {
            await engine.load(
              lease,
              source,
              config,
              async (operation, input) => {
                controller.signal.throwIfAborted();
                if (operation === COMPLETE) {
                  completion = CompletionSchema.parse(input);
                  return null;
                }
                if (++callCount > limits.calls) {
                  callFailure = "code_test_call_limit";
                  throw new RunnerCallError(callFailure);
                }
                callBytes += Buffer.byteLength(JSON.stringify(input));
                if (callBytes > limits.outputBytes) {
                  callFailure = "code_test_output_limit";
                  throw new RunnerCallError(callFailure);
                }
                const value = await bridge.call(operation, input);
                callBytes += Buffer.byteLength(JSON.stringify(value));
                if (callBytes > limits.outputBytes) {
                  callFailure = "code_test_output_limit";
                  throw new RunnerCallError(callFailure);
                }
                return value;
              },
              controller.signal,
            );
            outcome = await engine.run(lease, controller.signal);
          } finally {
            await engine.close();
          }
          const error =
            callFailure ??
            bridge.failure() ??
            (controller.signal.aborted
              ? String(controller.signal.reason)
              : outcome !== "succeeded"
                ? `code_test_${outcome}`
                : !completion
                  ? "code_test_execution_failed"
                  : !completion.ok
                    ? completion.error
                    : null);
          const row: CodeTestResult["cases"][number]["runs"][number] = {
            entrypoint: run.entrypoint,
            ok: error === null,
            error,
            value: completion?.ok ? completion.value : null,
            calls: bridge.calls(),
            failures: [],
          };
          const expected = run.expect;
          if (expected) {
            for (const key of ["ok", "error", "value"] as const) {
              if (Object.hasOwn(expected, key) && !equal(expected[key], row[key])) row.failures.push(key);
            }
            if (
              expected.calls &&
              (expected.calls.length !== row.calls.length || expected.calls.some((call, i) => !subset(call, row.calls[i])))
            )
              row.failures.push("calls");
          }
          if (expected?.ok === false && !expected.error) row.failures.push("error");
          // An explicitly expected domain error may pass. Missing/invalid fixtures and budgets always fail the case.
          const passed =
            !callFailure &&
            !bridge.failure() &&
            !row.failures.length &&
            (row.ok || (expected?.ok === false && expected.error === row.error));
          result.trace?.push({ case: fixture.name, file, run: index + 1, entrypoint: run.entrypoint, event: "complete", error });
          caseResult.ok &&= passed;
          caseResult.runs.push(row);
          result.ok &&= passed;
          checkOutput();
        }
      }
      return CodeTestResultSchema.parse(result);
    } catch (error) {
      const code = controller.signal.aborted
        ? String(controller.signal.reason)
        : error instanceof Error && /^code_test_[a-z_]+$/.test(error.message)
          ? error.message
          : "code_test_execution_failed";
      return fail(code);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  };
}
