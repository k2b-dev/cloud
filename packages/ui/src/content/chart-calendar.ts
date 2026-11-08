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
  // row-reverse makes zero the newest end in the server frame too. Older weeks
  // use negative scrollLeft. Pinning must use this same DOM scroll range:
  // container query widths can differ from the scrollport (gutter/rounding).
  const header = () => {
    container.style.setProperty("--k2b-calendar-measured-overflow", `${Math.max(0, container.scrollWidth - container.clientWidth)}px`);
    if (container.scrollLeft) container.style.setProperty("--k2b-calendar-scroll", `${container.scrollLeft}px`);
    else container.style.removeProperty("--k2b-calendar-scroll");
  };
  const observer = new MutationObserver(() => {
    container.scrollLeft = 0;
    header();
  });
  observer.observe(drawing, { childList: true });
  const resize = new ResizeObserver(header);
  resize.observe(container);
  resize.observe(drawing);
  header();
  container.addEventListener("scroll", header, { passive: true });
  return () => {
    observer.disconnect();
    resize.disconnect();
    container.removeEventListener("scroll", header);
    container.style.removeProperty("--k2b-calendar-measured-overflow");
    container.style.removeProperty("--k2b-calendar-scroll");
  };
}
