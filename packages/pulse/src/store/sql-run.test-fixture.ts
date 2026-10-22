/** Poll only an observable condition; elapsed durations use a monotonic clock. */
export const waitUntil = async (check: () => Promise<boolean>, timeoutMs = 5000) => {
  const end = performance.now() + timeoutMs;
  while (!(await check())) {
    if (performance.now() >= end) throw new Error("Query process condition not reached before deadline");
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
};
