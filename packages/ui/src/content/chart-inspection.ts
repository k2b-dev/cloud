import type { ChartDatum } from "@k2b/stdlib";
import { positionTooltipSurface } from "../feedback/tooltip-position";
import type { ChartKind } from "./Chart";

export type ChartDatumRef = Pick<ChartDatum, "role" | "index" | "seriesIndex">;
export const sameChartDatum = (a: ChartDatumRef, b: ChartDatumRef) => a.role === b.role && a.index === b.index && a.seriesIndex === b.seriesIndex;

export type ChartSelection = { kind: ChartKind; datum: ChartDatum };
export type ChartTooltip = { title?: string; rows: readonly { label: string; value: string }[] };
export type ChartTooltipFormatter = (selection: ChartSelection) => ChartTooltip;

type Entry = { element: SVGGraphicsElement; datum: ChartDatum };
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const pair = (value: unknown): value is [number, number] =>
  Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === "number" && Number.isFinite(n));
const roles = new Set(["point", "item", "bin", "box", "outlier", "value", "cell", "interval"]);
export function isChartDatum(value: unknown): value is ChartDatum {
  return (
    object(value) &&
    Number.isInteger(value.index) &&
    typeof value.index === "number" &&
    value.index >= 0 &&
    (value.seriesIndex === undefined ||
      (typeof value.seriesIndex === "number" && Number.isInteger(value.seriesIndex) && value.seriesIndex >= 0)) &&
    typeof value.role === "string" &&
    roles.has(value.role) &&
    pair(value.anchor) &&
    (value.grid === undefined || pair(value.grid)) &&
    (value.label === undefined || typeof value.label === "string") &&
    Array.isArray(value.values) &&
    value.values.every(
      (field) =>
        object(field) &&
        typeof field.key === "string" &&
        (typeof field.value === "string" || (typeof field.value === "number" && Number.isFinite(field.value))) &&
        (field.formatted === undefined || typeof field.formatted === "string"),
    )
  );
}

/** Enhances existing SVG nodes. Pointer/focus changes never rebuild the chart. */
export function createChartInspection(options: {
  container: () => HTMLDivElement | undefined;
  tooltip: () => HTMLSpanElement | undefined;
  anchor: () => HTMLSpanElement | undefined;
  kind: () => ChartKind;
  enabled: () => boolean;
  format: ChartTooltipFormatter;
  select: (selection: ChartSelection) => void;
}) {
  let entries: Entry[] | undefined;
  let sortedPoints: Entry[] = [];
  const byElement = new Map<Element, Entry>();
  let active: Entry | undefined;
  let highlighted: Entry[] = [];
  let pinned = false;
  let pointerStart: { x: number; y: number } | undefined;
  let moved = false;
  let pending: { x: number; y: number; target: Element | null } | undefined;
  let frame: number | undefined;

  const records = () => {
    if (!entries || (entries.length > 0 && !entries[0]!.element.isConnected)) {
      entries = [];
      byElement.clear();
      sortedPoints = [];
      for (const element of Array.from(options.container()?.querySelectorAll<SVGGraphicsElement>("[data-chart-datum]") ?? [])) {
        try {
          const value: unknown = JSON.parse(element.getAttribute("data-chart-datum") ?? "null");
          if (isChartDatum(value)) {
            const entry = { element, datum: value };
            entries.push(entry);
            byElement.set(element, entry);
          }
        } catch {
          /* Only valid renderer metadata participates in inspection. */
        }
      }
      sortedPoints = entries.filter((entry) => entry.datum.role === "point").sort((a, b) => a.datum.anchor[0] - b.datum.anchor[0]);
    }
    return entries;
  };
  const highlightColor = (item: Entry): string => {
      // Read the actual paint before applying inspection styles, including
      // custom series and threshold colors. Invisible points use their line.
      const point = item.element.querySelector(".stdlib-chart-inspection-point");
      const source = point
        ? options.container()?.querySelector(options.kind() === "line"
            ? `.stdlib-chart-line.stdlib-chart-series-${(item.datum.seriesIndex ?? 0) % 8}`
            : ".stdlib-chart-sparkline, .stdlib-chart-stat-sparkline")
        : item.element.querySelector(".stdlib-chart-bar-gauge-fill, .stdlib-chart-gauge-fill, .stdlib-chart-stat-value")
          ?? item.element.querySelector("rect, path, circle");
      const paint = source ? source.ownerDocument.defaultView?.getComputedStyle(source) : undefined;
      const color = (point ? paint?.stroke : paint?.fill) || `var(--stdlib-chart-c${(item.datum.seriesIndex ?? 0) % 8 + 1})`;
      return `color-mix(in srgb, ${color} 72%, var(--k2b-chart-highlight-mix))`;
  };
  const selectDatum = (selected: ChartDatumRef | null | undefined) => {
    for (const entry of records()) {
      const matches = selected != null && sameChartDatum(selected, entry.datum);
      if (matches) entry.element.style.setProperty("--k2b-chart-selection-color", highlightColor(entry));
      else entry.element.style.removeProperty("--k2b-chart-selection-color");
      entry.element.toggleAttribute("data-selected", matches);
    }
  };
  const screenPoint = (entry: Entry) => {
    const matrix = entry.element.getScreenCTM?.();
    const [x, y] = entry.datum.anchor;
    if (matrix) return { x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f };
    const rect = entry.element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  };
  const rawX = (entry: Entry) => entry.datum.values.find((field) => field.key === "x")?.value;
  const seriesChart = () => options.kind() === "line" || options.kind() === "sparkline";
  const clearHighlight = () => {
    for (const entry of highlighted) {
      entry.element.removeAttribute("data-inspected");
      entry.element.style.removeProperty("--k2b-chart-inspection-color");
      if (!entry.element.getAttribute("style")) entry.element.removeAttribute("style");
    }
    highlighted = [];
  };
  const close = () => {
    pinned = false;
    active = undefined;
    clearHighlight();
    options.container()?.removeAttribute("aria-describedby");
    options.container()?.removeAttribute("data-inspecting");
    const tooltip = options.tooltip();
    if (tooltip) {
      try {
        if (tooltip.matches(":popover-open")) tooltip.hidePopover();
      } catch {
        /* Detached during navigation. */
      }
    }
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    pending = undefined;
  };
  const invalidate = () => {
    close();
    entries = undefined;
    sortedPoints = [];
    byElement.clear();
  };
  const show = (entry: Entry) => {
    const tooltip = options.tooltip(),
      anchor = options.anchor(),
      container = options.container();
    if (!tooltip || !anchor || !container || !options.enabled()) return;
    if (active === entry && tooltip.matches(":popover-open")) return;
    clearHighlight();
    active = entry;
    highlighted = options.kind() === "line" ? records().filter((candidate) => rawX(candidate) === rawX(entry)) : [entry];
    for (const item of highlighted) {
      item.element.style.setProperty("--k2b-chart-inspection-color", highlightColor(item));
      item.element.setAttribute("data-inspected", "true");
    }
    const contents = highlighted.map((item) => options.format({ kind: options.kind(), datum: item.datum }));
    tooltip.textContent = contents
      .map((content) => [content.title, ...content.rows.map((row) => `${row.label}: ${row.value}`)].filter(Boolean).join("\n"))
      .join("\n\n");
    const rect = container.getBoundingClientRect(),
      point = screenPoint(entry);
    anchor.style.left = `${point.x - rect.left}px`;
    anchor.style.top = `${point.y - rect.top}px`;
    container.style.setProperty("--k2b-chart-inspection-x", `${point.x - rect.left}px`);
    container.setAttribute("data-inspecting", seriesChart() ? "series" : "datum");
    container.setAttribute("aria-describedby", tooltip.id);
    try {
      if (!tooltip.matches(":popover-open")) tooltip.showPopover();
      positionTooltipSurface(tooltip, anchor);
    } catch {
      /* SVG titles remain available without the Popover API. */
    }
  };
  const nearest = (x: number, y: number, target: Element | null): Entry | undefined => {
    if (target?.closest("button,a") && !target.closest("[data-chart-datum]")) return;
    const nodes = records();
    const direct = target?.closest("[data-chart-datum]");
    const hit = direct ? byElement.get(direct) : undefined;
    if (hit) return hit;
    // Exact shapes win. A small physical hit radius also reaches tiny or
    // zero-sized marks; distant whitespace leaves the chart unselected.
    const points = seriesChart() ? sortedPoints : nodes;
    if (seriesChart() && points.length) {
      const matrix = points[0]!.element.getScreenCTM?.();
      if (matrix) {
        const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
        if (!determinant) return;
        const targetX = ((x - matrix.e) * matrix.d - (y - matrix.f) * matrix.c) / determinant;
        let low = 0,
          high = points.length - 1;
        while (low < high) {
          const mid = Math.floor((low + high) / 2);
          if (points[mid]!.datum.anchor[0] < targetX) low = mid + 1;
          else high = mid;
        }
        const previous = Math.max(0, low - 1);
        return Math.abs(points[previous]!.datum.anchor[0] - targetX) <= Math.abs(points[low]!.datum.anchor[0] - targetX)
          ? points[previous]
          : points[low];
      }
    }
    const matrices = new Map<SVGSVGElement, DOMMatrix | null>();
    let best: Entry | undefined,
      distance = Infinity;
    for (const entry of points) {
      const svg = entry.element.ownerSVGElement;
      if (svg && !matrices.has(svg)) matrices.set(svg, svg.getScreenCTM?.() ?? null);
      const matrix = svg ? matrices.get(svg) : null;
      const [ax, ay] = entry.datum.anchor;
      const point = matrix
        ? { x: matrix.a * ax + matrix.c * ay + matrix.e, y: matrix.b * ax + matrix.d * ay + matrix.f }
        : screenPoint(entry);
      const dx = point.x - x,
        dy = point.y - y;
      const next = seriesChart() ? Math.abs(dx) : Math.hypot(dx, dy);
      if (next < distance) {
        distance = next;
        best = entry;
      }
    }
    return seriesChart() || distance <= 24 ? best : undefined;
  };
  const move = (event: PointerEvent) => {
    if (event.target instanceof Node && options.tooltip()?.contains(event.target)) return;
    if (pointerStart && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 6) moved = true;
    if (!options.enabled() || pinned || event.pointerType === "touch" || event.buttons) return;
    pending = { x: event.clientX, y: event.clientY, target: event.target instanceof Element ? event.target : null };
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      const sample = pending;
      pending = undefined;
      if (!sample) return;
      const entry = nearest(sample.x, sample.y, sample.target);
      if (entry) show(entry);
      else close();
    });
  };
  const down = (event: PointerEvent) => {
    pointerStart = { x: event.clientX, y: event.clientY };
    moved = false;
  };
  const click = (event: MouseEvent) => {
    if (!options.enabled() || moved || (event.target instanceof Element && event.target.closest("button,a"))) return;
    const entry = nearest(event.clientX, event.clientY, event.target instanceof Element ? event.target : null);
    if (!entry) {
      close();
      return;
    }
    pinned = true;
    show(entry);
    options.select({ kind: options.kind(), datum: entry.datum });
  };
  const focus = (event: FocusEvent) => {
    if (event.target !== options.container() || !options.enabled()) return;
    const nodes = records();
    const first = options.kind() === "line" ? sortedPoints.at(-1) : nodes[0];
    if (first) show(first);
  };
  const key = (event: KeyboardEvent): boolean => {
    if (!options.enabled() || event.target !== options.container()) return false;
    if (event.key === "Escape") {
      close();
      return true;
    }
    if (event.key === "Enter" && active) {
      event.preventDefault();
      pinned = true;
      const link = active.element.closest("a");
      if (link) link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      else options.select({ kind: options.kind(), datum: active.datum });
      return true;
    }
    const navigationChart = options.kind() === "map" || options.kind() === "stateTimeline";
    if (navigationChart && !event.altKey) return false;
    if (!["Home", "End", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return false;
    let nodes = records();
    if (seriesChart()) nodes = [...nodes].sort((a, b) => a.datum.anchor[0] - b.datum.anchor[0]);
    if (options.kind() === "line") {
      const seen = new Set<string | number | undefined>();
      nodes = nodes.filter((entry) => {
        const x = rawX(entry);
        if (seen.has(x)) return false;
        seen.add(x);
        return true;
      });
    }
    if (!nodes.length) return false;
    event.preventDefault();
    pinned = false;
    let index = active
      ? options.kind() === "line"
        ? nodes.findIndex((entry) => rawX(entry) === rawX(active!))
        : nodes.indexOf(active)
      : -1;
    if (event.key === "Home") index = 0;
    else if (event.key === "End") index = nodes.length - 1;
    else if (active?.datum.grid && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      const [x, y] = active.datum.grid;
      const dx = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      const dy = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
      const next = nodes
        .filter(
          (entry) =>
            entry.datum.grid &&
            (dx
              ? entry.datum.grid[1] === y && (entry.datum.grid[0] - x) * dx > 0
              : entry.datum.grid[0] === x && (entry.datum.grid[1] - y) * dy > 0),
        )
        .sort(
          (a, b) =>
            Math.abs(a.datum.grid![0] - x) +
            Math.abs(a.datum.grid![1] - y) -
            Math.abs(b.datum.grid![0] - x) -
            Math.abs(b.datum.grid![1] - y),
        )[0];
      if (next) index = nodes.indexOf(next);
    } else index += event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    show(nodes[Math.max(0, Math.min(nodes.length - 1, index))]!);
    return true;
  };
  return {
    selectDatum,
    move,
    down,
    click,
    focus,
    key,
    close,
    invalidate,
    leave: () => {
      if (!pinned) close();
    },
  };
}
