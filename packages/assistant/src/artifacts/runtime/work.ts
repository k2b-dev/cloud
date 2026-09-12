export type WorkState = { status: "running" | "completed" | "cancelled" | "error"; completed: number; total?: number; label?: string };
export function createWork(send: (state: WorkState) => void, output: (value: unknown) => void, error: (error: unknown) => void) {
  let active: AbortController | undefined;
  return {
    run<T>(execute: (context: { signal: AbortSignal; progress: (completed: number, total?: number, label?: string) => void; checkpoint: () => Promise<void> }) => Promise<T>) {
      if (active) throw new Error("A background job is already running");
      const controller = new AbortController();
      active = controller;
      let state: WorkState = { status: "running", completed: 0 };
      send(state);
      // A heartbeat proves the worker event loop is responsive, even while it
      // awaits I/O. A synchronous infinite loop cannot keep this alive.
      const heartbeat = setInterval(() => send(state), 1000);
      const done = Promise.resolve().then(() => execute({
        signal: controller.signal,
        progress(completed, total, label) {
          if (!Number.isFinite(completed) || completed < 0 || (total !== undefined && (!Number.isFinite(total) || total < completed))) throw new Error("Invalid progress");
          state = { status: "running", completed, total, label: label?.slice(0, 1000) };
        },
        async checkpoint() {
          await new Promise(resolve => setTimeout(resolve, 0));
          controller.signal.throwIfAborted();
        },
      })).then(value => {
        controller.signal.throwIfAborted();
        state = { ...state, status: "completed" };
        if (value !== undefined) output(value);
        return value;
      }).catch(cause => {
        state = { ...state, status: controller.signal.aborted ? "cancelled" : "error" };
        // Publish the terminal job state before an entry error can stop the host.
        send(state);
        if (!controller.signal.aborted) error(cause);
        throw cause;
      }).finally(() => { clearInterval(heartbeat); active = undefined; send(state); });
      // GUI launches deliberately do not await completion; failures still reach
      // the console. Headless scripts may await done to receive the result.
      void done.catch(() => {});
      return { done, cancel: () => controller.abort(new Error("Job cancelled")) };
    },
    cancel() { active?.abort(new Error("Job cancelled")); },
  };
}
