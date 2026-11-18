/** Bound each stage of an optional page snapshot. Bun SQL queries can cancel; identity readers only race the signal. */
export async function readPageSnapshot<T>(signal: AbortSignal, read: () => PromiseLike<T> & { cancel?: () => void }): Promise<T> {
  signal.throwIfAborted();
  const work = read();
  let aborted: () => void = () => {};
  try {
    return await Promise.race([
      Promise.resolve(work),
      new Promise<never>((_, reject) => {
        aborted = () => {
          work.cancel?.();
          reject(signal.reason);
        };
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", aborted);
  }
}
