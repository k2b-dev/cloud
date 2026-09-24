/**
 * Default window in which a second automatic reload for the same key is
 * suppressed. A page load, hydration, and the first live subscription finish
 * within a few seconds, so a condition that fails again right after a reload
 * lands well inside it; a genuinely new change minutes later still reloads.
 */
export const AUTOMATIC_RELOAD_WINDOW_MS = 30_000;

const storageKey = (key: string) => `cloud.reload.${key}`;

/**
 * Reloads the page for an automatic reason (a live event, a failed live
 * subscription, a changed view) at most once per `key` and window in this tab.
 *
 * Returns `false` without reloading when the same key already reloaded within
 * the window, or when `sessionStorage` is unavailable and a repeat therefore
 * cannot be ruled out. The caller then keeps the page usable and offers a
 * user-initiated reload instead. Reloads after an explicit user action do not
 * need this guard.
 */
export const reloadOnce = (key: string, options: { windowMs?: number } = {}): boolean => {
  const windowMs = options.windowMs ?? AUTOMATIC_RELOAD_WINDOW_MS;
  const now = Date.now();
  try {
    const storage = window.sessionStorage;
    const last = Number(storage.getItem(storageKey(key)));
    if (last > 0 && now >= last && now - last < windowMs) return false;
    storage.setItem(storageKey(key), String(now));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
};
