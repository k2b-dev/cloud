import { env } from "../config/env";
import { logger } from "./logging";
import { requestCacheRedis } from "./request-cache-redis";

// Preserve the existing single-process PDF and immediate SMTP limits as the
// installation's baseline. Local counters still protect each process's memory.
const CAPACITY = { gotenberg: 2, smtp: 8 } as const;
type Downstream = keyof typeof CAPACITY;
type Client = { send(command: string, args: string[]): Promise<unknown> };

const ACQUIRE = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then return 0 end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[3])
local last = redis.call('ZRANGE', KEYS[1], -1, -1, 'WITHSCORES')
redis.call('PEXPIRE', KEYS[1], math.ceil(tonumber(last[2]) - now))
return 1
`;

export class DownstreamBusyError extends Error {
  constructor(readonly downstream: Downstream) {
    super(`${downstream} is busy; retry later.`);
    this.name = "DownstreamBusyError";
  }
}

/** No admission queue: one atomic attempt, bounded by the caller's operation deadline. */
export const createDownstreamBudget = (options: { client?: () => Promise<Client>; namespace?: () => string } = {}) => ({
  async acquire(input: { downstream: Downstream; timeoutMs: number; signal: AbortSignal }): Promise<() => void> {
    input.signal.throwIfAborted();
    if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) throw new RangeError("Downstream timeout must be positive and finite");
    const namespace = options.namespace?.() ?? env.SYNC_NAMESPACE;
    if (!namespace.trim()) throw new Error("SYNC_NAMESPACE is required for shared downstream budgets");
    const key = `cloud:downstream:{${namespace}}:${input.downstream}`;
    const token = crypto.randomUUID();
    let client: Client | undefined;
    const release = () => {
      // Release does not delay a response or shutdown during a Valkey outage.
      // Tokens also expire after twice the operation deadline, allowing time
      // for aborted HTTP/SMTP sockets to close before a crashed slot is reused.
      try {
        void client?.send("ZREM", [key, token]).catch(() => {});
      } catch {
        // A synchronous client failure must not turn SMTP success into a retry.
      }
    };
    let cancelled = false;
    let onAbort: () => void = () => {};
    const admission = (async () => {
      client = await (options.client ?? requestCacheRedis)();
      if (cancelled) return false;
      const admitted =
        Number(await client.send("EVAL", [ACQUIRE, "1", key, String(CAPACITY[input.downstream]), String(input.timeoutMs * 2), token])) ===
        1;
      if (cancelled && admitted) release();
      return admitted;
    })();
    try {
      const admitted = await Promise.race([
        admission,
        new Promise<never>((_, reject) => {
          onAbort = () => {
            cancelled = true;
            reject(input.signal.reason);
          };
          input.signal.addEventListener("abort", onAbort, { once: true });
          if (input.signal.aborted) onAbort();
        }),
      ]);
      if (!admitted) throw new DownstreamBusyError(input.downstream);
      return release;
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason;
      if (!(error instanceof DownstreamBusyError)) {
        // Do not expose connection details, which can include credentials.
        logger("downstream-budget").warn("Downstream admission unavailable", { downstream: input.downstream });
      }
      throw new DownstreamBusyError(input.downstream);
    } finally {
      input.signal.removeEventListener("abort", onAbort);
    }
  },
});

export const downstreamBudget = createDownstreamBudget();
