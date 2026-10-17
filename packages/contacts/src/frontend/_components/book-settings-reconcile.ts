type ReconciliationState = {
  reconciling: boolean;
  error: string | null;
};

export const createQueuedReconciliation = (reload: () => Promise<void>, updateState: (state: ReconciliationState) => void) => {
  let disposed = false;
  let running = false;
  let error: string | null = null;
  const queue: { message: string; resolve: () => void }[] = [];

  const drain = async (): Promise<void> => {
    if (disposed || running || error || queue.length === 0) return;
    running = true;
    updateState({ reconciling: true, error: null });
    try {
      while (!disposed && queue.length > 0) {
        const item = queue[0]!;
        try {
          await reload();
          queue.shift();
          item.resolve();
        } catch {
          if (disposed) return;
          error = item.message;
          for (const queued of queue) queued.resolve();
          break;
        }
      }
    } finally {
      running = false;
      if (!disposed) updateState({ reconciling: false, error });
    }
  };

  // A successful write waits for its covering reload. Failed reloads remain queued
  // for retry, but release the writer: the visible error owns recovery from here.
  const run = (message: string): Promise<void> => {
    if (disposed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      queue.push({ message, resolve });
      if (error) resolve();
      else void drain();
    });
  };

  const retry = async (): Promise<void> => {
    if (disposed || !error) return;
    error = null;
    await drain();
  };

  const dispose = () => {
    disposed = true;
    for (const item of queue) item.resolve();
    queue.length = 0;
    error = null;
  };

  return { run, retry, dispose };
};

export const settingsInteractionBlocked = (state: {
  writePending: boolean;
  childWritePending: boolean;
  coveragePending: boolean;
  coverageError: boolean;
}): boolean => state.writePending || state.childWritePending || state.coveragePending || state.coverageError;

export const createBlockedReconciliation = (reload: () => Promise<void>, updateState: (state: ReconciliationState) => void) => {
  let disposed = false;
  let pendingResolve: (() => void) | null = null;
  let failureMessage: string | null = null;

  const run = async (message: string): Promise<void> => {
    updateState({ reconciling: true, error: null });
    try {
      await reload();
      if (!disposed) updateState({ reconciling: false, error: null });
    } catch {
      if (disposed) return;
      failureMessage = message;
      updateState({ reconciling: false, error: message });
      await new Promise<void>((resolve) => {
        pendingResolve = resolve;
      });
    }
  };

  const retry = async (): Promise<void> => {
    if (disposed || !pendingResolve || !failureMessage) return;
    updateState({ reconciling: true, error: null });
    try {
      await reload();
      if (disposed) return;
      const resolve = pendingResolve;
      pendingResolve = null;
      failureMessage = null;
      updateState({ reconciling: false, error: null });
      resolve();
    } catch {
      if (!disposed) updateState({ reconciling: false, error: failureMessage });
    }
  };

  const dispose = () => {
    disposed = true;
    pendingResolve?.();
    pendingResolve = null;
    failureMessage = null;
  };

  return { run, retry, dispose };
};
