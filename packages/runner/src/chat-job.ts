import { CODE_CHECK_LIMITS } from "@k2b/cloud/code";
import { ChatRunInputSchema } from "@k2b/cloud/code/chat-run";
import type { RunnerBridge, RunnerConfig, RunnerJobLease, RunnerJobResult, RunnerLease } from "@k2b/cloud/code/runner";
import type { RunnerEngine } from "./engine";

/** Uses the same isolated workerd engine and pool slots as lasting Code. No turn credential reaches Code. */
export async function executeChatJob(
  job: RunnerJobLease,
  input: string,
  config: RunnerConfig,
  engine: RunnerEngine,
  bridge: Pick<RunnerBridge, "jobCall">,
  signal: AbortSignal,
): Promise<RunnerJobResult> {
  if (Buffer.byteLength(input) > job.inputBytes || job.inputBytes > CODE_CHECK_LIMITS.requestBytes)
    throw new Error("code_job_request_limit");
  const { kind, ...payload } = JSON.parse(input);
  if (kind !== "chat" || !bridge.jobCall) throw new Error("code_job_invalid_input");
  const request = ChatRunInputSchema.parse(payload);
  if (Buffer.byteLength(request.bundle) > config.bundleBytes) throw new Error("code_job_request_limit");
  const lease: RunnerLease = {
    runId: job.jobId,
    codeId: job.jobId,
    versionId: job.jobId,
    organizationId: job.jobId,
    trustTier: "chat",
    entrypoint: "run",
    generation: job.generation,
    mandateRevision: 1,
    bundleHash: new Bun.CryptoHasher("sha256").update(request.bundle).digest("hex"),
    token: "chat-job",
    deadlineAt: job.deadlineAt,
    leaseExpiresAt: job.leaseExpiresAt,
    heartbeatMs: job.heartbeatMs,
    input: { context: request.context, files: request.files },
  };
  try {
    await engine.load(
      lease,
      request.bundle,
      config,
      async (operation, input) => {
        const result = await bridge.jobCall!(
          { jobId: job.jobId, generation: job.generation, leaseKey: job.leaseKey, id: crypto.randomUUID(), operation, input },
          signal,
        );
        return result;
      },
      signal,
      request.modules,
    );
    const result = await engine.run(lease, signal);
    return { kind: "chat", outcome: typeof result === "string" ? result : result.outcome };
  } finally {
    await engine.kill(lease.runId);
  }
}
