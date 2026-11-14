import { CodeRequestError } from "./requests";

/** Bound the waiting HTTP request even when a dependency has no cancellation API.
 * Admission checks the same signal before enqueue/commit; admitted work is fenced in its finally block. */
export async function waitCodeRequest<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new CodeRequestError("code_request_timeout", 504));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([work, stopped]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
