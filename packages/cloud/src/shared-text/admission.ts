import { ConflictError, type Mutex } from "@k2b/sync";
import { retry } from "@k2b/sync/retry";

/** Acquisition and validation share one short budget; CAS fences a stalled owner. */
export const SHARED_TEXT_ADMISSION_TIMEOUT_MS = 5_000;
export const SHARED_TEXT_ADMISSION_LEASE_MS = 10_000;

export type SharedTextAdmission = <T>(
  docId: string,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
) => Promise<T>;

export const createSharedTextAdmission = (mutex: () => Pick<Mutex, "withLock">): SharedTextAdmission => {
  const tails = new Map<string, Promise<void>>();
  return async (docId, parent, run) => {
    const timeout = AbortSignal.timeout(SHARED_TEXT_ADMISSION_TIMEOUT_MS);
    const signal = parent ? AbortSignal.any([parent, timeout]) : timeout;
    const previous = tails.get(docId) ?? Promise.resolve();
    const finished = Promise.withResolvers<void>();
    const tail = previous.then(() => finished.promise);
    tails.set(docId, tail);
    try {
      // FIFO on this node prevents its editors racing each other. Other nodes
      // use bounded jittered backoff, rather than synchronized 25 ms polling.
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        void previous.then(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        });
        signal.throwIfAborted();
      });
      const result = await retry({
        signal,
        run: async () =>
          mutex().withLock({ resource: docId, signal }, async () => {
            signal.throwIfAborted();
            return { value: await run(signal) };
          }),
        after: ({ ctx }) => {
          if (ctx.data !== null) return;
          if (ctx.attempt >= 16) throw new ConflictError("Shared text admission is busy; retry the pending input");
          ctx.reschedule({ delayMs: ctx.expBackoff({ baseMs: 25, maxMs: 400, jitter: 0.5 }) });
        },
      });
      if (!result) throw new ConflictError("Shared text admission is busy; retry the pending input");
      return result.value;
    } catch (error) {
      if (timeout.aborted && !parent?.aborted) throw new ConflictError("Shared text admission timed out; retry the pending input");
      throw error;
    } finally {
      finished.resolve();
      void tail.then(() => {
        if (tails.get(docId) === tail) tails.delete(docId);
      });
    }
  };
};
