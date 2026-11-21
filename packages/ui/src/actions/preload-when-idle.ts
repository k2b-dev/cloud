/**
 * Runs `load` once the browser is idle, or after 200 ms where it has no idle callback, so code that a gesture needs is
 * there before the first gesture. Returns the cancel.
 */
export const preloadWhenIdle = (win: Window, load: () => void): (() => void) => {
  if (typeof win.requestIdleCallback === "function") {
    const idle = win.requestIdleCallback(load, { timeout: 2000 });
    return () => win.cancelIdleCallback(idle);
  }
  const timer = win.setTimeout(load, 200);
  return () => win.clearTimeout(timer);
};
