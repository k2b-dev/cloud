import { z } from "zod";
import { CodeCheckResultSchema } from "./checker-contract";
import { CodeTestResultSchema } from "./test-contract";

/** Private Core routes. Every POST uses a fresh cloud-app+jwt proof over its exact path and UTF-8 body. */
export const RUNNER_PATHS = {
  config: "/_internal/code/runner/config",
  fetch: "/_internal/code/runner/fetch",
  bundle: "/_internal/code/runner/bundle",
  heartbeat: "/_internal/code/runner/heartbeat",
  complete: "/_internal/code/runner/complete",
  call: "/_internal/code/runner/call",
  jobInput: "/_internal/code/runner/job-input",
} as const;

/** JSON-only values cross the sandbox boundary; streams and object capabilities never do. */
export type RunnerJsonValue = z.infer<ReturnType<typeof z.json>>;

const positive = z.number().int().positive().safe();
const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Core supplies administrator settings, never runner environment variables. Sizes are UTF-8 bytes. */
export const RunnerConfigSchema = z
  .object({
    slots: positive,
    pollMs: positive.max(240_000),
    retryMs: positive,
    transportMs: positive,
    bundleBytes: positive,
    cacheBytes: positive,
    bridgeBytes: positive,
    bridgeConcurrency: positive,
    processMemoryBytes: positive,
  })
  .strict();
/** Per-replica admission and transport budgets supplied by Core before polling begins. */
export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;

/** One attempt, fenced by Core's generation. The opaque token binds code, version, mandate revision and bundle hash. */
export const RunnerLeaseSchema = z
  .object({
    runId: id,
    codeId: id,
    versionId: id,
    organizationId: id,
    trustTier: id,
    entrypoint: id,
    generation: positive,
    mandateRevision: positive,
    bundleHash: hash,
    token: z.string().min(1).max(4096),
    deadlineAt: positive,
    leaseExpiresAt: positive,
    heartbeatMs: positive,
    input: z.json(),
  })
  .strict();
/** Absolute times use Unix milliseconds; neither a heartbeat nor a retry resets deadlineAt. */
export type RunnerLease = z.infer<typeof RunnerLeaseSchema>;

/** Random per-process instanceId is telemetry, not persistent ownership or instance configuration. */
export const RunnerFetchRequestSchema = z.object({ instanceId: z.uuid(), freeSlots: positive }).strict();
/** Core must atomically grant at most freeSlots leases; only Core owns the queue and generation increments. */
export type RunnerFetchRequest = z.infer<typeof RunnerFetchRequestSchema>;
/** Empty runs means the long-poll elapsed. Core waits up to pollMs, with cancellation when the runner drains. */
/** Check/test/simulate leases have no bridge token. leaseKey authorizes only this job generation. */
export const RunnerJobProofSchema = z
  .object({ jobId: z.uuid(), generation: positive, leaseKey: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export type RunnerJobProof = z.infer<typeof RunnerJobProofSchema>;
export const RunnerJobLeaseSchema = RunnerJobProofSchema.extend({
  kind: z.enum(["check", "test", "simulate"]),
  deadlineAt: positive,
  leaseExpiresAt: positive,
  heartbeatMs: positive,
  inputBytes: positive,
  outputBytes: positive,
}).strict();
export type RunnerJobLease = z.infer<typeof RunnerJobLeaseSchema>;
export const RunnerJobResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("check"), result: CodeCheckResultSchema }).strict(),
  z.object({ kind: z.enum(["test", "simulate"]), result: CodeTestResultSchema }).strict(),
  z.object({ kind: z.literal("error"), code: z.enum(["code_job_failed", "code_job_time_limit", "code_job_output_limit"]) }).strict(),
]);
export type RunnerJobResult = z.infer<typeof RunnerJobResultSchema>;
export const RunnerJobCompleteSchema = RunnerJobProofSchema.extend({ result: RunnerJobResultSchema }).strict();
export const RunnerFetchResponseSchema = z
  .object({ runs: z.array(RunnerLeaseSchema), jobs: z.array(RunnerJobLeaseSchema).optional() })
  .strict();
export type RunnerFetchResponse = z.infer<typeof RunnerFetchResponseSchema>;

/** All run mutations and bridge calls carry the same lease identity, alongside the app signature. */
export const RunnerLeaseProofSchema = RunnerLeaseSchema.pick({ runId: true, generation: true, token: true });
export type RunnerLeaseProof = z.infer<typeof RunnerLeaseProofSchema>;
/** Core renews only the current generation, never beyond the run's wall-clock deadline. */
export type RunnerHeartbeatRequest = RunnerLeaseProof;
export const RunnerHeartbeatResponseSchema = z.object({ leaseExpiresAt: positive }).strict();
export type RunnerHeartbeatResponse = z.infer<typeof RunnerHeartbeatResponseSchema>;
/** Fetch immutable UTF-8 ESM by hash, authorized through the current lease. The runner verifies SHA-256 before caching. */
export const RunnerBundleRequestSchema = RunnerLeaseProofSchema.extend({ bundleHash: hash }).strict();
export type RunnerBundleRequest = z.infer<typeof RunnerBundleRequestSchema>;
/** Core records these bounded, payload-free terminal outcomes; lease_lost stays owned by Core's lease reconciler. */
export const RunnerOutcomeSchema = z.enum(["succeeded", "failed", "wall_clock_limit", "memory_limit", "stalled", "lease_lost"]);
export type RunnerOutcome = z.infer<typeof RunnerOutcomeSchema>;
/** Terminal reports carry no exception text or result payload. */
export const RunnerCompleteRequestSchema = RunnerLeaseProofSchema.extend({ outcome: RunnerOutcomeSchema }).strict();
export type RunnerCompleteRequest = z.infer<typeof RunnerCompleteRequestSchema>;
/** The only sandbox binding. The supervisor attaches identity; code cannot select a token, run or generation. */
export const RunnerCallRequestSchema = RunnerLeaseProofSchema.extend({ operation: id, input: z.json() }).strict();
export type RunnerCallRequest = z.infer<typeof RunnerCallRequestSchema>;
/** Stable codes only: exception messages and transport payloads never enter the sandbox. */
export const RunnerCallErrorSchema = z.object({ code: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/) }).strict();
/** Domain refusals use this envelope even when HTTP succeeds; non-2xx responses indicate transport failure. */
export const RunnerCallResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.json() }).strict(),
  z.object({ ok: z.literal(false), error: RunnerCallErrorSchema }).strict(),
]);
export type RunnerCallResponse = z.infer<typeof RunnerCallResponseSchema>;
/** A verified lease has expired or its generation was replaced. Core also uses HTTP 409 on heartbeat. */
export class RunnerLeaseLostError extends Error {
  constructor() {
    super("runner_lease_lost");
  }
}
/** A validated, payload-free Core refusal, preserved as the sandbox Error.message. */
export class RunnerCallError extends Error {
  constructor(readonly code: string) {
    super(RunnerCallErrorSchema.parse({ code }).code);
  }
}
/** Transport-neutral seam used by C13 and the C14/C17 mock bridge. No database or queue client belongs here. */
export interface RunnerBridge {
  configure(signal: AbortSignal): Promise<RunnerConfig>;
  fetch(request: RunnerFetchRequest, signal: AbortSignal): Promise<RunnerFetchResponse>;
  bundle(request: RunnerBundleRequest, signal: AbortSignal): Promise<string>;
  jobInput?(request: RunnerJobProof, signal: AbortSignal, maxBytes: number): Promise<string>;
  jobHeartbeat?(request: RunnerJobProof, signal: AbortSignal): Promise<RunnerHeartbeatResponse>;
  jobComplete?(request: z.infer<typeof RunnerJobCompleteSchema>, signal: AbortSignal): Promise<void>;
  heartbeat(request: RunnerHeartbeatRequest, signal: AbortSignal): Promise<RunnerHeartbeatResponse>;
  complete(request: RunnerCompleteRequest, signal: AbortSignal): Promise<void>;
  call(request: RunnerCallRequest, signal: AbortSignal): Promise<RunnerCallResponse>;
}
