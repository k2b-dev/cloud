/** Native credential sheets can resolve before the app becomes visible again. */
export function waitForVaultVisibility(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (document.visibilityState === "visible") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
      signal.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve();
    };
    const visible = () => {
      if (document.visibilityState === "visible") finish();
    };
    const aborted = () => finish(signal.reason);
    // Match the app's one-minute background grace period; never unlock in the background.
    const timer = setTimeout(() => finish(new DOMException("App stayed hidden", "AbortError")), 60_000);
    document.addEventListener("visibilitychange", visible);
    signal.addEventListener("abort", aborted, { once: true });
  });
}
