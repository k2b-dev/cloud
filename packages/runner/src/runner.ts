import type { RunnerBridge, RunnerCallResponse, RunnerConfig, RunnerLease, RunnerLeaseProof, RunnerOutcome } from "@k2b/cloud/code/runner";
import {
  RunnerCallError,
  type RunnerJobLease,
  RunnerJobLeaseSchema,
  type RunnerJobResult,
  RunnerLeaseLostError,
  RunnerLeaseSchema,
} from "@k2b/cloud/code/runner";
import { BundleCache } from "./cache";
import type { RunnerEngine } from "./engine";
import { executeRunnerJob } from "./jobs";

const proof = ({ runId, generation, token }: RunnerLease): RunnerLeaseProof => ({ runId, generation, token });
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });

/** Stateless lease consumer. stop() cancels only acquisition; accepted work retains its original deadline. */
export class Runner {
  #poll = new AbortController();
  #active = new Map<string, Promise<void>>();
  #config!: RunnerConfig;
  #cache!: BundleCache;
  readonly instanceId = crypto.randomUUID();
  constructor(
    readonly bridge: RunnerBridge,
    readonly engine: RunnerEngine,
    readonly log = (code: string) => console.warn(code),
    readonly executeJob = executeRunnerJob,
  ) {}
  #isolationFailure(error: unknown) {
    if (error instanceof Error && error.message === "runner_isolation_uid_exhausted") {
      this.log("runner_isolation_uid_exhausted");
      process.exitCode = 1;
      this.stop();
    }
  }
  stop() {
    this.#poll.abort();
  }
  async start() {
    try {
      while (!this.#poll.signal.aborted) {
        try {
          this.#config = await this.bridge.configure(this.#poll.signal);
          break;
        } catch {
          if (this.#poll.signal.aborted) return;
          this.log("runner_configuration_unavailable");
          await pause(1000, this.#poll.signal);
        }
      }
      if (this.#poll.signal.aborted) return;
      this.#cache = new BundleCache(this.#config.cacheBytes, this.#config.bundleBytes);
      while (!this.#poll.signal.aborted) {
        const freeSlots = this.#config.slots - this.#active.size;
        if (freeSlots === 0) {
          await Promise.race(this.#active.values());
          continue;
        }
        try {
          const { runs, jobs = [] } = await this.bridge.fetch({ instanceId: this.instanceId, freeSlots }, this.#poll.signal);
          // A response racing SIGTERM is not accepted. Core recovers its unacknowledged leases.
          if (this.#poll.signal.aborted) break;
          if (runs.length + jobs.length > freeSlots) throw new Error("runner_over_capacity");
          const leases = runs.map((run) => RunnerLeaseSchema.parse(run));
          const ids = new Set(leases.map((lease) => lease.runId));
          if (ids.size !== leases.length || leases.some((lease) => this.#active.has(lease.runId)))
            throw new Error("runner_duplicate_lease");
          const authoring = jobs.map((job) => RunnerJobLeaseSchema.parse(job));
          if (
            new Set(authoring.map((job) => job.jobId)).size !== authoring.length ||
            authoring.some((job) => this.#active.has(`job:${job.jobId}`))
          )
            throw new Error("runner_duplicate_lease");
          for (const job of authoring) {
            const id = `job:${job.jobId}`;
            const task = this.#executeJob(job).finally(() => this.#active.delete(id));
            this.#active.set(id, task);
          }
          for (const lease of leases) {
            const task = this.#execute(lease).finally(() => this.#active.delete(lease.runId));
            this.#active.set(lease.runId, task);
          }
          // A valid empty response normally waited pollMs. This also bounds a broken server's hot loop.
          if (leases.length + authoring.length === 0) await pause(this.#config.retryMs, this.#poll.signal);
        } catch {
          if (!this.#poll.signal.aborted) {
            this.log("runner_fetch_unavailable");
            await pause(this.#config.retryMs, this.#poll.signal);
          }
        }
      }
    } finally {
      await Promise.allSettled(this.#active.values());
      await this.engine.close();
    }
  }
  async #executeJob(lease: RunnerJobLease) {
    const controller = new AbortController();
    let expiresAt = lease.leaseExpiresAt;
    const proof = { jobId: lease.jobId, generation: lease.generation, leaseKey: lease.leaseKey };
    let beatTimer: ReturnType<typeof setTimeout> | undefined, expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const expire = () => {
      clearTimeout(expiryTimer);
      expiryTimer = setTimeout(() => controller.abort(), Math.max(0, Math.min(expiresAt, lease.deadlineAt) - Date.now()));
    };
    const beat = async () => {
      try {
        const renewed = await this.bridge.jobHeartbeat!(proof, controller.signal);
        if (renewed.leaseExpiresAt > lease.deadlineAt || renewed.leaseExpiresAt <= Date.now()) throw new RunnerLeaseLostError();
        expiresAt = renewed.leaseExpiresAt;
        expire();
      } catch (error) {
        if (error instanceof RunnerLeaseLostError) controller.abort();
        else if (!controller.signal.aborted) this.log("runner_job_heartbeat_unavailable");
      }
      if (!controller.signal.aborted) beatTimer = setTimeout(beat, lease.heartbeatMs);
    };
    expire();
    beatTimer = setTimeout(beat, lease.heartbeatMs);
    try {
      let result: RunnerJobResult;
      try {
        controller.signal.throwIfAborted();
        if (!this.bridge.jobInput || !this.bridge.jobHeartbeat || !this.bridge.jobComplete) throw new Error("runner_job_transport_missing");
        const input = await (async () => {
          while (!controller.signal.aborted) {
            try {
              return await this.bridge.jobInput!(proof, controller.signal, lease.inputBytes);
            } catch (error) {
              if (error instanceof RunnerLeaseLostError) {
                controller.abort();
                throw error;
              }
              if (!controller.signal.aborted) this.log("runner_job_input_unavailable");
              await pause(this.#config.retryMs, controller.signal);
            }
          }
          throw controller.signal.reason;
        })();
        result = await this.executeJob(lease, input, this.#config, controller.signal);
      } catch (error) {
        this.#isolationFailure(error);
        if (controller.signal.aborted) return;
        result = {
          kind: "error",
          code: error instanceof Error && error.message === "runner_response_too_large" ? "code_job_output_limit" : "code_job_failed",
        };
      }
      while (!controller.signal.aborted) {
        try {
          await this.bridge.jobComplete!({ ...proof, result }, controller.signal);
          break;
        } catch (error) {
          if (error instanceof RunnerLeaseLostError) break;
          this.log("runner_job_completion_unavailable");
          await pause(this.#config.retryMs, controller.signal);
        }
      }
    } finally {
      clearTimeout(beatTimer);
      clearTimeout(expiryTimer);
      controller.abort();
    }
  }
  async #execute(lease: RunnerLease) {
    const controller = new AbortController();
    let outcome: RunnerOutcome = "failed";
    let expiresAt = lease.leaseExpiresAt;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const expire = () => {
      clearTimeout(expiry);
      expiry = setTimeout(
        () => {
          if (!controller.signal.aborted) {
            outcome = "lease_lost";
            controller.abort();
          }
        },
        Math.max(0, expiresAt - Date.now()),
      );
    };
    const beat = async () => {
      try {
        const renewed = await this.bridge.heartbeat(proof(lease), controller.signal);
        controller.signal.throwIfAborted();
        if (renewed.leaseExpiresAt <= Date.now() || renewed.leaseExpiresAt > lease.deadlineAt) throw new Error("runner_invalid_lease");
        expiresAt = renewed.leaseExpiresAt;
        expire();
      } catch (error) {
        if (error instanceof RunnerLeaseLostError && !controller.signal.aborted) {
          outcome = "lease_lost";
          controller.abort();
        } else if (!controller.signal.aborted) this.log("runner_heartbeat_unavailable");
      }
      if (!controller.signal.aborted) heartbeat = setTimeout(beat, Math.min(lease.heartbeatMs, Math.max(1, expiresAt - Date.now())));
    };
    const deadline = setTimeout(
      () => {
        if (!controller.signal.aborted) {
          outcome = "wall_clock_limit";
          controller.abort();
        }
      },
      Math.max(0, lease.deadlineAt - Date.now()),
    );
    expire();
    heartbeat = setTimeout(beat, lease.heartbeatMs);
    try {
      if (lease.deadlineAt <= Date.now() || expiresAt <= Date.now()) {
        outcome = lease.deadlineAt <= Date.now() ? "wall_clock_limit" : "lease_lost";
        controller.abort();
      }
      controller.signal.throwIfAborted();
      const source = await this.#cache.get(lease.bundleHash, () =>
        this.bridge.bundle({ ...proof(lease), bundleHash: lease.bundleHash }, controller.signal),
      );
      controller.signal.throwIfAborted();
      await this.engine.load(
        lease,
        source,
        this.#config,
        async (operation, input) => {
          let result: RunnerCallResponse;
          try {
            result = await this.bridge.call({ ...proof(lease), operation, input }, controller.signal);
          } catch (error) {
            if (error instanceof RunnerLeaseLostError && !controller.signal.aborted) {
              outcome = "lease_lost";
              controller.abort();
            }
            throw error;
          }
          if (!result.ok) {
            if (result.error.code === "runner_lease_lost" && !controller.signal.aborted) {
              outcome = "lease_lost";
              controller.abort();
            }
            throw new RunnerCallError(result.error.code);
          }
          return result.data;
        },
        controller.signal,
      );
      controller.signal.throwIfAborted();
      const result = await this.engine.run(lease, controller.signal);
      if (!controller.signal.aborted) outcome = result;
    } catch (error) {
      this.#isolationFailure(error);
      if (error instanceof RunnerLeaseLostError && !controller.signal.aborted) outcome = "lease_lost";
      /* A failed attempt is recorded without bundle exceptions or payloads. */
    } finally {
      clearTimeout(deadline);
      clearTimeout(heartbeat);
      clearTimeout(expiry);
      controller.abort();
      try {
        await this.engine.kill(lease.runId);
      } catch {
        this.log("runner_cleanup_failed");
      }
    }
    try {
      await this.bridge.complete({ ...proof(lease), outcome }, AbortSignal.timeout(this.#config.transportMs));
    } catch {
      this.log("runner_completion_unavailable"); /* Core's lease reconciler owns recovery. */
    }
  }
}
