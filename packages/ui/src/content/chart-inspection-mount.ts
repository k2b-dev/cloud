import type { ChartSelection, ChartTooltipFormatter } from "../charts/core/inspection";
import type { ChartKind } from "../charts/core/types";
import type { ChartCursor } from "./chart-cursor";
import { type ChartInspectionNavigation, closeChartInspectionOnOutside, createChartInspector } from "./chart-inspection-core";

export type InspectChartOptions = {
  kind: ChartKind;
  nav?: ChartInspectionNavigation;
  format: ChartTooltipFormatter;
  select?: (selection: ChartSelection) => void;
  cursor?: ChartCursor;
  locale?: string;
  /** Host for a separately rendered series legend. Defaults to the chart container. */
  legend?: ParentNode;
};
export type ChartInspection = { invalidate(): void; close(): void; destroy(): void };

let tooltipId = 0;

/** Attach inspection to stdlib SVG rendered with inspect: true, without a framework. */
export function inspectChart(container: HTMLElement, options: InspectChartOptions): ChartInspection {
  const document = container.ownerDocument;
  const anchor = document.createElement("span");
  anchor.className = "k2b-chart__anchor";
  anchor.setAttribute("aria-hidden", "true");
  const tooltip = document.createElement("span");
  tooltip.className = "k2b-tooltip k2b-chart__tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.setAttribute("popover", "manual");
  tooltip.setAttribute("data-instant", "true");
  do {
    tooltip.id = `k2b-chart-tooltip-${++tooltipId}`;
  } while (document.getElementById(tooltip.id));
  container.append(anchor, tooltip);
  const addedTabindex = !container.hasAttribute("tabindex");
  if (addedTabindex) container.setAttribute("tabindex", "0");

  const inspector = createChartInspector({
    container: () => container,
    locale: () => options.locale ?? "en",
    legend: () => options.legend,
    cursor: () => options.cursor,
    tooltip: () => tooltip,
    anchor: () => anchor,
    kind: () => options.kind,
    nav: () => options.nav,
    enabled: () => true,
    format: options.format,
    select: (selection) => options.select?.(selection),
  });
  const listen = <K extends keyof HTMLElementEventMap>(name: K, listener: (event: HTMLElementEventMap[K]) => unknown) => {
    container.addEventListener(name, listener);
    return () => container.removeEventListener(name, listener);
  };
  const removeListeners = [
    listen("pointerdown", inspector.down),
    listen("pointerup", inspector.up),
    listen("pointercancel", inspector.up),
    listen("pointermove", inspector.move),
    listen("click", inspector.click),
    listen("pointerleave", inspector.leave),
    listen("focusin", inspector.focus),
    listen("focusout", inspector.close),
    listen("keydown", inspector.key),
  ];
  const removeOutside = closeChartInspectionOnOutside({
    container: () => container,
    tooltip: () => tooltip,
    close: inspector.close,
    keepScroll: () => options.nav?.keepScroll,
  });
  const unlinkCursor = inspector.linkCursor(options.cursor);
  let destroyed = false;
  return {
    invalidate: () => {
      if (!destroyed) inspector.invalidate();
    },
    close: () => {
      if (!destroyed) inspector.close();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const remove of removeListeners) remove();
      removeOutside();
      unlinkCursor();
      inspector.destroy();
      for (const element of container.querySelectorAll<SVGGraphicsElement>("[data-chart-datum]")) {
        element.removeAttribute("data-inspected");
        element.style.removeProperty("--k2b-chart-inspection-color");
        if (!element.getAttribute("style")) element.removeAttribute("style");
      }
      // Inspection geometry the inspector wrote onto the host container.
      for (const name of ["inspection-x", "inspection-y", "plot-left", "plot-right", "plot-top", "plot-bottom"])
        container.style.removeProperty(`--k2b-chart-${name}`);
      anchor.remove();
      tooltip.remove();
      if (addedTabindex) container.removeAttribute("tabindex");
    },
  };
}
