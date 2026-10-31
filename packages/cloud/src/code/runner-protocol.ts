import { z } from "zod";

/** Private Core routes. Every POST uses a fresh cloud-app+jwt proof over its exact path and UTF-8 body. */
export const RUNNER_PATHS = {
  config: "/_internal/code/runner/config",
  fetch: "/_internal/code/runner/fetch",
  bundle: "/_internal/code/runner/bundle",
  heartbeat: "/_internal/code/runner/heartbeat",
  complete: "/_internal/code/runner/complete",
  call: "/_internal/code/runner/call",
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
export const RunnerFetchResponseSchema = z.object({ runs: z.array(RunnerLeaseSchema) }).strict();
export type RunnerFetchResponse = z.infer<typeof RunnerFetchResponseSchema>;

/** All run mutations and bridge calls carry the same lease identity, alongside the app signature. */
export const RunnerLeaseProofSchema = RunnerLeaseSchema.pick({ runId: true, generation: true, token: true });
export type RunnerLeaseProof = z.infer<typeof RunnerLeaseProofSchema>;
/** Core renews only the current generation, never beyond the run's wall-clock deadline. */
export type RunnerHeartbeatRequest = RunnerLeaseProof;
export const RunnerHeartbeatResponseSchema = z.object({ leaseExpiresAt: positive }).strict();
export type RunnerHeartbeatResponse = z.infer<typeof RunnerHeartbeatResponseSchema>;
/** Fetch immutable UTF-8 ESM by hash, authorized through the current lease. The runner verifies SHA-256 before caching. */
export type RunnerBundleRequest = RunnerLeaseProof & { bundleHash: string };
/** Core records these bounded, payload-free terminal outcomes; lease_lost stays owned by Core's lease reconciler. */
export const RunnerOutcomeSchema = z.enum(["succeeded", "failed", "wall_clock_limit", "memory_limit", "stalled", "lease_lost"]);
export type RunnerOutcome = z.infer<typeof RunnerOutcomeSchema>;
export type RunnerCompleteRequest = RunnerLeaseProof & { outcome: RunnerOutcome };
/** The only sandbox binding. The supervisor attaches identity; code cannot select a token, run or generation. */
export type RunnerCallRequest = RunnerLeaseProof & { operation: string; input: RunnerJsonValue };
/** Transport-neutral seam used by C13 and the C14/C17 mock bridge. No database or queue client belongs here. */
export interface RunnerBridge {
  configure(signal: AbortSignal): Promise<RunnerConfig>;
  fetch(request: RunnerFetchRequest, signal: AbortSignal): Promise<RunnerFetchResponse>;
  bundle(request: RunnerBundleRequest, signal: AbortSignal): Promise<string>;
  heartbeat(request: RunnerHeartbeatRequest, signal: AbortSignal): Promise<RunnerHeartbeatResponse>;
  complete(request: RunnerCompleteRequest, signal: AbortSignal): Promise<void>;
  call(request: RunnerCallRequest, signal: AbortSignal): Promise<RunnerJsonValue>;
}
