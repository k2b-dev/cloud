/** Trusted Runner image role: one JSON request on stdin, one versioned JSON result on stdout. */
import { CODE_CHECK_LIMITS, type CodeTestExecution, type CodeTestLimits, codeTestFailure } from "@k2b/cloud/code";
import { type RunnerConfig, RunnerConfigSchema } from "@k2b/cloud/code/runner";
import { readBytes } from "../src/bridge";
import { createCodeTestExecutor } from "../src/test-kit";

if (Bun.argv.includes("--help")) {
  console.log("Usage: bun code-test.js < REQUEST_JSON\nTrusted input: { execution, config, limits }; no app key or Core URL is used.");
} else {
  const controller = new AbortController();
  let mode: "test" | "simulate" = "test";
  const stop = () => controller.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    const bytes = await readBytes(
      new Response(Bun.stdin.stream()),
      CODE_CHECK_LIMITS.requestBytes,
      AbortSignal.any([controller.signal, AbortSignal.timeout(CODE_CHECK_LIMITS.checkMs)]),
    );
    const request: { execution: CodeTestExecution; config: RunnerConfig; limits: CodeTestLimits } = JSON.parse(
      new TextDecoder().decode(bytes),
    );
    mode = request.execution.mode === "simulate" ? "simulate" : "test";
    if (!["test", "simulate"].includes(request.execution.mode)) throw new Error("code_test_invalid_request");
    // Each image role is the sole supervisor in its PID namespace, as for production.
    if (process.pid !== 1) throw new Error("code_test_isolation_required");
    const execute = createCodeTestExecutor(RunnerConfigSchema.parse(request.config), request.limits);
    console.log(JSON.stringify(await execute(request.execution, controller.signal)));
  } catch (error) {
    console.log(
      JSON.stringify(
        codeTestFailure(
          mode,
          error instanceof Error && error.message === "code_test_isolation_required" ? error.message : "code_test_invalid_request",
        ),
      ),
    );
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}
