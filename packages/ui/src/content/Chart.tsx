import type { MapViewport } from "@k2b/stdlib";
import { charts } from "@k2b/stdlib";
import type { JSX } from "solid-js";
import { createEffect, createMemo, createSignal, createUniqueId, onCleanup, onMount, Show, splitProps, untrack } from "solid-js";
import { createChartInspection, type ChartSelection, type ChartTooltipFormatter, type ChartDatumRef } from "./chart-inspection";
import { useLocale } from "../intl/locale";
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
import { isServer } from "solid-js/web";
import { responsiveChartSvg, selectedChartSvg } from "./chart-svg";

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
 * **Sizing.** The server and browser render the same logical viewBox. CSS
 * fits Cartesian plots to the container and preserves text/marker sizes;
 * maps, pies, donuts and gauges retain their aspect ratio. No measurement
 * or hydration redraw is needed. The caller sizes the wrapper, for example
 * `style={{ height: "14rem" }}`. State timelines derive their default height
 * from the row count and legend via `stateTimelineHeight()`.
 *
 * **Why so thin.** The props are a discriminated union over each
 * stdlib chart function — `kind: "line"` brings in exactly the params
 * `charts.line` expects, `kind: "bar"` brings in `charts.bar`'s, etc.
 * Options stay aligned with stdlib without renaming. Shared interactive
 * layers add bounded pan / zoom controls to maps and state timelines, plus
 * renderer-owned inspection, tooltips and optional selection for all chart kinds.
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
  interactiveChart: string;
  zoomIn: string;
  zoomOut: string;
  resetMap: string;
  resetTimeline: string;
}>;

/**
 * Per-kind props: `kind` discriminator + the exact options that
 * `charts.<kind>` accepts, **minus** `width` / `height` (the wrapper
 * owns those — CSS fits a stable coordinate space to the box). Solid's
 * component model handles discriminated unions natively, so callsites
 * get full type safety.
 */
export type ChartProps = {
  [K in ChartKind]: {
    kind: K;
    class?: string;
    style?: JSX.CSSProperties | string;
    labels?: ChartLabels;
    interactive?: boolean;
    onSelect?: (selection: ChartSelection) => void;
    /** Controlled highlight; indices belong to this exact input snapshot. */
    selected?: ChartDatumRef | null;
    tooltip?: ChartTooltipFormatter;
  } & (K extends "stateTimeline" ? StateTimelineChartOptions : Omit<Parameters<(typeof charts)[K]>[0], "width" | "height" | "inspect">);
}[ChartKind];

/** Pure renderer options: component layout, events and inspection are configured elsewhere. */
export type ChartRenderOptions = {
  [K in ChartKind]: Omit<
    Extract<ChartProps, { kind: K }>,
    "class" | "style" | "labels" | "interactive" | "onSelect" | "selected" | "tooltip"
  >;
}[ChartKind];

/**
 * Internal — strips wrapper-only keys from props and forwards the
 * rest (plus logical size) to `charts[kind]`. The `any` is the
 * price for dispatching one function call across 14 different option
 * types; an explicit per-kind switch would type it but balloon the
 * component for no runtime benefit.
 */
export const renderChartSvg = (
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
    onSelect: _onSelect,
    selected: _selected,
    tooltip: _tooltip,
    ...opts
  } = props as ChartProps & { interactive?: boolean };
  if (kind === "stateTimeline") {
    return responsiveChartSvg(
      renderStateTimelineSvg({
        ...(opts as StateTimelineChartOptions),
        width,
        height,
        viewport: timelineViewport,
        interactive: props.interactive,
      }),
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svg = (charts[kind] as (o: unknown) => string)({
    ...(opts as any),
    ...(kind === "map" && mapViewport ? { viewport: mapViewport } : {}),
    width,
    height,
    inspect: props.interactive === true,
  });
  return preservesAspectRatio(kind) ? svg : responsiveChartSvg(svg);
};

const preservesAspectRatio = (kind: ChartKind) => kind === "map" || kind === "pie" || kind === "donut" || kind === "gauge";

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
  const [, drawingProps] = splitProps(props, ["selected", "onSelect", "tooltip"]);
  const messages = useUiMessages();
  const locale = useLocale();
  let containerRef: HTMLDivElement | undefined;
  let chartTooltipRef: HTMLSpanElement | undefined;
  let lineAnchorRef: HTMLSpanElement | undefined;
  // One deterministic coordinate space on the server and client. CSS fits the
  // SVG to its box; hydration must never replace it with measured geometry.
  const size = () => ({
    width: 480,
    height: props.kind === "stateTimeline" ? stateTimelineHeight(props.rows.length, props.legend !== false) : 280,
  });
  const dimensions = () => containerRef?.getBoundingClientRect() ?? size();
  const initialMapViewport = props.kind === "map" ? normalizeMapViewport(props.viewport) : DEFAULT_MAP_VIEWPORT;
  const [mapViewport, setMapViewport] = createSignal<MapViewport>(initialMapViewport);
  const initialTimelineViewport =
    props.kind === "stateTimeline" ? stateTimelineDomain(props.rows, props.domain) : ([0, 1] as StateTimelineDomain);
  const [timelineViewport, setTimelineViewport] = createSignal<StateTimelineDomain>(initialTimelineViewport);
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
  const interactive = () => props.interactive === true;
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
    return dimensions();
  };

  const zoom = (delta: number) => {
    closeChartTooltip();
    if (interactiveMap()) {
      setMapViewport((current) => zoomMapViewport(current, delta));
    } else if (interactiveTimeline()) {
      updateTimelineViewport((current) => zoomStateTimelineViewport(current, timelineFullDomain(), delta));
    }
  };

  const reset = () => {
    closeChartTooltip();
    if (interactiveMap() && props.kind === "map") {
      setMapViewport(normalizeMapViewport(props.viewport));
    }
    if (interactiveTimeline()) {
      timelineViewportLocallyChanged = false;
      setTimelineViewport(timelineFullDomain());
    }
  };

  const handlePointerDown: JSX.EventHandlerUnion<HTMLDivElement, PointerEvent> = (event) => {
    inspection.down(event);
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
    const start = timelineDrag ?? drag;
    if (start && Math.hypot(sample.clientX - start.x, sample.clientY - ("y" in start ? start.y : sample.clientY)) <= 6) return;
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
    inspection.move(event);
    if (timelineDrag?.pointerId !== event.pointerId && drag?.pointerId !== event.pointerId) return;
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
    if (inspection.key(event)) return;
    if (!draggable() || event.target !== containerRef) return;
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

  const inspection = createChartInspection({
    container: () => containerRef,
    tooltip: () => chartTooltipRef,
    anchor: () => lineAnchorRef,
    kind: () => props.kind,
    enabled: interactive,
    select: (selection) => props.onSelect?.(selection),
    format: (selection) => {
      if (props.tooltip) return props.tooltip(selection);
      const fields = messages().chartFields;
      const format = new Intl.NumberFormat(locale(), { maximumFractionDigits: 6 });
      return {
        title:
          selection.datum.label ??
          (selection.datum.seriesIndex !== undefined
            ? `${labels().series ?? messages().series} ${selection.datum.seriesIndex + 1}`
            : undefined),
        rows: selection.datum.values.map((field) => ({
          label:
            selection.kind === "line" && field.key === "y"
              ? (selection.datum.label ?? labels().series ?? messages().series)
              : fields({ key: field.key }),
          value:
            field.formatted ??
            (field.key === "upperInclusive"
              ? field.value === "true"
                ? messages().yes
                : messages().no
              : typeof field.value === "number"
                ? `${format.format(field.value)}${field.key === "percent" ? "%" : ""}`
                : field.value),
        })),
      };
    },
  });
  const closeChartTooltip = () => inspection.close();
  const svgMarkup = createMemo(() =>
    renderChartSvg(
      drawingProps,
      size().width,
      size().height,
      interactiveMap() ? mapViewport() : undefined,
      interactiveTimeline() ? timelineViewport() : undefined,
    ),
  );
  createEffect(() => {
    svgMarkup();
    inspection.invalidate();
    untrack(() => inspection.selectDatum(props.selected));
  });

  createEffect(() => inspection.selectDatum(props.selected));

  onCleanup(() => {
    inspection.close();
    if (pointerFrame !== undefined) cancelAnimationFrame(pointerFrame);
    pointerFrame = undefined;
    pendingPointer = undefined;
  });

  onMount(() => {
    if (!containerRef) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef?.contains(event.target)) closeChartTooltip();
    };
    window.addEventListener("pointerdown", outside);
    const scroll = (event: Event) => {
      if (event.target instanceof Node && chartTooltipRef?.contains(event.target)) return;
      closeChartTooltip();
    };
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", closeChartTooltip);
    onCleanup(() => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("scroll", scroll, true);
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
      {/* CSS fits the server-rendered SVG to the caller's box. Only changes
          to chart data/options rebuild the SVG; resizing does not. */}
      <div
        ref={containerRef}
        class={`k2b-chart ${props.class ?? ""}`}
        data-chart-kind={props.kind}
        data-drag={draggable() ? (dragging() ? "active" : "idle") : undefined}
        data-crosshair={!draggable() && interactiveLine() ? "true" : undefined}
        data-interactive={interactive() ? "true" : undefined}
        style={chartStyle()}
        role="group"
        aria-label={
          interactiveMap()
            ? (labels().interactiveMap ?? messages().interactiveMap)
            : interactiveTimeline()
              ? (labels().interactiveTimeline ?? messages().interactiveTimeline)
              : interactiveLine()
                ? (labels().interactiveLine ?? messages().interactiveLineChart)
                : interactive()
                  ? (labels().interactiveChart ?? messages().interactiveChart)
                  : undefined
        }
        aria-description={interactive() ? messages().interactiveChart : undefined}
        tabIndex={interactive() ? 0 : undefined}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
        onClick={inspection.click}
        onPointerLeave={inspection.leave}
        onFocusIn={inspection.focus}
        onFocusOut={closeChartTooltip}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
      >
        <div
          class="k2b-chart__svg"
          data-stretch={!preservesAspectRatio(props.kind) ? "true" : undefined}
          style={{
            "--k2b-chart-width": `${size().width}px`,
            "--k2b-chart-height": `${size().height}px`,
            "aspect-ratio": `${size().width} / ${size().height}`,
          }}
          innerHTML={isServer ? selectedChartSvg(svgMarkup(), props.selected) : svgMarkup()}
        />
        <Show when={interactive()}>
          <span ref={lineAnchorRef} class="k2b-chart__anchor" aria-hidden="true" />
          <span
            id={chartTooltipId}
            ref={chartTooltipRef}
            role="tooltip"
            popover="manual"
            data-instant="true"
            class="k2b-tooltip k2b-chart__tooltip"
          />
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
