/**
 * Breadcrumbs' collapse (K15), loaded only in the browser: when the path does not fit, hide front levels one by one
 * until the rest fits; the current level never hides. It measures in a frame, after Solid has written the hidden
 * levels, and again whenever the nav's room changes, also when it grows back. Returns `refresh` and `dispose`.
 */
export function observeBreadcrumbs(nav: HTMLElement, list: HTMLElement, levels: () => number, setHidden: (count: number) => void) {
  const fits = () => list.scrollWidth <= list.clientWidth + 0.5;
  let frame = 0;
  const settle = () => {
    let count = 0;
    setHidden(0);
    while (!fits() && count < levels() - 1) setHidden(++count);
    if (fits()) list.scrollLeft = getComputedStyle(list).direction === "rtl" ? -list.scrollWidth : list.scrollWidth;
  };
  const refresh = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(settle);
  };
  const observer = new ResizeObserver(refresh);
  observer.observe(nav);
  return {
    refresh,
    dispose: () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    },
  };
}
