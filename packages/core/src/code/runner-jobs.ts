import { sql } from "@k2b/cloud";
import {
  CODE_CHECK_LIMITS,
  type CodeCheckHost,
  type CodeCheckRequest,
  type CodeCheckResult,
  CodeCheckResultSchema,
  type CodeTestExecution,
  type CodeTestLimits,
  CodeTestResultSchema,
} from "@k2b/cloud/code";
import {
  type RunnerJobLease,
  type RunnerJobProof,
  type RunnerJobResult,
  RunnerJobResultSchema,
  RunnerLeaseLostError,
} from "@k2b/cloud/code/runner";
import type { SQL } from "bun";
import { type CodeContext, codePerson } from "./access";
import { codeAdmissionLock } from "./admission";
import { CodeJobError } from "./job-errors";
import { CODE_RUN_HEARTBEAT_MS, CODE_RUN_LEASE_MS } from "./scheduling-contracts";
import { codeSettings } from "./settings";
import type { CodeTestingHost } from "./testing";

/** Only trusted Core code constructs these inputs: SDK/grants and all limits must come from Core, never author JSON. */
export type CodeRunnerJobInput =
  | { kind: "check"; request: CodeCheckRequest }
  | { kind: "test" | "simulate"; execution: CodeTestExecution; limits: CodeTestLimits };
const digest = (key: string) => new Bun.CryptoHasher("sha256").update(key).digest("hex");
export async function claimCodeJob(instanceId: string, db: SQL): Promise<RunnerJobLease | undefined> {
  const key = crypto.getRandomValues(new Uint8Array(32)).toHex();
  const [row] = await db<
    {
      id: string;
      kind: RunnerJobLease["kind"];
      generation: number;
      deadline_at: Date;
      lease_expires_at: Date;
      input_bytes: number;
      output_bytes: number;
    }[]
  >`WITH next AS(
    SELECT id FROM code.jobs WHERE state='queued' AND deadline_at>clock_timestamp() ORDER BY created_at,id LIMIT 1 FOR NO KEY UPDATE SKIP LOCKED)
    UPDATE code.jobs SET state='running',generation=generation+1,lease_key_hash=${digest(key)},runner_instance_id=${instanceId}::uuid,
    lease_expires_at=LEAST(deadline_at,clock_timestamp()+${CODE_RUN_LEASE_MS}*interval '1 millisecond') WHERE id=(SELECT id FROM next) RETURNING *`;
  return row
    ? {
        jobId: row.id,
        kind: row.kind,
        generation: row.generation,
        leaseKey: key,
        deadlineAt: row.deadline_at.getTime(),
        leaseExpiresAt: row.lease_expires_at.getTime(),
        heartbeatMs: CODE_RUN_HEARTBEAT_MS,
        inputBytes: row.input_bytes,
        outputBytes: row.output_bytes,
      }
    : undefined;
}
async function fence(proof: RunnerJobProof, db: SQL) {
  const [row] = await db<
    { kind: RunnerJobLease["kind"]; input: string; input_bytes: number; output_bytes: number; deadline_at: Date }[]
  >`SELECT * FROM code.jobs
    WHERE id=${proof.jobId}::uuid AND generation=${proof.generation} AND lease_key_hash=${digest(proof.leaseKey)}
      AND state='running' AND lease_expires_at>clock_timestamp() AND deadline_at>clock_timestamp() FOR UPDATE`;
  if (!row) throw new RunnerLeaseLostError();
  return row;
}
export async function readCodeJobInput(proof: RunnerJobProof) {
  return sql.begin(async (db) => {
    const row = await fence(proof, db);
    return row.input;
  });
}
export async function heartbeatCodeJob(proof: RunnerJobProof) {
  return sql.begin(async (db) => {
    await fence(proof, db);
    const [row] = await db<
      { lease_expires_at: Date }[]
    >`UPDATE code.jobs SET lease_expires_at=LEAST(deadline_at,clock_timestamp()+${CODE_RUN_LEASE_MS}*interval '1 millisecond') WHERE id=${proof.jobId}::uuid RETURNING lease_expires_at`;
    await db`UPDATE code.runner_instances SET last_seen_at=clock_timestamp() WHERE instance_id=(SELECT runner_instance_id FROM code.jobs WHERE id=${proof.jobId}::uuid)`;
    return { leaseExpiresAt: row!.lease_expires_at.getTime() };
  });
}
export async function completeCodeJob(proof: RunnerJobProof, result: RunnerJobResult) {
  return sql.begin(async (db) => {
    const row = await fence(proof, db);
    const validation = RunnerJobResultSchema.safeParse(result);
    let parsed: RunnerJobResult = validation.success ? validation.data : { kind: "error", code: "code_job_failed" };
    if (Buffer.byteLength(JSON.stringify(parsed)) > row.output_bytes) parsed = { kind: "error", code: "code_job_output_limit" };
    if (parsed.kind !== "error" && (parsed.kind !== row.kind || (parsed.kind !== "check" && parsed.result.mode !== row.kind)))
      parsed = { kind: "error", code: "code_job_failed" };
    await db`UPDATE code.jobs SET state=${parsed.kind === "error" ? "failed" : "succeeded"},result=${JSON.stringify(parsed)}::jsonb,input=NULL,lease_expires_at=NULL,lease_key_hash=NULL WHERE id=${proof.jobId}::uuid`;
  });
}
/** Crash recovery never replays production effects: authoring roles have only a fake bridge. */
export async function reconcileCodeJobs() {
  const attempts = await codeSettings.get("core.code.automatic_attempts");
  await sql`UPDATE code.jobs SET state=CASE WHEN deadline_at<=clock_timestamp() OR generation>=${attempts} THEN 'failed' ELSE 'queued' END,
    result=CASE WHEN deadline_at<=clock_timestamp() THEN '{"kind":"error","code":"code_job_time_limit"}'::jsonb WHEN generation>=${attempts} THEN '{"kind":"error","code":"code_job_failed"}'::jsonb ELSE NULL END,
    lease_expires_at=NULL,lease_key_hash=NULL
    WHERE id IN(SELECT id FROM code.jobs WHERE (state='running' AND lease_expires_at<=clock_timestamp()) OR (state='queued' AND deadline_at<=clock_timestamp()) ORDER BY deadline_at,id LIMIT 100 FOR UPDATE SKIP LOCKED)`;
  await sql`INSERT INTO code.job_outbox(job_id) SELECT id FROM code.jobs WHERE state='queued' ORDER BY created_at,id LIMIT 100 ON CONFLICT DO NOTHING`;
  await sql`DELETE FROM code.jobs WHERE id IN(SELECT id FROM code.jobs WHERE deadline_at<clock_timestamp()-interval '15 seconds' ORDER BY deadline_at LIMIT 100 FOR UPDATE SKIP LOCKED)`;
}
/** Bounded shared database wait, safe through any Core instance; cancellation fences current runner work. */
async function submitJob(input: CodeRunnerJobInput, context: CodeContext): Promise<RunnerJobResult> {
  const person = codePerson(context, true);
  context.signal?.throwIfAborted();
  const encoded = JSON.stringify(input);
  if (Buffer.byteLength(encoded) > CODE_CHECK_LIMITS.requestBytes) throw new CodeJobError("code_job_request_limit");
  const queueMax = await codeSettings.get("core.code.job_pending");
  const ownerMax = await codeSettings.get("core.code.concurrency_per_owner");
  const waitMs = await codeSettings.get("core.code.job_wait_ms");
  const workMs = input.kind === "check" ? (input.request.limits?.checkMs ?? CODE_CHECK_LIMITS.checkMs) : input.limits.wallClockMs;
  const [job] = await sql.begin(async (db) => {
    await codeAdmissionLock(db);
    const [counts] = await db<
      { total: number; own: number }[]
    >`SELECT count(*)::int AS total,count(*) FILTER(WHERE owner_id=${person.id}::uuid)::int AS own FROM code.jobs WHERE state IN('queued','running')`;
    if (counts!.total >= queueMax || counts!.own >= ownerMax) throw new CodeJobError("code_job_busy");
    return db<{ id: string; deadline_at: Date }[]>`INSERT INTO code.jobs(kind,owner_id,input,input_bytes,output_bytes,deadline_at)
      VALUES(${input.kind},${person.id}::uuid,${encoded},${Buffer.byteLength(encoded)},${CODE_CHECK_LIMITS.outputBytes},clock_timestamp()+${waitMs + workMs}*interval '1 millisecond') RETURNING id,deadline_at`;
  });
  if (!job) throw new CodeJobError("code_job_failed");
  const timeout = AbortSignal.timeout(waitMs + workMs);
  const signal = AbortSignal.any([timeout, ...(context.signal ? [context.signal] : [])]);
  try {
    while (!signal.aborted) {
      const [row] = await sql<{ state: string; result: unknown }[]>`SELECT state,result FROM code.jobs WHERE id=${job.id}::uuid`;
      if (row?.result) {
        const result = RunnerJobResultSchema.parse(row.result);
        if (result.kind === "error") throw new CodeJobError(result.code);
        return result;
      }
      if (!row || row.state === "cancelled") throw new CodeJobError("code_job_cancelled");
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, 100);
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
    }
    throw new CodeJobError(context.signal?.aborted ? "code_job_cancelled" : "code_job_time_limit");
  } finally {
    await sql`UPDATE code.jobs SET state='cancelled',input=NULL,lease_key_hash=NULL WHERE id=${job.id}::uuid AND state IN('queued','running')`;
  }
}
/** Production remote checker for C8/C18a/C19. The caller supplies platform-generated SDK/grant metadata. */
export function createRunnerCodeCheckHost(context: CodeContext): Extract<CodeCheckHost, { check: unknown }> {
  return {
    check: async (request: CodeCheckRequest, signal?: AbortSignal): Promise<CodeCheckResult> => {
      const effective = {
        ...context,
        signal: signal ? AbortSignal.any([signal, ...(context.signal ? [context.signal] : [])]) : context.signal,
      };
      const limits = {
        ...CODE_CHECK_LIMITS,
        sourceBytes: Math.min(CODE_CHECK_LIMITS.sourceBytes, await codeSettings.get("core.code.source_bytes")),
        bundleBytes: Math.min(CODE_CHECK_LIMITS.bundleBytes, await codeSettings.get("core.code.bundle_bytes")),
        files: Math.min(CODE_CHECK_LIMITS.files, await codeSettings.get("core.code.source_files")),
        checkMs: Math.min(CODE_CHECK_LIMITS.checkMs, await codeSettings.get("core.code.wall_clock_ms")),
        memoryBytes: Math.min(CODE_CHECK_LIMITS.memoryBytes, await codeSettings.get("core.code.runner_process_memory_bytes")),
      };
      const result = await submitJob({ kind: "check", request: { ...request, limits } }, effective);
      if (result.kind !== "check") throw new CodeJobError("code_job_failed");
      return CodeCheckResultSchema.parse(result.result);
    },
  };
}
/** Production fake-only test host. Every check and execution uses the shared runner pool, never Core's process. */
export async function createRunnerCodeTestingHost(context: CodeContext): Promise<CodeTestingHost> {
  const limits: CodeTestLimits = {
    requestBytes: CODE_CHECK_LIMITS.requestBytes,
    outputBytes: CODE_CHECK_LIMITS.outputBytes,
    cases: await codeSettings.get("core.code.test_cases"),
    runs: await codeSettings.get("core.code.test_runs"),
    calls: await codeSettings.get("core.code.calls_per_run"),
    wallClockMs: await codeSettings.get("core.code.wall_clock_ms"),
  };
  return {
    ...createRunnerCodeCheckHost(context),
    limits,
    execute: async (execution, signal) => {
      const result = await submitJob(
        { kind: execution.mode, execution, limits },
        { ...context, signal: signal ? AbortSignal.any([signal, ...(context.signal ? [context.signal] : [])]) : context.signal },
      );
      if (result.kind !== "test" && result.kind !== "simulate") throw new CodeJobError("code_job_failed");
      return CodeTestResultSchema.parse(result.result);
    },
  };
}
