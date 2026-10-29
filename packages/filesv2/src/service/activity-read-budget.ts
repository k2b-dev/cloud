import { REQUEST_IDLE_TIMEOUT_SECONDS } from "@k2b/cloud/server";
import { FilesError } from "./errors";

export type ActivityReadBudget = {
  signal: AbortSignal;
  check(): void;
  remainingMs(): number;
  run<T>(work: () => PromiseLike<T>, cancel?: () => void): Promise<T>;
};

/** History must finish within the existing HTTP idle budget, including identity and SQL work. */
export async function withActivityReadBudget<T>(requestAbort: AbortSignal | undefined, work: (budget: ActivityReadBudget) => Promise<T>) {
  const controller = new AbortController();
  const duration = REQUEST_IDLE_TIMEOUT_SECONDS * 1000;
  const deadline = performance.now() + duration;
  const expire = () => controller.abort(new FilesError("unavailable", 503));
  const timer = setTimeout(expire, duration);
  const signal = requestAbort ? AbortSignal.any([requestAbort, controller.signal]) : controller.signal;
  const budget: ActivityReadBudget = {
    signal,
    check: () => {
      if (performance.now() >= deadline && !signal.aborted) expire();
      signal.throwIfAborted();
    },
    remainingMs: () => {
      budget.check();
      return Math.max(1, Math.ceil(deadline - performance.now()));
    },
    async run(work, cancel) {
      budget.check();
      return new Promise((resolve, reject) => {
        const abort = () => {
          cancel?.();
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        Promise.resolve()
          .then(() => {
            budget.check();
            return work();
          })
          .then(
            (value) => {
              signal.removeEventListener("abort", abort);
              resolve(value);
            },
            (error) => {
              signal.removeEventListener("abort", abort);
              reject(error);
            },
          );
      });
    },
  };
  try {
    budget.check();
    return await work(budget);
  } finally {
    clearTimeout(timer);
  }
}

/** Shared authorization helpers retain their normal behavior outside history reads. */
export const readStep = <T>(budget: ActivityReadBudget | undefined, work: () => PromiseLike<T>): PromiseLike<T> =>
  budget ? budget.run(work) : work();
