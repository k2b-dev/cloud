/**
 * Watches whether workspace chrome has at least `minRem` of app host width.
 * CSS for the same chrome uses `@container k2b-app-area (min-width: …)`.
 * Call with a mounted element; the returned function stops all observation.
 */
export function watchAppHostWidth(element: Element, minRem: number, update: (matches: boolean) => void): () => void {
  const root = document.documentElement;
  const workspace = element.closest(".k2b-app-workspace") ?? element;
  let host: Element | undefined;
  let matches: boolean | undefined;
  let stopped = false;
  const px = (value: string) => Number.parseFloat(value) || 0;
  const check = () => {
    if (stopped) return;
    let ancestor = element.parentElement;
    while (ancestor && !getComputedStyle(ancestor).containerName.split(/\s+/).includes("k2b-app-area")) {
      ancestor = ancestor.parentElement;
    }
    const target = ancestor ?? root;
    if (target !== host) {
      host = target;
      observer?.disconnect();
      for (const observed of new Set([root, host, workspace])) observer?.observe(observed);
    }
    const style = getComputedStyle(target);
    // Container queries measure fractional content-box pixels, before transforms.
    const width =
      px(style.width) -
      (style.boxSizing === "border-box"
        ? px(style.paddingLeft) + px(style.paddingRight) + px(style.borderLeftWidth) + px(style.borderRightWidth)
        : 0);
    const next = width >= minRem * px(getComputedStyle(root).fontSize);
    if (next !== matches) {
      matches = next;
      update(next);
    }
  };
  // A host gains or loses its name together with a width change (Cloud's panel column), which the workspace sees.
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(check);
  if (!observer) window.addEventListener("resize", check);
  check();
  return () => {
    stopped = true;
    observer?.disconnect();
    window.removeEventListener("resize", check);
  };
}
