import {
  type CodeCheckRequest,
  type CodeCheckResult,
  type CodeTestCase,
  CodeTestCaseSchema,
  type CodeTestExecutionCase,
  type CodeTestExecutor,
  type CodeTestLimits,
  CodeTestLimitsSchema,
  type CodeTestResult,
  CodeTestResultSchema,
  codeTestFailure,
} from "@k2b/cloud/code";

/** Core's test service dependencies. check connects to the authoritative isolated checker role;
 * execute connects to Runner's fake-only test role. Neither accepts the production bridge or run scheduler.
 * The installation supplies both executors and budgets; Core needs no compiler or workerd in its own image. */
export type CodeTestingHost = {
  check: (request: CodeCheckRequest, signal?: AbortSignal) => Promise<CodeCheckResult>;
  execute: CodeTestExecutor;
  limits: CodeTestLimits;
};
/** Source and declarative test/NAME.json files, collected by CLI/chat without evaluating test modules. */
export type CodeTestRequest = { code: CodeCheckRequest; tests: Record<string, string>; trace?: boolean };
/** One entrypoint and fixture; always checked and executed against fake data, with no durable version or run. */
export type CodeSimulateRequest = { code: CodeCheckRequest; fixture: CodeTestCase; trace?: boolean };

async function execute(
  mode: "test" | "simulate",
  code: CodeCheckRequest,
  cases: CodeTestExecutionCase[],
  host: CodeTestingHost,
  trace: boolean | undefined,
  signal?: AbortSignal,
): Promise<CodeTestResult> {
  let checked: CodeCheckResult;
  try {
    checked = await host.check(code, signal);
  } catch {
    return codeTestFailure(mode, signal?.aborted ? "code_test_cancelled" : "code_test_checker_unavailable");
  }
  if (!checked.ok) {
    const failure = codeTestFailure(mode, "code_test_check_failed", checked.diagnostics);
    return Buffer.byteLength(JSON.stringify(failure)) > host.limits.outputBytes ? codeTestFailure(mode, "code_test_output_limit") : failure;
  }
  try {
    const result = CodeTestResultSchema.parse(
      await host.execute({ mode, bundle: checked.bundle, manifest: checked.manifest, sdk: code.sdk, cases, trace }, signal),
    );
    if (Buffer.byteLength(JSON.stringify(result)) > host.limits.outputBytes) return codeTestFailure(mode, "code_test_output_limit");
    return result;
  } catch {
    return codeTestFailure(mode, signal?.aborted ? "code_test_cancelled" : "code_test_runner_unavailable");
  }
}
/** Check the exact source, then run sorted declarative cases through Runner. Bad JSON fails visibly before execution. */
export async function testCode(request: CodeTestRequest, host: CodeTestingHost, signal?: AbortSignal): Promise<CodeTestResult> {
  const limits = CodeTestLimitsSchema.parse(host.limits);
  if (Buffer.byteLength(JSON.stringify(request)) > limits.requestBytes) return codeTestFailure("test", "code_test_request_limit");
  const names = Object.keys(request.tests).sort();
  if (!names.length || names.length > limits.cases) return codeTestFailure("test", "code_test_case_limit");
  const cases: CodeTestExecutionCase[] = [];
  try {
    for (const name of names) {
      if (!/^test\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.json$/.test(name)) return codeTestFailure("test", "code_test_fixture_path");
      cases.push({ file: name, fixture: CodeTestCaseSchema.parse(JSON.parse(request.tests[name]!)) });
    }
  } catch {
    return codeTestFailure("test", "code_test_invalid_fixture");
  }
  if (cases.reduce((n, fixture) => n + fixture.fixture.runs.length, 0) > limits.runs)
    return codeTestFailure("test", "code_test_case_limit");
  return execute("test", request.code, cases, host, request.trace, signal);
}
/** Simulate exactly one entrypoint. This cannot enqueue production work, activate Code, or contact real capabilities. */
export async function simulateCode(request: CodeSimulateRequest, host: CodeTestingHost, signal?: AbortSignal): Promise<CodeTestResult> {
  const limits = CodeTestLimitsSchema.parse(host.limits);
  if (Buffer.byteLength(JSON.stringify(request)) > limits.requestBytes) return codeTestFailure("simulate", "code_test_request_limit");
  const fixture = CodeTestCaseSchema.safeParse(request.fixture);
  if (!fixture.success || fixture.data.runs.length !== 1) return codeTestFailure("simulate", "code_test_invalid_fixture");
  return execute("simulate", request.code, [{ file: null, fixture: fixture.data }], host, request.trace, signal);
}
