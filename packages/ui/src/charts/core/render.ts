import { type BarChartOptions, barChartLayout, renderBarChartSvg } from "../../content/chart-bar";
import { lineGapsSvg } from "../../content/chart-line-gaps";
import { DEFAULT_MAP_VIEWPORT, normalizeMapViewport } from "../../content/chart-map-viewport";
import {
  renderStateTimelineSvg,
  type StateTimelineChartOptions,
  type StateTimelineDomain,
  stateTimelineHeight,
} from "../../content/chart-state-timeline";
import { responsiveChartSvg, responsiveMapSvg } from "../../content/chart-svg";
import { type ChartTimeAxis, timeAxisSvg } from "../../content/chart-time-axis";
import { chartRenderers } from "./registry";
import type { MapViewport } from "./svg";
import type { ChartKind } from "./types";

export type ChartDrawingOptions = {
  [K in ChartKind]: { kind: K } & (K extends "map"
    ? {
        /** Target when zooming in from the world view. Defaults to Europe (50, 10). */
        zoomFocus?: Pick<MapViewport, "latitude" | "longitude">;
      }
    : {}) &
    (K extends "line"
      ? {
          /** Largest connected X distance; positive, finite, without area/errorBand fills. */
          maxGap?: number;
          /** Wrap the legend above the plot inside the caller's total chart height. Requires legend=true. */
          legendPlacement?: "top-start";
          /** Round ticks for instant X values (Unix ms), in the supplied zone. xAxis.format labels them. */
          timeAxis?: ChartTimeAxis;
        }
      : {}) &
    Omit<Parameters<(typeof chartRenderers)[K]>[0], "width" | "height" | "inspect" | "interactive">;
}[ChartKind];
export type ChartRenderOptions = {
  [K in ChartKind]: Omit<Extract<ChartDrawingOptions, { kind: K }>, "legendPlacement">;
}[ChartKind];

/** Keep the fixed 28-unit bar-gauge rows inside the shared SSR/browser coordinate space. */
export const chartRenderHeight = (props: ChartRenderOptions): number => {
  if (props.kind === "stateTimeline") return stateTimelineHeight(props.rows.length, props.legend !== false);
  if (props.kind === "bar") return barChartLayout(props).height;
  if (props.kind === "barGauge") return Math.max(280, (props.title || props.subtitle ? 42 : 16) + props.data.length * 28 + 14);
  return 280;
};

/** Shared logical SVG renderer; callbacks and browser interaction stay with the Solid host. */
export const renderChartSvg = (
  props: ChartDrawingOptions,
  width: number,
  height: number,
  mapViewport?: MapViewport,
  timelineViewport?: StateTimelineDomain,
): string => {
  const {
    kind,
    zoomFocus: _zoomFocus,
    legendPlacement: _legendPlacement,
    timeAxis: _timeAxis,
    ...opts
  } = props as ChartDrawingOptions & {
    zoomFocus?: Pick<MapViewport, "latitude" | "longitude">;
    legendPlacement?: "top-start";
    timeAxis?: ChartTimeAxis;
  };
  if (kind === "stateTimeline") {
    return responsiveChartSvg(
      renderStateTimelineSvg({
        ...(opts as StateTimelineChartOptions),
        width,
        height,
        viewport: timelineViewport,
        interactive: true,
      }),
    );
  }
  if (kind === "bar") return responsiveChartSvg(renderBarChartSvg({ ...(opts as BarChartOptions), width, height, inspect: true }));
  // A time axis needs an explicit X domain: it maps its round ticks onto the axis the renderer drew over it.
  const timeAxis = props.kind === "line" ? props.timeAxis : undefined;
  const timeDomain = timeAxis && props.kind === "line" ? lineTimeDomain(props) : undefined;
  let svg = (chartRenderers[kind] as (o: unknown) => string)({
    ...opts,
    ...(timeDomain && props.kind === "line" ? { xAxis: { ...props.xAxis, domain: timeDomain, format: () => "" } } : {}),
    ...(props.kind === "line" && props.legend && props.legendPlacement === "top-start" ? { legend: false } : {}),
    ...(kind === "map" ? { viewport: DEFAULT_MAP_VIEWPORT } : {}),
    width,
    height,
    inspect: true,
  });
  if (props.kind === "line" && props.maxGap !== undefined) {
    if (props.area || props.errorBand) throw new Error("Chart maxGap does not support area or errorBand fills");
    svg = lineGapsSvg(svg, props.maxGap, props);
  }
  if (timeAxis && timeDomain && props.kind === "line")
    svg = timeAxisSvg(svg, timeDomain, timeAxis, (props.xAxis?.ticks ?? 3) + 2, props.xAxis?.format);
  if (props.kind === "map") return responsiveMapSvg(svg, width, height, normalizeMapViewport(mapViewport ?? props.viewport));
  return preservesAspectRatio(kind) ? svg : responsiveChartSvg(svg);
};

/** The given X domain, or the span of the plotted instants. */
const lineTimeDomain = (props: Extract<ChartDrawingOptions, { kind: "line" }>): [number, number] | undefined => {
  if (props.xAxis?.domain) return props.xAxis.domain;
  const xs = props.series.flatMap((series) => series.data.map((point) => point.x)).filter(Number.isFinite);
  if (!xs.length) return undefined;
  const lo = Math.min(...xs),
    hi = Math.max(...xs);
  return lo < hi ? [lo, hi] : undefined;
};

export const preservesAspectRatio = (kind: ChartKind) => kind === "map" || kind === "pie" || kind === "donut" || kind === "gauge";

export type ChartSize = { width: number; height: number };
export type ChartScene = ChartSize & { kind: ChartKind; svg: string };
/** Lay out a chart in a fixed logical coordinate space, without browser measurement. */
export const layout = (spec: ChartDrawingOptions, size: ChartSize): ChartScene => ({
  ...size,
  kind: spec.kind,
  svg: renderChartSvg(spec, size.width, size.height),
});
export const toSvg = (scene: ChartScene): string => scene.svg;
