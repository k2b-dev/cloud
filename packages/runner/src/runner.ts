import type { RunnerBridge, RunnerConfig, RunnerLease, RunnerLeaseProof, RunnerOutcome } from "@k2b/cloud/code/runner";
import { RunnerLeaseSchema } from "@k2b/cloud/code/runner";
import { BundleCache } from "./cache";
import type { RunnerEngine } from "./engine";

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
  ) {}
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
          const { runs } = await this.bridge.fetch({ instanceId: this.instanceId, freeSlots }, this.#poll.signal);
          // A response racing SIGTERM is not accepted. Core recovers its unacknowledged leases.
          if (this.#poll.signal.aborted) break;
          if (runs.length > freeSlots) throw new Error("runner_over_capacity");
          const leases = runs.map((run) => RunnerLeaseSchema.parse(run));
          const ids = new Set(leases.map((lease) => lease.runId));
          if (ids.size !== leases.length || leases.some((lease) => this.#active.has(lease.runId)))
            throw new Error("runner_duplicate_lease");
          for (const lease of leases) {
            const task = this.#execute(lease).finally(() => this.#active.delete(lease.runId));
            this.#active.set(lease.runId, task);
          }
          // A valid empty response normally waited pollMs. This also bounds a broken server's hot loop.
          if (leases.length === 0) await pause(this.#config.retryMs, this.#poll.signal);
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
          outcome = "lease_lost";
          controller.abort();
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
      } catch {
        if (!controller.signal.aborted) this.log("runner_heartbeat_unavailable");
      }
      if (!controller.signal.aborted) heartbeat = setTimeout(beat, Math.min(lease.heartbeatMs, Math.max(1, expiresAt - Date.now())));
    };
    const deadline = setTimeout(
      () => {
        outcome = "wall_clock_limit";
        controller.abort();
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
        (operation, input) => this.bridge.call({ ...proof(lease), operation, input }, controller.signal),
        controller.signal,
      );
      controller.signal.throwIfAborted();
      const result = await this.engine.run(lease, controller.signal);
      if (!controller.signal.aborted) outcome = result;
    } catch {
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
