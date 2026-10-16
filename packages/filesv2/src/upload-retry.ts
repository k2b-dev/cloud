import { UploadTransferError } from "./upload-transfer";

/** Five retries give a commit queue or Filegate slot 112 s to clear, without hiding a dead server indefinitely. */
export const UPLOAD_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;
/** Browser probes start after 2 s and double to 30 s; Cancel and the 24 h session lifetime bound the wait. */
export const UPLOAD_NETWORK_PROBE_MS = { initial: 2_000, ceiling: 30_000 } as const;
/** Ten independent rate-limit waits allow bursts to clear but stop a server returning 429 forever. */
export const RATE_LIMIT_WAITS = 10;
/** Longer pauses need a person's decision to try again, rather than an automatic wait above five minutes. */
export const RETRY_AFTER_CEILING_MS = 300_000;

export const createUploadRetryBudget = () => ({ retries: 0, rateLimited: 0, probes: 0 });

/** Transport errors retain their origin; bare fetch/deadline failures came from a Cloud control request. */
export function classifyUploadFailure(error: unknown): UploadTransferError | undefined {
  if (error instanceof UploadTransferError) return error;
  if (error instanceof DOMException && error.name === "TimeoutError")
    return new UploadTransferError(error.message, "stalled", error, undefined, "cloud");
  if (error instanceof TypeError) return new UploadTransferError(error.message, "network", error, undefined, "cloud");
  return undefined;
}

export type UploadRetry = {
  kind: "network" | "stalled" | "busy" | "rate_limited";
  delay: number;
  attempt?: number;
  of?: number;
};

/** One budget per file/run, shared across failure kinds; only a manual retry starts over. */
export function nextUploadRetry(
  error: unknown,
  budget: ReturnType<typeof createUploadRetryBudget>,
  pause: boolean,
  delays: readonly number[] = UPLOAD_RETRY_DELAYS_MS,
): UploadRetry | null {
  const failure = classifyUploadFailure(error);
  if (!failure || failure.kind === "server" || failure.kind === "final") return null;
  if (failure.kind === "network" && pause) {
    const delay = Math.min(UPLOAD_NETWORK_PROBE_MS.ceiling, UPLOAD_NETWORK_PROBE_MS.initial * 2 ** Math.min(budget.probes, 4));
    budget.probes++;
    return { kind: "network", delay };
  }
  if ((failure.retryAfter ?? 0) > RETRY_AFTER_CEILING_MS) return null;
  if (failure.kind === "rate_limited" && failure.retryAfter !== undefined) {
    if (budget.rateLimited >= RATE_LIMIT_WAITS) return null;
    budget.rateLimited++;
    return { kind: "rate_limited", delay: failure.retryAfter };
  }
  if (budget.retries >= delays.length) return null;
  const delay = Math.max(delays[budget.retries]!, failure.retryAfter ?? 0);
  budget.retries++;
  return { kind: failure.kind === "rate_limited" ? "busy" : failure.kind, delay, attempt: budget.retries, of: delays.length };
}

/** Cancellation wakes the caller immediately; the caller decides whether to throw or leave its queue. */
export function sleepUploadRetry(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delay);
    signal.addEventListener("abort", finish, { once: true });
  });
}
