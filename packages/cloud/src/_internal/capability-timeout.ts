import type { Context } from "hono";
import { REQUEST_IDLE_TIMEOUT_SECONDS, setRequestTimeout } from "../server/request-timeout";

type InvocationKind = "query" | "action" | "review";
export type CapabilityTimeoutOverrides = { queryTimeoutMs?: number; actionTimeoutMs?: number; reviewTimeoutMs?: number };

/** Discovery and recent-resource reads keep their short, independent budget. */
export const CAPABILITY_DISCOVERY_TIMEOUT_MS = 15_000;

export const capabilityTimeoutMs = (kind: InvocationKind, overrides: CapabilityTimeoutOverrides = {}): number => {
  if (kind === "review") return overrides.reviewTimeoutMs ?? 15_000;
  return kind === "query" ? (overrides.queryTimeoutMs ?? 45_000) : (overrides.actionTimeoutMs ?? 30_000);
};

/** Only JSON request owners use this; streaming responses own their idle lifecycle. */
export const withCapabilityRequestTimeout = async <T>(c: Context, kind: InvocationKind, run: () => Promise<T>): Promise<T> => {
  setRequestTimeout(c, Math.ceil(capabilityTimeoutMs(kind) / 1000) + REQUEST_IDLE_TIMEOUT_SECONDS);
  try {
    return await run();
  } finally {
    setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_SECONDS);
  }
};

/** One monotonic budget, including preparation. Waiting reads never start after it expires. */
export const createCapabilityDeadline = (timeoutMs: number, caller: AbortSignal) => {
  const controller = new AbortController();
  const expiresAt = performance.now() + timeoutMs;
  const expire = () => controller.abort(new DOMException("Capability deadline exceeded", "TimeoutError"));
  const timer = setTimeout(expire, timeoutMs);
  const signal = AbortSignal.any([caller, controller.signal]);
  const check = () => {
    if (performance.now() >= expiresAt) expire();
    signal.throwIfAborted();
  };
  const wait = <T>(read: () => Promise<T>): Promise<T> => {
    check();
    return new Promise<T>((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      signal.addEventListener("abort", aborted, { once: true });
      // Observe both outcomes even after cancellation; a late read cannot resume dispatch.
      Promise.resolve()
        .then(() => {
          check();
          return read();
        })
        .then(
          (result) => {
            signal.removeEventListener("abort", aborted);
            try {
              check();
              resolve(result);
            } catch (error) {
              reject(error);
            }
          },
          (error) => {
            signal.removeEventListener("abort", aborted);
            reject(error);
          },
        );
    });
  };
  return {
    signal,
    check,
    wait,
    remainingMs: () => Math.max(1, Math.ceil(expiresAt - performance.now())),
    clear: () => clearTimeout(timer),
  };
};
