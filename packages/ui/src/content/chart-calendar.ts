import type { ChartInspectionNavigation } from "./chart-inspection-core";

export const calendarInspectionNavigation: ChartInspectionNavigation = {
  last: true,
  pointer: false,
  keepScroll: true,
  reveal: (element) => element.scrollIntoView({ block: "nearest", inline: "nearest" }),
};

let calendarId = 0;

/** A calendar starts at the newest week. Pointer inspection never resets its scroll position. */
export function mountCalendarScroll(container: HTMLElement): () => void {
  const drawing = container.querySelector(".k2b-chart__svg");
  if (!drawing) return () => {};
  const root = container.getRootNode();
  if (!(root instanceof Document || root instanceof ShadowRoot)) return () => {};
  const originalId = container.id;
  let id = originalId;
  if (!id) {
    do id = `k2b-calendar-scroll-${++calendarId}`;
    while (root.getElementById(id));
    container.id = id;
  }
  // CSSOM measurements are enhancements, not serialized first-render markup.
  // Each calendar has its own rule, including in notebook and app-frame hosts.
  const sheet = new CSSStyleSheet();
  sheet.insertRule(`.k2b-ui #${CSS.escape(id)} {}`);
  const rule = sheet.cssRules[0];
  if (!(rule instanceof CSSStyleRule)) throw new Error("Missing calendar scroll rule.");
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  // row-reverse starts at the newest end on the server too. Use the native
  // range once mounted: CSS query lengths can differ by subpixel rounding.
  const header = () => {
    rule.style.setProperty("--k2b-calendar-measured-overflow", `${Math.max(0, container.scrollWidth - container.clientWidth)}px`);
    rule.style.setProperty("--k2b-calendar-scroll", `${container.scrollLeft}px`);
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
    root.adoptedStyleSheets = root.adoptedStyleSheets.filter((candidate) => candidate !== sheet);
    if (!originalId && container.id === id) container.removeAttribute("id");
  };
}
