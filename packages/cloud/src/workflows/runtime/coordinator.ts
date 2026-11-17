export type WorkflowCoordinatorClaim = {
  runId: string;
  executionGeneration: number;
};

export type WorkflowCoordinatorLeaseState = { state: "active" } | { state: "stale" } | { state: "canceled"; message?: string };

export type WorkflowCoordinatorFinishState = { state: "finished" } | { state: "stale" } | { state: "canceled"; message?: string };

export type WorkflowCoordinatorReleaseState =
  | { state: "released" }
  | { state: "retry"; retryAt?: string }
  | { state: "stale" }
  | { state: "canceled"; message?: string };

export interface WorkflowCoordinatorPort<TInput, TClaim extends WorkflowCoordinatorClaim, TResult> {
  claim(input: TInput): Promise<TClaim | null>;
  renew(claim: TClaim): Promise<WorkflowCoordinatorLeaseState>;
  finish(claim: TClaim, result: TResult): Promise<WorkflowCoordinatorFinishState>;
  release(claim: TClaim, error: unknown): Promise<WorkflowCoordinatorReleaseState>;
}

export type WorkflowCoordinatorExecution<TClaim extends WorkflowCoordinatorClaim> = {
  claim: TClaim;
  signal: AbortSignal;
  heartbeat(): Promise<WorkflowCoordinatorLeaseState>;
};

export type WorkflowCoordinatorResult<TClaim extends WorkflowCoordinatorClaim, TResult> =
  | { state: "idle" }
  | { state: "finished"; claim: TClaim; result: TResult }
  | { state: "released"; claim: TClaim; error: unknown }
  | { state: "retry"; claim: TClaim; error: unknown; retryAt?: string }
  | { state: "stale"; claim: TClaim }
  | { state: "canceled"; claim: TClaim; message?: string };

const stoppedResult = <TClaim extends WorkflowCoordinatorClaim>(
  claim: TClaim,
  state: Exclude<WorkflowCoordinatorLeaseState, { state: "active" }>,
): WorkflowCoordinatorResult<TClaim, never> =>
  state.state === "stale" ? { state: "stale", claim } : { state: "canceled", claim, message: state.message };

export const coordinateWorkflowExecution = async <TInput, TClaim extends WorkflowCoordinatorClaim, TResult>(options: {
  input: TInput;
  heartbeatMs: number;
  port: WorkflowCoordinatorPort<TInput, TClaim, TResult>;
  execute(execution: WorkflowCoordinatorExecution<TClaim>): Promise<TResult>;
}): Promise<WorkflowCoordinatorResult<TClaim, TResult>> => {
  if (!Number.isSafeInteger(options.heartbeatMs) || options.heartbeatMs <= 0) {
    throw new Error("heartbeatMs must be a positive integer");
  }

  const claim = await options.port.claim(options.input);
  if (!claim) return { state: "idle" };

  const controller = new AbortController();
  let stopped = false;
  let leaseState: WorkflowCoordinatorLeaseState = { state: "active" };
  let renewal: Promise<WorkflowCoordinatorLeaseState> | null = null;
  let renewalError: unknown;

  const heartbeat = (): Promise<WorkflowCoordinatorLeaseState> => {
    if (stopped) return Promise.resolve(leaseState);
    if (leaseState.state !== "active") return Promise.resolve(leaseState);
    if (renewal) return renewal;
    renewal = Promise.resolve()
      .then(() => options.port.renew(claim))
      .then((next) => {
        leaseState = next;
        if (next.state !== "active") controller.abort(next);
        return next;
      })
      .catch((error) => {
        renewalError ??= error;
        controller.abort(error);
        throw error;
      })
      .finally(() => {
        renewal = null;
      });
    return renewal;
  };

  // runtime-timer: lease heartbeat of work already in flight; quiesce drains that work, so the lease must keep running.
  const timer = setInterval(() => {
    if (!stopped) void heartbeat().catch(() => undefined);
  }, options.heartbeatMs);

  let result!: TResult;
  let executionError: unknown;
  let executionFailed = false;
  try {
    result = await options.execute({ claim, signal: controller.signal, heartbeat });
  } catch (error) {
    executionFailed = true;
    executionError = error;
  } finally {
    stopped = true;
    clearInterval(timer);
    await (renewal as Promise<WorkflowCoordinatorLeaseState> | null)?.catch(() => undefined);
  }

  if (leaseState.state !== "active") return stoppedResult(claim, leaseState);

  if (executionFailed || renewalError !== undefined) {
    const error = renewalError ?? executionError;
    const released = await options.port.release(claim, error);
    if (released.state === "stale" || released.state === "canceled") return stoppedResult(claim, released);
    if (released.state === "released") return { state: "released", claim, error };
    return { state: "retry", claim, error, ...(released.retryAt ? { retryAt: released.retryAt } : {}) };
  }

  const finished = await options.port.finish(claim, result);
  if (finished.state !== "finished") return stoppedResult(claim, finished);
  return { state: "finished", claim, result };
};
