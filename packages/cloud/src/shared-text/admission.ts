import { ConflictError, type Mutex } from "@k2b/sync";

/** Acquisition and validation share one short budget; CAS fences a stalled owner. */
export const SHARED_TEXT_ADMISSION_TIMEOUT_MS = 5_000;
export const SHARED_TEXT_ADMISSION_LEASE_MS = 10_000;

export type SharedTextAdmission = <T>(
  docId: string,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
) => Promise<T>;

export const createSharedTextAdmission =
  (mutex: () => Pick<Mutex, "withLock">): SharedTextAdmission =>
  async (docId, parent, run) => {
    const timeout = AbortSignal.timeout(SHARED_TEXT_ADMISSION_TIMEOUT_MS);
    const signal = parent ? AbortSignal.any([parent, timeout]) : timeout;
    try {
      const result = await mutex().withLock({ resource: docId, signal }, async () => {
        signal.throwIfAborted();
        const value = await run(signal);
        return { value };
      });
      if (!result) throw new ConflictError("Shared text admission is busy; reconnect and retry");
      return result.value;
    } catch (error) {
      if (timeout.aborted && !parent?.aborted) throw new ConflictError("Shared text admission timed out; reconnect and retry");
      throw error;
    }
  };
