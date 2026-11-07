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
    const scale = 1 / (svg.getScreenCTM()?.a || 1);
    container.style.setProperty("--k2b-calendar-header-x", `${container.scrollLeft * scale}px`);
    for (const label of svg.querySelectorAll<SVGTextElement>("[data-calendar-month]")) {
      // A month name is useful whole; hide a fragment behind the fixed weekday rail.
      container.style.setProperty(
        `--k2b-calendar-month-${label.dataset.calendarMonth}`,
        label.x.baseVal[0]!.value < container.scrollLeft * scale + 32 ? "hidden" : "visible",
      );
    }
  };
  let previousEnd = container.scrollWidth - container.clientWidth;
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
