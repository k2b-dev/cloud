/**
 * Runs lease-holding work and renews its leases every `intervalMs`.
 *
 * The work's signal aborts when a renewal fails or, with `deadline`, when the
 * work outlives `deadline.ms`. Renewal stops for good once the signal aborts,
 * so a lost or overdue operation cannot keep its leases and job delivery alive.
 * The helper still waits for the work to settle before releasing its caller's
 * leases: work must honor the signal promptly. The abort reason wins over the
 * work's own outcome.
 */
export const withLeaseHeartbeat = async <T>(params: {
  intervalMs: number;
  heartbeat: () => Promise<void>;
  deadline?: { ms: number; error: () => Error };
  work: (assertLeaseActive: () => Promise<void>, signal: AbortSignal) => Promise<T>;
}): Promise<T> => {
  if (!Number.isSafeInteger(params.intervalMs) || params.intervalMs < 1) {
    throw new Error("Lease heartbeat interval must be a positive integer");
  }
  if (params.deadline && (!Number.isSafeInteger(params.deadline.ms) || params.deadline.ms < 1)) {
    throw new Error("Lease work deadline must be a positive integer");
  }

  let stopped = false;
  let aborted = false;
  let abortReason: unknown;
  const abortController = new AbortController();
  const abort = (reason: unknown): void => {
    if (aborted) return;
    aborted = true;
    abortReason = reason;
    abortController.abort(reason);
  };
  let heartbeatChain = Promise.resolve();
  const queueHeartbeat = (): Promise<void> => {
    heartbeatChain = heartbeatChain.then(async () => {
      if (stopped || aborted) return;
      try {
        await params.heartbeat();
      } catch (error) {
        abort(error);
      }
    });
    return heartbeatChain;
  };
  const assertLeaseActive = async (): Promise<void> => {
    await queueHeartbeat();
    if (aborted) throw abortReason;
  };
  const timer = setInterval(() => {
    void queueHeartbeat();
  }, params.intervalMs);
  const deadline = params.deadline;
  const deadlineTimer = deadline ? setTimeout(() => abort(deadline.error()), deadline.ms) : undefined;

  let workFailed = false;
  let workError: unknown;
  let result!: T;
  try {
    await assertLeaseActive();
    result = await params.work(assertLeaseActive, abortController.signal);
  } catch (error) {
    workFailed = true;
    workError = error;
  } finally {
    stopped = true;
    clearInterval(timer);
    clearTimeout(deadlineTimer);
    await heartbeatChain;
  }

  if (aborted) throw abortReason;
  if (workFailed) throw workError;
  return result;
};
