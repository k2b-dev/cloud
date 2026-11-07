import type { ChartInspectionNavigation } from "./chart-inspection-core";

export const calendarInspectionNavigation: ChartInspectionNavigation = {
  last: true,
  pointer: false,
  keepScroll: true,
  reveal: (element) => element.scrollIntoView({ block: "nearest", inline: "nearest" }),
};

/** A calendar starts at the newest week. Pointer inspection never resets its scroll position. */
export function mountCalendarScroll(container: HTMLElement): () => void {
  const drawing = container.querySelector(".k2b-chart__svg");
  if (!drawing) return () => {};
  const header = () => {
    const svg = drawing.querySelector<SVGSVGElement>("svg[data-calendar]");
    if (!svg) return;
    container.style.setProperty("--k2b-calendar-header-x", `${container.scrollLeft / (svg.getScreenCTM()?.a || 1)}px`);
  };
  let previousEnd = 0;
  const reset = () => {
    if (!drawing.querySelector("svg[data-calendar]")) return;
    container.scrollLeft = container.scrollWidth;
    previousEnd = container.scrollWidth - container.clientWidth;
    header();
  };
  reset();
  const observer = new MutationObserver(reset);
  observer.observe(drawing, { childList: true });
  // Keep the newest week visible across responsive resizes, while preserving
  // an intentionally older scroll position whenever it still fits.
  const resize = new ResizeObserver(() => {
    if (container.scrollLeft >= previousEnd - 1) container.scrollLeft = container.scrollWidth;
    previousEnd = container.scrollWidth - container.clientWidth;
    header();
  });
  resize.observe(container);
  container.addEventListener("scroll", header, { passive: true });
  return () => {
    observer.disconnect();
    resize.disconnect();
    container.removeEventListener("scroll", header);
  };
}
