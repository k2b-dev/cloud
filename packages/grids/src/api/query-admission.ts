import type { AuthContext } from "@valentinkolb/cloud/server";
import type { Context, MiddlewareHandler } from "hono";
import { boundedQueryPoolSize } from "../service/bounded-query";
import { apiMessages } from "./messages";

type QueryAdmissionRejection = "aborted" | "full" | "timeout";
type QueryAdmissionResult<T> = { ok: true; value: T } | { ok: false; reason: QueryAdmissionRejection };

type QueryAdmissionOptions = {
  maxActive: number;
  maxQueued: number;
  waitTimeoutMs: number;
};

type Waiter = {
  resolve: (reason: QueryAdmissionRejection | null) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer: ReturnType<typeof setTimeout>;
};

const positiveInteger = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
};

const nonNegativeInteger = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
};

export const createQueryAdmission = (options: QueryAdmissionOptions) => {
  if (!Number.isSafeInteger(options.maxActive) || options.maxActive < 1) throw new RangeError("maxActive must be a positive integer");
  if (!Number.isSafeInteger(options.maxQueued) || options.maxQueued < 0) throw new RangeError("maxQueued must be a non-negative integer");
  if (!Number.isSafeInteger(options.waitTimeoutMs) || options.waitTimeoutMs < 1) {
    throw new RangeError("waitTimeoutMs must be a positive integer");
  }

  let active = 0;
  const queue: Waiter[] = [];

  const remove = (waiter: Waiter): boolean => {
    const index = queue.indexOf(waiter);
    if (index < 0) return false;
    queue.splice(index, 1);
    return true;
  };

  const finishWait = (waiter: Waiter): void => {
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
  };

  const grantNext = (): void => {
    while (active < options.maxActive) {
      const waiter = queue.shift();
      if (!waiter) return;
      finishWait(waiter);
      if (waiter.signal?.aborted) {
        waiter.resolve("aborted");
        continue;
      }
      active += 1;
      waiter.resolve(null);
    }
  };

  const acquire = async (signal?: AbortSignal): Promise<QueryAdmissionRejection | null> => {
    if (signal?.aborted) return "aborted";
    if (active < options.maxActive) {
      active += 1;
      return null;
    }
    if (queue.length >= options.maxQueued) return "full";

    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve,
        signal,
        timer: setTimeout(() => {
          if (remove(waiter)) {
            finishWait(waiter);
            resolve("timeout");
          }
        }, options.waitTimeoutMs),
      };
      queue.push(waiter);
      if (signal) {
        waiter.onAbort = () => {
          if (remove(waiter)) {
            finishWait(waiter);
            resolve("aborted");
          }
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
        if (signal.aborted) waiter.onAbort();
      }
    });
  };

  const release = (): void => {
    active -= 1;
    grantNext();
  };

  return {
    async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<QueryAdmissionResult<T>> {
      const rejected = await acquire(signal);
      if (rejected) return { ok: false, reason: rejected };
      try {
        if (signal?.aborted) return { ok: false, reason: "aborted" };
        return { ok: true, value: await task() };
      } finally {
        release();
      }
    },
    stats: () => ({ active, queued: queue.length }),
  };
};

type QueryAdmission = ReturnType<typeof createQueryAdmission>;

class QueryAdmissionError extends Error {
  override readonly name = "QueryAdmissionError";

  constructor(readonly reason: QueryAdmissionRejection) {
    super(`query admission rejected: ${reason}`);
  }
}

export const isQueryAdmissionError = (error: unknown): error is QueryAdmissionError => error instanceof QueryAdmissionError;

// Long-running reads use a dedicated pool, so admission can match its capacity
// without starving authentication, metadata reads, or writes.
const queryAdmission = createQueryAdmission({
  maxActive: positiveInteger("GRIDS_QUERY_CONCURRENCY", boundedQueryPoolSize),
  maxQueued: nonNegativeInteger("GRIDS_QUERY_QUEUE_LIMIT", 64),
  waitTimeoutMs: positiveInteger("GRIDS_QUERY_QUEUE_TIMEOUT_MS", 1_000),
});

const admittedRequests = new WeakSet<Request>();

export const runWithQueryAdmissionSignal = async <T>(
  signal: AbortSignal,
  task: (signal: AbortSignal) => Promise<T>,
  admission: QueryAdmission = queryAdmission,
): Promise<T> => {
  const result = await admission.run(() => task(signal), signal);
  if (!result.ok) throw new QueryAdmissionError(result.reason);
  return result.value;
};

export const runWithQueryAdmission = async <T>(
  c: Context<AuthContext>,
  task: (signal: AbortSignal) => Promise<T>,
  admission: QueryAdmission = queryAdmission,
): Promise<T> => {
  const request = c.req.raw;
  if (admittedRequests.has(request)) return task(request.signal);
  return runWithQueryAdmissionSignal(request.signal, task, admission);
};

export const queryAdmissionMiddleware = (admission: QueryAdmission = queryAdmission): MiddlewareHandler<AuthContext> => {
  return async (c, next) => {
    const result = await admission.run(async () => {
      admittedRequests.add(c.req.raw);
      try {
        await next();
      } finally {
        admittedRequests.delete(c.req.raw);
      }
    }, c.req.raw.signal);
    if (result.ok) return;
    c.header("Retry-After", "1");
    return c.json({ message: apiMessages(c).queryBusy }, 503);
  };
};
