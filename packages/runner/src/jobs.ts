import { CODE_CHECK_LIMITS } from "@k2b/cloud/code";
import { type RunnerConfig, type RunnerJobLease, type RunnerJobResult, RunnerJobResultSchema } from "@k2b/cloud/code/runner";
import { readBytes } from "./bridge";
import { allocateRunnerIdentities } from "./identities";

/** Launcher owns process-tree teardown. No key, Core URL, run token, or inherited descriptors reach either role. */
export async function executeRunnerJob(
  lease: RunnerJobLease,
  input: string,
  config: RunnerConfig,
  signal: AbortSignal,
): Promise<RunnerJobResult> {
  signal.throwIfAborted();
  if (Buffer.byteLength(input) > lease.inputBytes || lease.inputBytes > CODE_CHECK_LIMITS.requestBytes)
    throw new Error("code_job_request_limit");
  const parsed: unknown = JSON.parse(input);
  if (!parsed || typeof parsed !== "object" || !("kind" in parsed) || parsed.kind !== lease.kind) throw new Error("code_job_invalid_input");
  let request: unknown;
  if (lease.kind === "check") {
    if (!("request" in parsed)) throw new Error("code_job_invalid_input");
    request = parsed.request;
  } else {
    if (!("execution" in parsed) || !("limits" in parsed)) throw new Error("code_job_invalid_input");
    request = { execution: parsed.execution, limits: parsed.limits, config };
  }
  const child = Bun.spawn(
    [
      "/app/job-isolate",
      String(allocateRunnerIdentities(65536)),
      String(2 * CODE_CHECK_LIMITS.requestBytes),
      process.execPath,
      "--no-env-file",
      lease.kind === "check" ? "/app/checker.js" : "/app/code-test.js",
    ],
    { env: {}, stdin: "pipe", stdout: "pipe", stderr: "ignore" },
  );
  const stop = () => child.kill("SIGKILL");
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  try {
    // Drain stdout concurrently: a child may reject before consuming its entire stdin.
    const output = readBytes(new Response(child.stdout), lease.outputBytes, signal);
    const write = (async () => {
      await child.stdin.write(JSON.stringify(request));
      await child.stdin.end();
    })();
    const [bytes, exit] = await Promise.all([output, child.exited, write]);
    signal.throwIfAborted();
    if (exit !== 0) throw new Error("code_job_role_failed");
    return RunnerJobResultSchema.parse({ kind: lease.kind, result: JSON.parse(new TextDecoder().decode(bytes)) });
  } finally {
    signal.removeEventListener("abort", stop);
    if (child.exitCode === null) stop();
    await child.exited;
  }
}
