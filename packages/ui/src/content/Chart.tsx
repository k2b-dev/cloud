import type { MapViewport } from "@k2b/stdlib";
import { charts } from "@k2b/stdlib";
import type { JSX } from "solid-js";
import { createEffect, createMemo, createSignal, createUniqueId, onCleanup, onMount, Show } from "solid-js";
import { positionTooltipSurface } from "../feedback/tooltip-position";
import { useUiMessages } from "../intl/messages";
import { DEFAULT_MAP_VIEWPORT, normalizeMapViewport, panMapViewport, zoomMapViewport } from "./chart-map-viewport";
import {
  panStateTimelineViewport,
  renderStateTimelineSvg,
  type StateTimelineChartOptions,
  type StateTimelineDomain,
  stateTimelineDomain,
  stateTimelineHeight,
  zoomStateTimelineViewport,
} from "./chart-state-timeline";

/**
 * Chart — minimal Solid wrapper around `stdlib.charts`.
 *
 * **Live-update story.** `charts.<kind>(opts)` returns an SVG string;
 * Solid's `innerHTML` is reactive, so any time a prop (signal, store
 * slice, derived value) changes, the SVG re-renders. No manual
 * subscription, no imperative DOM patching. Trade-off: every change
 * is a full SVG re-build, not a diff — fine for dashboard cadences
 * (poll, websocket, store updates). Don't use this for 60fps streaming.
 *
 * **Sizing.** stdlib emits `<svg viewBox="0 0 W H">` with no width/
 * height attributes, so the SVG would otherwise fall back to the
 * browser's replaced-element default (300×150) and either overflow
 * or look squished. We measure the wrapping `<div>` with a
 * ResizeObserver and pass the actual pixel dimensions to stdlib —
 * the viewBox matches the container, no aspect distortion, no
 * letterboxing. Sizing the wrapper itself is the caller's job
 * (`style={{ height: "14rem" }}`, an app class, a flex child, …).
 * On SSR (no observer)
 * the chart renders at stdlib's default size; the first client-side
 * frame re-measures and re-renders.
 *
 * One documented exception: `kind: "stateTimeline"` derives its own
 * initial height from the row count and legend via
 * `stateTimelineHeight()`, because a timeline's height is a function of
 * how many rows it has rather than of the layout around it. Every other
 * kind starts at 280px until the observer reports the real box. Layout
 * code that sizes charts uniformly must account for this.
 *
 * **Why so thin.** The props are a discriminated union over each
 * stdlib chart function — `kind: "line"` brings in exactly the params
 * `charts.line` expects, `kind: "bar"` brings in `charts.bar`'s, etc.
 * Options stay aligned with stdlib without renaming. Shared interactive
 * layers add bounded pan / zoom controls to maps and state timelines, plus
 * nearest-point hover and keyboard inspection for line charts.
 * If stdlib gains a new option, it's automatically available at every
 * callsite.
 *
 * **Theming.** stdlib charts use `currentColor` for axes / ticks /
 * tick labels — set the wrapping element's `color` and everything
 * inherits. Series colors come from `--stdlib-chart-c1..c8` CSS
 * custom properties; override on the parent for per-chart palettes.
 *
 * ```tsx
 * <Chart kind="line" style={{ height: "12rem" }}
 *        series={[{ data: points() }]}
 *        yAxis={{ format: v => `€${v}k` }} />
 *
 * <Chart kind="donut" style={{ height: "12rem" }} data={slices()} />
 *
 * <Chart kind="sparkline" style={{ width: "6rem", height: "1.5rem" }} data={trend()} />
 *
 * <Chart kind="map" style={{ height: "16rem" }} series={locations()} interactive />
 * ```
 */

/** All chart kinds shipped by `stdlib.charts`. */
export type ChartKind = keyof typeof charts;

export type ChartLabels = Partial<{
  empty: string;
  series: string;
  interactiveMap: string;
  interactiveTimeline: string;
  interactiveLine: string;
  zoomIn: string;
  zoomOut: string;
  resetMap: string;
  resetTimeline: string;
}>;

/**
 * Per-kind props: `kind` discriminator + the exact options that
 * `charts.<kind>` accepts, **minus** `width` / `height` (the wrapper
 * owns those — they're derived from container measurement). Solid's
 * component model handles discriminated unions natively, so callsites
 * get full type safety.
 */
export type ChartProps = {
  [K in ChartKind]: {
    kind: K;
    class?: string;
    style?: JSX.CSSProperties | string;
    labels?: ChartLabels;
  } & (K extends "stateTimeline"
    ? StateTimelineChartOptions
    : Omit<Parameters<(typeof charts)[K]>[0], "width" | "height"> & (K extends "map" | "line" ? { interactive?: boolean } : {}));
}[ChartKind];

/**
 * Internal — strips wrapper-only keys from props and forwards the
 * rest (plus measured size) to `charts[kind]`. The `any` is the
 * price for dispatching one function call across 8 different option
 * types; an explicit per-kind switch would type it but balloon the
 * component for no runtime benefit.
 */
const renderSvg = (
  props: ChartProps,
  width: number,
  height: number,
  mapViewport?: MapViewport,
  timelineViewport?: StateTimelineDomain,
): string => {
  const {
    kind,
    class: _class,
    style: _style,
    labels: _labels,
    interactive: _interactive,
    ...opts
  } = props as ChartProps & { interactive?: boolean };
  if (kind === "stateTimeline") {
    return renderStateTimelineSvg({
      ...(opts as StateTimelineChartOptions),
      width,
      height,
      viewport: timelineViewport,
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (charts[kind] as (o: unknown) => string)({
    ...(opts as any),
    ...(kind === "map" && mapViewport ? { viewport: mapViewport } : {}),
    width,
    height,
  });
};

/** Empty-data short-circuit. Kept per-kind because stdlib's payload
 *  key differs (series vs data vs groups). We're conservative: only
 *  block on truly empty inputs; partially-filled series get rendered
 *  as-is and stdlib handles the gaps. */
const isEmpty = (props: ChartProps): boolean => {
  if (props.kind === "line" || props.kind === "scatter") {
    return !props.series?.length || props.series.every((s) => !s.data.length);
  }
  if (props.kind === "bar" || props.kind === "donut" || props.kind === "pie") {
    return !props.data?.length;
  }
  if (props.kind === "histogram" || props.kind === "sparkline") {
    return !props.data?.length;
  }
  if (props.kind === "boxplot") {
    return !props.groups?.length;
  }
  if (props.kind === "stateTimeline") {
    return !props.rows?.length || props.rows.every((row) => !row.intervals.length);
  }
  return false;
};

const Chart = (props: ChartProps): JSX.Element => {
  const messages = useUiMessages();
  let containerRef: HTMLDivElement | undefined;
  let chartTooltipRef: HTMLSpanElement | undefined;
  let lineAnchorRef: HTMLSpanElement | undefined;
  let chartTooltipTriggerRef: Element | undefined;
  // Initial size matches stdlib's chart-function defaults so the SSR
  // render is sensible. The observer updates this on the first
  // client-side frame; the SVG re-renders reactively via innerHTML.
  const initialHeight = props.kind === "stateTimeline" ? stateTimelineHeight(props.rows.length, props.legend !== false) : 280;
  const [size, setSize] = createSignal({ width: 480, height: initialHeight });
  const initialMapViewport = props.kind === "map" ? normalizeMapViewport(props.viewport) : DEFAULT_MAP_VIEWPORT;
  const [mapViewport, setMapViewport] = createSignal<MapViewport>(initialMapViewport);
  const initialTimelineViewport =
    props.kind === "stateTimeline" ? stateTimelineDomain(props.rows, props.domain) : ([0, 1] as StateTimelineDomain);
  const [timelineViewport, setTimelineViewport] = createSignal<StateTimelineDomain>(initialTimelineViewport);
  const [linePointIndex, setLinePointIndex] = createSignal(0);
  const [lineInspectionActive, setLineInspectionActive] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);
  const chartTooltipId = `k2b-chart-tooltip-${createUniqueId()}`;
  let timelineViewportLocallyChanged = false;
  let drag:
    | {
        pointerId: number;
        x: number;
        y: number;
        width: number;
        height: number;
        viewport: MapViewport;
      }
    | undefined;
  let timelineDrag:
    | {
        pointerId: number;
        x: number;
        width: number;
        viewport: StateTimelineDomain;
      }
    | undefined;
  let pointerFrame: number | undefined;
  let pendingPointer: { pointerId: number; clientX: number; clientY: number } | undefined;

  const interactiveMap = () => props.kind === "map" && props.interactive === true;
  const interactiveTimeline = () => props.kind === "stateTimeline" && props.interactive === true;
  const interactiveLine = () => props.kind === "line" && props.interactive === true;
  const interactive = () => interactiveMap() || interactiveTimeline() || interactiveLine();
  const draggable = () => interactiveMap() || interactiveTimeline();
  const labels = () => props.labels ?? {};
  const timelineFullDomain = (): StateTimelineDomain =>
    props.kind === "stateTimeline" ? stateTimelineDomain(props.rows, props.domain) : [0, 1];

  createEffect(() => {
    if (props.kind === "map") {
      setMapViewport(normalizeMapViewport(props.viewport));
    }
  });

  createEffect(() => {
    if (props.kind === "stateTimeline" && !timelineViewportLocallyChanged) {
      setTimelineViewport(timelineFullDomain());
    }
  });

  const updateTimelineViewport = (update: (current: StateTimelineDomain) => StateTimelineDomain) => {
    timelineViewportLocallyChanged = true;
    setTimelineViewport(update);
  };

  const mapDimensions = () => {
    const viewportElement = containerRef?.querySelector(".stdlib-chart-map-viewport");
    const rect = viewportElement?.getBoundingClientRect();
    if (rect && rect.width > 0 && rect.height > 0) {
      return { width: rect.width, height: rect.height };
    }
    return size();
  };

  const zoom = (delta: number) => {
    if (interactiveMap()) {
      setMapViewport((current) => zoomMapViewport(current, delta));
    } else if (interactiveTimeline()) {
      updateTimelineViewport((current) => zoomStateTimelineViewport(current, timelineFullDomain(), delta));
    }
  };

  const reset = () => {
    if (interactiveMap() && props.kind === "map") {
      setMapViewport(normalizeMapViewport(props.viewport));
    }
    if (interactiveTimeline()) {
      timelineViewportLocallyChanged = false;
      setTimelineViewport(timelineFullDomain());
    }
  };

  const handlePointerDown: JSX.EventHandlerUnion<HTMLDivElement, PointerEvent> = (event) => {
    if (!draggable() || event.button !== 0 || (event.target as Element).closest("button, a")) {
      return;
    }
    closeChartTooltip();
    if (interactiveTimeline()) {
      timelineDrag = {
        pointerId: event.pointerId,
        x: event.clientX,
        width: Math.max(1, event.currentTarget.getBoundingClientRect().width),
        viewport: timelineViewport(),
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
      return;
    }
    const dimensions = mapDimensions();
    drag = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      width: dimensions.width,
      height: dimensions.height,
      viewport: mapViewport(),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const flushPointerMove = () => {
    if (pointerFrame !== undefined) {
      cancelAnimationFrame(pointerFrame);
      pointerFrame = undefined;
    }
    const sample = pendingPointer;
    pendingPointer = undefined;
    if (!sample) return;
    if (interactiveLine()) {
      showLineTooltip(sample.clientX, sample.clientY);
      return;
    }
    const activeTimelineDrag = timelineDrag;
    if (activeTimelineDrag?.pointerId === sample.pointerId) {
      updateTimelineViewport(() =>
        panStateTimelineViewport(
          activeTimelineDrag.viewport,
          timelineFullDomain(),
          sample.clientX - activeTimelineDrag.x,
          activeTimelineDrag.width,
        ),
      );
      return;
    }
    if (!drag || drag.pointerId !== sample.pointerId) return;
    setMapViewport(panMapViewport(drag.viewport, sample.clientX - drag.x, sample.clientY - drag.y, drag.width, drag.height));
  };

  const handlePointerMove: JSX.EventHandlerUnion<HTMLDivElement, PointerEvent> = (event) => {
    if (!interactiveLine() && timelineDrag?.pointerId !== event.pointerId && drag?.pointerId !== event.pointerId) return;
    pendingPointer = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY };
    if (pointerFrame !== undefined) return;
    pointerFrame = requestAnimationFrame(flushPointerMove);
  };

  const stopDragging: JSX.EventHandlerUnion<HTMLDivElement, PointerEvent> = (event) => {
    if (pendingPointer?.pointerId === event.pointerId) flushPointerMove();
    if (timelineDrag?.pointerId === event.pointerId) {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      timelineDrag = undefined;
      setDragging(false);
      return;
    }
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    drag = undefined;
    setDragging(false);
  };

  const handleWheel: JSX.EventHandlerUnion<HTMLDivElement, WheelEvent> = (event) => {
    if (interactiveMap() && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      zoom(event.deltaY < 0 ? 1 : -1);
      return;
    }
    if (!interactiveTimeline()) return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      const anchor = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5;
      updateTimelineViewport((current) => zoomStateTimelineViewport(current, timelineFullDomain(), event.deltaY < 0 ? 1 : -1, anchor));
    } else if (event.shiftKey) {
      event.preventDefault();
      updateTimelineViewport((current) =>
        panStateTimelineViewport(current, timelineFullDomain(), -event.deltaY, event.currentTarget.getBoundingClientRect().width),
      );
    }
  };

  const handleKeyDown: JSX.EventHandlerUnion<HTMLDivElement, KeyboardEvent> = (event) => {
    if (!interactive()) return;
    if (interactiveLine()) {
      const values = lineXValues();
      if (values.length === 0) return;
      if (event.key === "Escape") {
        closeChartTooltip();
        return;
      }
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? values.length - 1
            : event.key === "ArrowLeft"
              ? Math.max(0, linePointIndex() - 1)
              : event.key === "ArrowRight"
                ? Math.min(values.length - 1, linePointIndex() + 1)
                : null;
      if (next === null) return;
      event.preventDefault();
      showLinePoint(next);
      return;
    }
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoom(1);
      return;
    }
    if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoom(-1);
      return;
    }
    if (event.key === "0" || event.key === "Home") {
      event.preventDefault();
      reset();
      return;
    }
    if (interactiveTimeline() && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      updateTimelineViewport((current) =>
        panStateTimelineViewport(
          current,
          timelineFullDomain(),
          event.key === "ArrowLeft" ? 80 : -80,
          event.currentTarget.getBoundingClientRect().width,
        ),
      );
      return;
    }
    const delta: readonly [number, number] | undefined = {
      ArrowLeft: [40, 0],
      ArrowRight: [-40, 0],
      ArrowUp: [0, 40],
      ArrowDown: [0, -40],
    }[event.key] as readonly [number, number] | undefined;
    if (!delta) return;
    event.preventDefault();
    const dimensions = mapDimensions();
    setMapViewport((current) => panMapViewport(current, delta[0], delta[1], dimensions.width, dimensions.height));
  };

  const closeChartTooltip = () => {
    if (interactiveLine()) {
      if (pointerFrame !== undefined) cancelAnimationFrame(pointerFrame);
      pointerFrame = undefined;
      pendingPointer = undefined;
    }
    chartTooltipTriggerRef?.removeAttribute("aria-describedby");
    chartTooltipTriggerRef = undefined;
    setLineInspectionActive(false);
    if (!chartTooltipRef) return;
    try {
      if (chartTooltipRef.matches(":popover-open")) chartTooltipRef.hidePopover();
    } catch {
      // A disconnect can race with the Popover API.
    }
  };

  const showTimelineTooltip = (target: Element | null) => {
    if (!interactiveTimeline() || !chartTooltipRef) return;
    const trigger = target?.closest<HTMLElement>("[data-chart-tooltip]");
    const content = trigger?.dataset.chartTooltip;
    if (!trigger || !content) return;
    chartTooltipTriggerRef?.removeAttribute("aria-describedby");
    chartTooltipTriggerRef = trigger;
    trigger.setAttribute("aria-describedby", chartTooltipId);
    chartTooltipRef.textContent = content;
    try {
      if (!chartTooltipRef.matches(":popover-open")) chartTooltipRef.showPopover();
      positionTooltipSurface(chartTooltipRef, trigger);
    } catch {
      // SVG <title> remains as the fallback on browsers without Popover.
    }
  };

  const lineInspection = createMemo(() => {
    if (props.kind !== "line") {
      return {
        values: [] as number[],
        series: [] as Array<{ label: string; points: Map<number, { x: number; y: number }> }>,
      };
    }
    const values = new Set<number>();
    const series = props.series.map((entry) => {
      const points = new Map<number, { x: number; y: number }>();
      for (const point of entry.data) {
        if (!Number.isFinite(point.x)) continue;
        values.add(point.x);
        if (Number.isFinite(point.y) && !points.has(point.x)) points.set(point.x, point);
      }
      return { label: entry.label ?? labels().series ?? messages().series, points };
    });
    return { values: [...values].sort((left, right) => left - right), series };
  });
  const lineXValues = () => lineInspection().values;

  const linePlotBounds = (): { left: number; right: number } => {
    if (props.kind !== "line") return { left: 0, right: size().width };
    const padding = props.padding;
    const left = (typeof padding === "number" ? padding : padding?.left) ?? 40;
    const rightInset = (typeof padding === "number" ? padding : padding?.right) ?? 16;
    return {
      left: left + (props.yAxis?.label ? 14 : 0),
      right: Math.max(left + 1, size().width - rightInset),
    };
  };

  const showLinePoint = (index: number, pointerY?: number) => {
    if (props.kind !== "line" || !chartTooltipRef || !lineAnchorRef) return;
    const inspection = lineInspection();
    const values = inspection.values;
    const pointIndex = Math.min(values.length - 1, Math.max(0, index));
    const x = values[pointIndex];
    if (x === undefined) return;
    const points = inspection.series
      .map((series) => {
        const point = series.points.get(x);
        return point ? { label: series.label, point } : null;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    if (points.length === 0) return;

    const xFormat = props.xAxis?.format ?? String;
    const yFormat = props.yAxis?.format ?? String;
    chartTooltipRef.textContent = [xFormat(x), ...points.map((entry) => `${entry.label}: ${yFormat(entry.point.y)}`)].join(" · ");

    const [min, max] = [values[0] ?? x, values.at(-1) ?? x];
    const bounds = linePlotBounds();
    const ratio = max === min ? 0.5 : (x - min) / (max - min);
    lineAnchorRef.style.left = `${bounds.left + ratio * (bounds.right - bounds.left)}px`;
    lineAnchorRef.style.top = `${Math.min(size().height - 8, Math.max(8, pointerY ?? 24))}px`;
    setLinePointIndex(pointIndex);
    setLineInspectionActive(true);
    try {
      if (!chartTooltipRef.matches(":popover-open")) chartTooltipRef.showPopover();
      positionTooltipSurface(chartTooltipRef, lineAnchorRef);
    } catch {
      // The chart remains readable on browsers without Popover support.
    }
  };

  const showLineTooltip = (clientX: number, clientY: number) => {
    const values = lineXValues();
    if (values.length === 0) return;
    const rect = containerRef?.getBoundingClientRect();
    if (!rect) return;
    const bounds = linePlotBounds();
    const localX = clientX - rect.left;
    const ratio = Math.min(1, Math.max(0, (localX - bounds.left) / Math.max(1, bounds.right - bounds.left)));
    const target = (values[0] ?? 0) + ratio * ((values.at(-1) ?? 0) - (values[0] ?? 0));
    let low = 0;
    let high = values.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (values[middle]! < target) low = middle + 1;
      else high = middle;
    }
    const previous = Math.max(0, low - 1);
    const index = Math.abs(values[previous]! - target) <= Math.abs(values[low]! - target) ? previous : low;
    showLinePoint(index, clientY - rect.top);
  };

  onCleanup(() => {
    if (pointerFrame !== undefined) cancelAnimationFrame(pointerFrame);
    pointerFrame = undefined;
    pendingPointer = undefined;
  });

  onMount(() => {
    if (!containerRef) return;
    // Seed immediately from layout — avoids one wasted re-render in
    // the case where the container already has its final size at
    // mount time (the common case for dashboard widgets).
    const rect = containerRef.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setSize({ width: Math.round(rect.width), height: Math.round(rect.height) });
    }
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      // Floor to integer pixels; sub-pixel jitter would trigger an
      // SVG re-render on every scroll/zoom otherwise.
      if (width > 0 && height > 0) {
        setSize((prev) => {
          const w = Math.round(width);
          const h = Math.round(height);
          return prev.width === w && prev.height === h ? prev : { width: w, height: h };
        });
      }
    });
    ro.observe(containerRef);
    window.addEventListener("scroll", closeChartTooltip, true);
    window.addEventListener("resize", closeChartTooltip);
    onCleanup(() => {
      ro.disconnect();
      window.removeEventListener("scroll", closeChartTooltip, true);
      window.removeEventListener("resize", closeChartTooltip);
    });
  });

  const chartStyle = () =>
    props.style ??
    (props.kind === "stateTimeline"
      ? {
          height: `${stateTimelineHeight(props.rows.length, props.legend !== false)}px`,
        }
      : undefined);

  return (
    <Show
      when={!isEmpty(props)}
      fallback={
        <div ref={containerRef} class={`k2b-chart k2b-chart__empty ${props.class ?? ""}`} style={chartStyle()}>
          {labels().empty ?? messages().noData}
        </div>
      }
    >
      {/* The wrapping div is what the ResizeObserver watches. `block`
          + the caller's sizing classes (h-48, w-full, flex-1, …) drive
          the available space; the SVG inside fills it via viewBox =
          container size. `innerHTML` is reactive in Solid — re-runs
          on every prop / size change, so live data updates propagate
          without ceremony. */}
      <div
        ref={containerRef}
        class={`k2b-chart ${props.class ?? ""}`}
        data-chart-kind={props.kind}
        data-drag={draggable() ? (dragging() ? "active" : "idle") : undefined}
        data-crosshair={!draggable() && interactiveLine() ? "true" : undefined}
        data-interactive={interactive() ? "true" : undefined}
        style={chartStyle()}
        role="group"
        aria-describedby={interactiveLine() && lineInspectionActive() ? chartTooltipId : undefined}
        aria-label={
          interactiveMap()
            ? (labels().interactiveMap ?? messages().interactiveMap)
            : interactiveTimeline()
              ? (labels().interactiveTimeline ?? messages().interactiveTimeline)
              : interactiveLine()
                ? (labels().interactiveLine ?? messages().interactiveLineChart)
                : undefined
        }
        tabIndex={interactive() ? 0 : undefined}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
        onPointerOver={(event) => showTimelineTooltip(event.target as Element)}
        onPointerOut={(event) => {
          const trigger = (event.target as Element).closest("[data-chart-tooltip]");
          if (trigger && !trigger.contains(event.relatedTarget as Node | null)) closeChartTooltip();
        }}
        onPointerLeave={closeChartTooltip}
        onFocusIn={(event) => {
          if (interactiveLine()) showLinePoint(lineXValues().length - 1);
          else showTimelineTooltip(event.target as Element);
        }}
        onFocusOut={closeChartTooltip}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
      >
        <div
          class="k2b-chart__svg"
          innerHTML={renderSvg(
            props,
            size().width,
            size().height,
            interactiveMap() ? mapViewport() : undefined,
            interactiveTimeline() ? timelineViewport() : undefined,
          )}
        />
        <Show when={interactiveTimeline() || interactiveLine()}>
          <span ref={lineAnchorRef} class="k2b-chart__anchor" aria-hidden="true" />
          <span id={chartTooltipId} ref={chartTooltipRef} role="tooltip" popover="manual" class="k2b-tooltip" />
        </Show>
        <Show when={draggable()}>
          <div class="k2b-chart__controls">
            <button
              type="button"
              class="k2b-button k2b-icon-button"
              data-variant="secondary"
              aria-label={labels().zoomIn ?? messages().zoomIn}
              title={`${labels().zoomIn ?? messages().zoomIn} (+)`}
              onClick={() => zoom(1)}
            >
              <i class="ti ti-plus" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="k2b-button k2b-icon-button"
              data-variant="secondary"
              aria-label={labels().zoomOut ?? messages().zoomOut}
              title={`${labels().zoomOut ?? messages().zoomOut} (-)`}
              onClick={() => zoom(-1)}
            >
              <i class="ti ti-minus" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="k2b-button k2b-icon-button"
              data-variant="secondary"
              aria-label={
                interactiveMap() ? (labels().resetMap ?? messages().resetMapView) : (labels().resetTimeline ?? messages().resetTimelineView)
              }
              title={`${interactiveMap() ? (labels().resetMap ?? messages().resetMapView) : (labels().resetTimeline ?? messages().resetTimelineView)} (0)`}
              onClick={reset}
            >
              <i class="ti ti-focus-centered" aria-hidden="true" />
            </button>
          </div>
        </Show>
      </div>
    </Show>
  );
};

export default Chart;
