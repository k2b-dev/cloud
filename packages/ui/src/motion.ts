/**
 * True when the person asked for less motion: through the operating system's
 * setting or through `data-k2b-motion="reduced"` on `<html>`. Both are read at
 * call time, so a change applies to the next call; on the server it is false.
 */
export const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  (window.document.documentElement.getAttribute("data-k2b-motion") === "reduced" ||
    (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches));
