import type { ChartDatum, ChartKind } from "../charts/core/types";
import { positionTooltipSurface } from "../feedback/tooltip-position";
import type { ChartCursor, ChartCursorState } from "./chart-cursor";

export {
  type ChartDatumRef,
  type ChartSelection,
  type ChartTooltip,
  type ChartTooltipFormatter,
  isChartDatum,
  sameChartDatum,
} from "../charts/core/inspection";
export type { ChartKind } from "../charts/core/types";

import {
  type ChartDatumRef,
  type ChartSelection,
  type ChartTooltipFormatter,
  isChartDatum,
  sameChartDatum,
} from "../charts/core/inspection";

/** Host policy for inspecting an overflowing drawing. */
export type ChartInspectionNavigation = {
  last?: boolean;
  pointer?: boolean;
  reveal?: (element: SVGGraphicsElement) => void;
  keepScroll?: boolean;
};

type Entry = { element: SVGGraphicsElement; datum: ChartDatum };

/** Adds or removes only the tooltip id, keeping descriptions the host put on the container. */
const describe = (container: HTMLElement, id: string, on: boolean) => {
  const ids = (container.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((token) => token && token !== id);
  if (on) ids.push(id);
  if (ids.length) container.setAttribute("aria-describedby", ids.join(" "));
  else container.removeAttribute("aria-describedby");
};

/** Mark roles that stand for a whole category: hovering anywhere in its column (or row) inspects it. */
const rowLayout = (container: HTMLElement | undefined) => Boolean(container?.querySelector('svg[data-bar-layout="rows"]'));
const categoryRoles: Partial<Record<ChartKind, string>> = { bar: "item", histogram: "bin", boxplot: "box" };
type CategoryBand = { entry: Entry; left: number; right: number; top: number; bottom: number };

/** Enhances existing SVG nodes. Pointer/focus changes never rebuild the chart. */
export function createChartInspector(options: {
  container: () => HTMLElement | undefined;
  cursor?: () => ChartCursor | undefined;
  tooltip: () => HTMLSpanElement | undefined;
  anchor: () => HTMLSpanElement | undefined;
  kind: () => ChartKind;
  enabled: () => boolean;
  /** Locale for unformatted values in an attached series legend. */
  locale?: () => string;
  /** Legend host when it is outside the inspected SVG container. */
  legend?: () => ParentNode | undefined;
  format: ChartTooltipFormatter;
  select: (selection: ChartSelection) => void;
  nav?: () => ChartInspectionNavigation | undefined;
}) {
  const source = Symbol("chart cursor");
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
  // The cursor this chart is subscribed to. Closing reads it instead of the cursor prop: a chart also closes
  // while it unmounts, when a parent `<Show>` may already have dropped the value the prop came from.
  let linkedCursor: ChartCursor | undefined;

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
      ? options
          .container()
          ?.querySelector(
            options.kind() === "line"
              ? `.stdlib-chart-line.stdlib-chart-series-${(item.datum.seriesIndex ?? 0) % 8}`
              : ".stdlib-chart-sparkline, .stdlib-chart-stat-sparkline",
          )
      : (item.element.querySelector(".stdlib-chart-bar-gauge-fill, .stdlib-chart-gauge-fill, .stdlib-chart-stat-value") ??
        item.element.querySelector(":is(rect, path, circle):not(.k2b-chart-category-band)"));
    const paint = source ? source.ownerDocument.defaultView?.getComputedStyle(source) : undefined;
    const color =
      (point || item.element.hasAttribute("data-chart-reference") ? paint?.stroke : paint?.fill) ||
      `var(--stdlib-chart-c${((item.datum.seriesIndex ?? 0) % 8) + 1})`;
    return `color-mix(in srgb, ${color} 72%, var(--k2b-chart-highlight-mix))`;
  };
  const selectData = (selected: readonly ChartDatumRef[]) => {
    for (const entry of records()) {
      const matches = selected.some((datum) => sameChartDatum(datum, entry.datum));
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
  const visibleRecords = () => {
    const nodes = records();
    if (options.kind() !== "map") return nodes;
    const viewport = options.container()?.querySelector<SVGSVGElement>(".stdlib-chart-map-viewport");
    if (!viewport?.getScreenCTM?.()) return nodes;
    const root = viewport.ownerSVGElement?.getBoundingClientRect();
    if (!root?.width || !root.height) return nodes;
    const width = viewport?.width?.baseVal.value;
    const height = viewport?.height?.baseVal.value;
    if (!width || !height) return nodes;
    const left = root.left + viewport.x.baseVal.value;
    const top = root.top + viewport.y.baseVal.value;
    const clip = { left, top, right: left + width, bottom: top + height };
    return nodes.filter((entry) => {
      const point = screenPoint(entry);
      return point.x >= clip.left && point.x <= clip.right && point.y >= clip.top && point.y <= clip.bottom;
    });
  };
  const rawX = (entry: Entry) => entry.datum.values.find((field) => field.key === "x")?.value;
  const category = (entry: Entry) => (options.kind() === "area" ? entry.datum.index : rawX(entry));
  const seriesChart = () => options.kind() === "line" || options.kind() === "area" || options.kind() === "sparkline";
  const updateLegend = (items: Entry[] | undefined) => {
    const root = options.legend?.() ?? options.container();
    for (const node of root?.querySelectorAll<HTMLElement | SVGElement>("[data-chart-legend-value]") ?? []) {
      if (!items) {
        node.textContent = node.getAttribute("data-default") ?? "";
        continue;
      }
      const series = Number(node.getAttribute("data-series-index"));
      const field = items
        .find((item) => item.datum.seriesIndex === series)
        ?.datum.values.find((field) => field.key === node.getAttribute("data-field"));
      node.textContent = field
        ? (field.formatted ??
          (typeof field.value === "number"
            ? new Intl.NumberFormat(options.locale?.() ?? "en", { maximumFractionDigits: 6 }).format(field.value)
            : field.value))
        : "—";
    }
  };
  const clearHighlight = () => {
    for (const entry of highlighted) {
      entry.element.removeAttribute("data-inspected");
      entry.element.style.removeProperty("--k2b-chart-inspection-color");
      if (!entry.element.getAttribute("style")) entry.element.removeAttribute("style");
    }
    highlighted = [];
  };
  /** The open tooltip came from keyboard focus or keys, not from a pointer: it follows its mark when the page scrolls. */
  let byKeyboard = false;
  const close = (broadcast = true, cancelPending = true) => {
    const state = linkedCursor?.read();
    if (broadcast && state && state.source !== source) return;
    if (broadcast) linkedCursor?.clear(source);
    byKeyboard = false;
    options.container()?.removeAttribute("data-cursor-source");
    pinned = false;
    active = undefined;
    updateLegend(undefined);
    clearHighlight();
    const container = options.container(),
      id = options.tooltip()?.id;
    if (container && id) describe(container, id, false);
    options.container()?.removeAttribute("data-inspecting");
    const inspected = options.container();
    if (inspected) {
      for (const name of ["left", "top", "width", "height"]) inspected.style.removeProperty(`--k2b-chart-band-${name}`);
      if (!inspected.getAttribute("style")) inspected.removeAttribute("style");
    }
    const tooltip = options.tooltip();
    if (tooltip) {
      try {
        if (tooltip.matches(":popover-open")) tooltip.hidePopover();
      } catch {
        /* Detached during navigation. */
      }
    }
    if (cancelPending) {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      pending = undefined;
    }
  };
  const invalidate = () => {
    options.cursor?.()?.clear(source);
    close(false);
    entries = undefined;
    sortedPoints = [];
    byElement.clear();
    receive(options.cursor?.()?.read() ?? null);
  };
  const show = (entry: Entry, broadcast = true) => {
    const x = rawX(entry);
    if (broadcast && options.kind() === "line" && typeof x === "number") options.cursor?.()?.move(source, x);
    const tooltip = options.tooltip(),
      anchor = options.anchor(),
      container = options.container();
    if (!tooltip || !anchor || !container || !options.enabled()) return;
    if ((active === entry || (seriesChart() && active && category(active) === category(entry))) && tooltip.matches(":popover-open")) return;
    clearHighlight();
    active = entry;
    highlighted =
      options.kind() === "line" || options.kind() === "area"
        ? records().filter((candidate) => category(candidate) === category(entry))
        : [entry];
    for (const item of highlighted) {
      item.element.style.setProperty("--k2b-chart-inspection-color", highlightColor(item));
      item.element.setAttribute("data-inspected", "true");
    }
    updateLegend(highlighted);
    const document = tooltip.ownerDocument;
    const contents = highlighted.map((item) => ({
      item,
      content: options.format({ kind: options.kind(), datum: item.datum }),
      missing: false,
    }));
    if (options.cursor?.() && options.kind() === "line") {
      const present = new Set(highlighted.map((item) => item.datum.seriesIndex));
      for (const item of records()) {
        if (present.has(item.datum.seriesIndex)) continue;
        present.add(item.datum.seriesIndex);
        contents.push({ item, content: options.format({ kind: options.kind(), datum: item.datum }), missing: true });
      }
      contents.sort((a, b) => (a.item.datum.seriesIndex ?? 0) - (b.item.datum.seriesIndex ?? 0));
    }
    if (options.kind() === "area") contents.reverse();
    tooltip.replaceChildren();
    const sharedTitle = typeof x === "number" ? options.cursor?.()?.formatX?.(x) : undefined;
    const commonTitle =
      sharedTitle ??
      (contents.every(({ content }) => content.title === contents[0]?.content.title) ? contents[0]?.content.title : undefined);
    if (commonTitle) {
      const title = document.createElement("strong");
      title.className = "k2b-chart__tooltip-title";
      title.textContent = commonTitle;
      tooltip.append(title);
    }
    for (const { item, content, missing } of contents) {
      if (content.title && !commonTitle) {
        const title = document.createElement("strong");
        title.className = "k2b-chart__tooltip-title";
        title.textContent = content.title;
        tooltip.append(title);
      }
      for (const row of content.rows) {
        const line = document.createElement("span");
        line.className = "k2b-chart__tooltip-row";
        if (options.kind() === "line" || options.kind() === "area") {
          const swatch = document.createElement("i");
          swatch.setAttribute("aria-hidden", "true");
          const series = container.querySelector(
            `.stdlib-chart-line.stdlib-chart-series-${(item.datum.seriesIndex ?? 0) % 8}, .k2b-area-edge-${(item.datum.seriesIndex ?? 0) % 8}`,
          );
          swatch.style.background = series
            ? getComputedStyle(series).stroke
            : `var(--stdlib-chart-c${((item.datum.seriesIndex ?? 0) % 8) + 1})`;
          line.append(swatch);
        }
        const label = document.createElement("span");
        label.textContent = `${row.label}: `;
        const value = document.createElement("b");
        value.textContent = missing ? "—" : row.value;
        line.append(label, value);
        tooltip.append(line);
      }
    }
    if (options.kind() === "area") {
      const total = entry.datum.values.find((field) => field.key === "total");
      const totalLabel = container.querySelector("svg[data-chart-total-label]")?.getAttribute("data-chart-total-label");
      if (total && totalLabel) {
        const line = document.createElement("span");
        line.className = "k2b-chart__tooltip-row";
        const label = document.createElement("span");
        label.textContent = `${totalLabel}: `;
        const value = document.createElement("b");
        value.textContent = total.formatted ?? String(total.value);
        line.append(label, value);
        tooltip.append(line);
      }
    }
    const rect = container.getBoundingClientRect(),
      point = screenPoint(entry);
    const slot = categoryBands().find((candidate) => candidate.entry === entry);
    // A renderer that draws its own band inside the category's mark keeps it; the overlay only fills the others.
    const band = slot && !entry.element.querySelector(".k2b-chart-category-band") ? slot : undefined;
    const rows = rowLayout(container);
    // A column's tooltip waits at the top of the plot, so it stays put while the pointer moves within the column.
    anchor.style.left = `${(slot && !rows ? (slot.left + slot.right) / 2 : point.x) - rect.left + container.scrollLeft}px`;
    anchor.style.top = `${(slot && !rows ? slot.top : point.y) - rect.top + container.scrollTop}px`;
    updatePlotBounds();
    container.style.setProperty("--k2b-chart-inspection-x", `${point.x - rect.left + container.scrollLeft}px`);
    if (band) {
      container.style.setProperty("--k2b-chart-band-left", `${band.left - rect.left + container.scrollLeft}px`);
      container.style.setProperty("--k2b-chart-band-top", `${band.top - rect.top + container.scrollTop}px`);
      container.style.setProperty("--k2b-chart-band-width", `${band.right - band.left}px`);
      container.style.setProperty("--k2b-chart-band-height", `${band.bottom - band.top}px`);
    }
    container.setAttribute("data-inspecting", seriesChart() ? "series" : band ? "category" : "datum");

    describe(container, tooltip.id, true);
    try {
      if (!tooltip.matches(":popover-open")) tooltip.showPopover();
      positionTooltipSurface(tooltip, anchor);
    } catch {
      /* SVG titles remain available without the Popover API. */
    }
  };
  /**
   * The screen slot of every category, halfway to its neighbours. A light band fills the inspected slot instead of
   * dimming other marks or outlining a bar, and the pointer anywhere in a slot keeps the same category.
   */
  const categoryBands = (): CategoryBand[] => {
    const role = categoryRoles[options.kind()];
    const container = options.container();
    if (!role || !container) return [];
    const rows = rowLayout(container);
    const slots = records()
      .filter((entry) => entry.datum.role === role)
      .map((entry) => ({ entry, rect: entry.element.getBoundingClientRect() }));
    if (!slots.length) return [];
    const guides = Array.from(container.querySelectorAll(".stdlib-chart-grid, .stdlib-chart-axis")).map((node) =>
      node.getBoundingClientRect(),
    );
    // The band spans the plot across the categories: grid lines and every mark, so rows without value ticks, whose
    // only guide is one vertical baseline, still get a band from the baseline to the longest bar.
    const spans = [...guides, ...slots.map((slot) => slot.rect)];
    const start = Math.min(...spans.map((rect) => (rows ? rect.left : rect.top)));
    const end = Math.max(...spans.map((rect) => (rows ? rect.right : rect.bottom)));
    const center = (rect: DOMRect) => (rows ? rect.top + rect.height / 2 : rect.left + rect.width / 2);
    slots.sort((a, b) => center(a.rect) - center(b.rect));
    return slots.map((slot, index) => {
      const middle = center(slot.rect);
      const previous = slots[index - 1],
        next = slots[index + 1];
      const half =
        previous || next ? Math.abs(center((next ?? previous)!.rect) - middle) / 2 : (rows ? slot.rect.height : slot.rect.width) * 0.75;
      const low = previous ? (center(previous.rect) + middle) / 2 : middle - half;
      const high = next ? (center(next.rect) + middle) / 2 : middle + half;
      return rows
        ? { entry: slot.entry, left: start, right: end, top: low, bottom: high }
        : { entry: slot.entry, left: low, right: high, top: start, bottom: end };
    });
  };
  const updatePlotBounds = () => {
    const container = options.container();
    if (!container) return;
    const axes = Array.from(container.querySelectorAll(".stdlib-chart-axis")).map((axis) => axis.getBoundingClientRect());
    if (axes.length < 2) return;
    const left = Math.min(...axes.map((a) => a.left)),
      right = Math.max(...axes.map((a) => a.right));
    const top = Math.min(...axes.map((a) => a.top)),
      bottom = Math.max(...axes.map((a) => a.bottom));
    if (right <= left || bottom <= top) return;
    const rect = container.getBoundingClientRect();
    for (const [name, value] of Object.entries({
      left: left - rect.left,
      right: rect.right - right,
      top: top - rect.top,
      bottom: rect.bottom - bottom,
    }))
      container.style.setProperty(`--k2b-chart-plot-${name}`, `${value}px`);
    return { left, right, top, bottom };
  };
  const receive = (state: ChartCursorState) => {
    if (state?.source === source) return;
    close(false, false);
    if (!state || options.kind() !== "line") return;
    const entry = records().find((item) => rawX(item) === state.x);
    if (entry) show(entry, false);
  };
  const linkCursor = (cursor: ChartCursor | undefined): (() => void) => {
    linkedCursor = cursor;
    const unsubscribe = cursor?.subscribe(receive);
    return () => {
      unsubscribe?.();
      cursor?.clear(source);
      linkedCursor = undefined;
    };
  };
  const nearest = (x: number, y: number, target: Element | null): Entry | undefined => {
    if (target?.closest("button,a") && !target.closest("[data-chart-datum]")) return;
    const nodes = visibleRecords();
    // A mark wins before the plot bounds: the first and last points of a line sit on the plot's edges, so half of
    // their hit area lies outside it.
    const direct = target?.closest("[data-chart-datum]");
    const hit = direct ? byElement.get(direct) : undefined;
    if (hit && nodes.includes(hit)) return hit;
    const bands = categoryBands();
    if (bands.length) {
      // Marks of their own inside a category, such as box-plot outliers, keep their forgiving hit radius.
      const role = categoryRoles[options.kind()];
      let loose: Entry | undefined,
        gap = 24;
      for (const entry of nodes) {
        if (entry.datum.role === role) continue;
        const point = screenPoint(entry);
        const distance = Math.hypot(point.x - x, point.y - y);
        if (distance <= gap) {
          gap = distance;
          loose = entry;
        }
      }
      if (loose) return loose;
      const rows = rowLayout(options.container());
      const frame = options.container()?.getBoundingClientRect();
      const inside = frame && x >= frame.left && x <= frame.right && y >= frame.top && y <= frame.bottom;
      return inside
        ? bands.find((band) => (rows ? y >= band.top && y <= band.bottom : x >= band.left && x <= band.right))?.entry
        : undefined;
    }
    if (seriesChart()) {
      const plot = updatePlotBounds();
      // SVG transforms and DOM rectangles can round the same painted edge
      // differently. Keep its half-pixel raster fringe inspectable.
      const edgeTolerance = 0.5;
      if (
        plot &&
        (x < plot.left - edgeTolerance || x > plot.right + edgeTolerance || y < plot.top - edgeTolerance || y > plot.bottom + edgeTolerance)
      )
        return;
    }
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
      if (entry) {
        byKeyboard = false;
        show(entry);
        if (seriesChart()) {
          const container = options.container();
          container?.setAttribute("data-cursor-source", "true");
          container?.style.setProperty("--k2b-chart-inspection-y", `${sample.y - container.getBoundingClientRect().top}px`);
        }
      } else close();
    });
  };
  let pointerFocusing = false;
  const down = (event: PointerEvent) => {
    pointerFocusing = true;
    byKeyboard = false;
    pointerStart = { x: event.clientX, y: event.clientY };
    moved = false;
  };
  const up = () => {
    pointerFocusing = false;
  };
  const click = (event: MouseEvent) => {
    pointerFocusing = false;
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
    if (pointerFocusing && options.nav?.()?.pointer === false) {
      pointerFocusing = false;
      return;
    }
    const fromPointer = pointerFocusing;
    const nodes = visibleRecords();
    const first = options.nav?.()?.last ? nodes.at(-1) : options.kind() === "line" ? sortedPoints.at(-1) : nodes[0];
    if (first) show(first);
    byKeyboard = Boolean(first) && !fromPointer;
  };
  const key = (event: KeyboardEvent): boolean => {
    if (!options.enabled() || event.target !== options.container()) return false;
    if (event.key === "Escape") {
      close();
      return true;
    }
    if (event.key === "Enter" && active) {
      if (options.kind() === "map" && !visibleRecords().includes(active)) {
        close();
        return true;
      }
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
    let nodes = visibleRecords();
    if (seriesChart()) nodes = [...nodes].sort((a, b) => a.datum.anchor[0] - b.datum.anchor[0]);
    if (options.kind() === "line" || options.kind() === "area") {
      const seen = new Set<string | number | undefined>();
      nodes = nodes.filter((entry) => {
        const x = category(entry);
        if (seen.has(x)) return false;
        seen.add(x);
        return true;
      });
    }
    if (!nodes.length) return false;
    event.preventDefault();
    pinned = false;
    let index = active
      ? options.kind() === "line" || options.kind() === "area"
        ? nodes.findIndex((entry) => category(entry) === category(active!))
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
    const next = nodes[Math.max(0, Math.min(nodes.length - 1, index))]!;
    options.nav?.()?.reveal?.(next.element);
    show(next);
    byKeyboard = true;
    return true;
  };
  return {
    selectDatum: (selected: ChartDatumRef | null | undefined) => selectData(selected ? [selected] : []),
    selectData,
    linkCursor,
    destroy: () => close(false),
    move,
    down,
    up,
    click,
    focus,
    key,
    followsFocus: () => byKeyboard && active !== undefined,
    close: () => close(),
    invalidate,
    leave: () => {
      if (!pinned) close();
    },
  };
}

/** Dismiss inspection on outside interaction, but allow the tooltip itself to scroll. */
export function closeChartInspectionOnOutside(options: {
  container: () => HTMLElement | undefined;
  tooltip: () => HTMLElement | undefined;
  /** The tooltip's anchor, for a tooltip that follows its mark when the page scrolls. */
  anchor?: () => HTMLElement | undefined;
  /** Whether the open tooltip came from the keyboard; only such a tooltip follows its mark instead of closing. */
  follow?: () => boolean;
  close: () => void;
  keepScroll?: () => boolean | undefined;
}): () => void {
  const outside = (event: PointerEvent) => {
    if (event.target instanceof Node && !options.container()?.contains(event.target)) options.close();
  };
  const scroll = (event: Event) => {
    if (event.target === options.container() && options.keepScroll?.()) return;
    if (event.target instanceof Node && options.tooltip()?.contains(event.target)) return;
    // Keyboard inspection keeps its tooltip while the page scrolls, such as when focus scrolls the chart into view a
    // frame after the tooltip opened; the tooltip follows its mark. A pointer's tooltip closes: the pointer left it.
    const container = options.container(),
      tooltip = options.tooltip(),
      anchor = options.anchor?.();
    if (
      options.follow?.() &&
      container &&
      tooltip &&
      anchor &&
      container.contains(container.ownerDocument.activeElement) &&
      tooltip.matches(":popover-open")
    ) {
      positionTooltipSurface(tooltip, anchor);
      return;
    }
    options.close();
  };
  window.addEventListener("pointerdown", outside);
  window.addEventListener("scroll", scroll, true);
  window.addEventListener("resize", options.close);
  return () => {
    window.removeEventListener("pointerdown", outside);
    window.removeEventListener("scroll", scroll, true);
    window.removeEventListener("resize", options.close);
  };
}

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
    anchor: () => anchor,
    follow: inspector.followsFocus,
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
