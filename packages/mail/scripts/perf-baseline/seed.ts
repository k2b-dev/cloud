import type { SQL } from "bun";

/** Closing the run-owned observer interrupts an in-flight seed query and rolls back its transaction. */
export async function seedWithAbort<T>(db: Pick<SQL, "close">, signal: AbortSignal, seed: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let closing: Promise<void> | undefined;
  const abort = () => {
    closing = db.close({ timeout: 0 });
    // Attach immediately; the finally block awaits and reports any close failure.
    void closing.catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const result = await seed();
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", abort);
    await closing;
  }
}
