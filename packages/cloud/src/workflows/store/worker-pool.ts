/** Bounded claim loops. A free slot never waits for another slot's action. */
export const createWorkflowWorkerPool = (options: {
  concurrency: number;
  /** True when a run was handled; false when no run was claimable. */
  run(): Promise<boolean>;
  onError(error: unknown): void;
}) => {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
    throw new RangeError("Workflow concurrency must be a positive integer");
  }
  const tasks = new Set<Promise<void>>();
  let accepting = false;
  let generation = 0;

  const wake = (): void => {
    if (!accepting) return;
    generation += 1;
    while (tasks.size < options.concurrency) {
      let observed = generation;
      let failed = false;
      const task = Promise.resolve().then(async () => {
        try {
          while (accepting) {
            observed = generation;
            const handled = await options.run();
            // A wake received during an empty claim needs another attempt.
            if (!handled && observed === generation) return;
          }
        } catch (error) {
          failed = true;
          options.onError(error);
          // Recovery wakes us again; never spin on a failing database.
        }
      });
      tasks.add(task);
      const finished = () => {
        tasks.delete(task);
        if (!failed && observed !== generation) wake();
      };
      void task.then(finished, finished);
    }
  };

  return {
    start: (): void => {
      accepting = true;
      wake();
    },
    wake,
    stop: async (): Promise<void> => {
      accepting = false;
      await Promise.allSettled([...tasks]);
    },
  };
};
