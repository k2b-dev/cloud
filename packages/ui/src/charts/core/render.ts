import { type BarChartOptions, renderBarChartSvg } from "../../content/chart-bar";
import { lineGapsSvg } from "../../content/chart-line-gaps";
import { DEFAULT_MAP_VIEWPORT, normalizeMapViewport } from "../../content/chart-map-viewport";
import { renderStateTimelineSvg, type StateTimelineChartOptions, type StateTimelineDomain } from "../../content/chart-state-timeline";
import { responsiveChartSvg, responsiveMapSvg } from "../../content/chart-svg";
import { type ChartTimeAxis, timeAxisSvg } from "../../content/chart-time-axis";
import { type AreaOptions, renderAreaSvg } from "./area";
import { calendarLayout } from "./calendar";
import { type FunnelOptions, renderFunnelSvg } from "./funnel";
import { type HorizontalBarOptions, renderHbarSvg } from "./hbar";
import { lineDetailsEnabled } from "./line-options";
import { chartRenderers } from "./registry";
import type { MapViewport } from "./svg";
import type { ChartKind } from "./types";
import { renderWaterfallSvg, type WaterfallOptions } from "./waterfall";

type DrawingOptions<T> = T extends unknown ? Omit<T, "width" | "height" | "inspect" | "interactive"> : never;
type RenderOptions<T> = T extends unknown ? Omit<T, "legendPlacement"> : never;

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
    DrawingOptions<Parameters<(typeof chartRenderers)[K]>[0]>;
}[ChartKind];
export type ChartRenderOptions = RenderOptions<ChartDrawingOptions>;

export { preservesAspectRatio } from "./render-size";

import { chartRenderHeight as defaultChartRenderHeight, preservesAspectRatio } from "./render-size";

export const chartRenderHeight = (props: ChartRenderOptions, sizing: { contentHeight?: boolean } = {}): number =>
  props.kind === "heatmap" && props.layout === "calendar" ? calendarLayout(props).height : defaultChartRenderHeight(props, sizing);

/** Shared logical SVG renderer; callbacks and browser interaction stay with the Solid host. */
export const renderChartSvg = (
  props: ChartDrawingOptions,
  width: number,
  height: number,
  mapViewport?: MapViewport,
  timelineViewport?: StateTimelineDomain,
  renderLocale?: string,
): string => {
  if (props.kind === "treemap" || props.kind === "pareto")
    return responsiveChartSvg(
      props.kind === "treemap"
        ? chartRenderers.treemap({ ...props, width, height, inspect: true })
        : chartRenderers.pareto({ ...props, width, height, inspect: true }),
    );
  if (props.kind === "heatmap" && props.layout === "calendar") return chartRenderers.heatmap({ ...props, width, height, inspect: true });
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
  if (kind === "funnel")
    return responsiveChartSvg(
      renderFunnelSvg({ ...(opts as FunnelOptions), locale: (opts as FunnelOptions).locale ?? renderLocale, width, height, inspect: true }),
    );
  if (kind === "hbar") return responsiveChartSvg(renderHbarSvg({ ...(opts as HorizontalBarOptions), width, height, inspect: true }));
  if (kind === "waterfall")
    return responsiveChartSvg(
      renderWaterfallSvg(
        {
          ...(opts as WaterfallOptions),
          displayWidth: (opts as WaterfallOptions).displayWidth ?? 296,
          locale: (opts as WaterfallOptions).locale ?? renderLocale,
          width,
          height,
          inspect: true,
        },
        true,
      ),
    );
  if (kind === "area")
    return responsiveChartSvg(
      renderAreaSvg({
        ...(opts as AreaOptions),
        locale: (opts as AreaOptions).locale ?? renderLocale,
        legend: false,
        width,
        height,
        inspect: true,
      }),
    );
  if (kind === "bar") return responsiveChartSvg(renderBarChartSvg({ ...(opts as BarChartOptions), width, height, inspect: true }));
  // Ordinary lines retain their existing time-axis adapter; detailed lines draw calendar ticks directly.
  const timeAxis = props.kind === "line" && !lineDetailsEnabled(props) ? props.timeAxis : undefined;
  const timeDomain = timeAxis && props.kind === "line" ? lineTimeDomain(props) : undefined;
  let svg = (chartRenderers[kind] as (o: unknown) => string)({
    ...opts,
    ...(kind === "line" ? { locale: (opts as { locale?: string }).locale ?? renderLocale } : {}),
    ...(props.kind === "line" && lineDetailsEnabled(props) ? { timeAxis: props.timeAxis } : {}),
    ...(timeDomain && props.kind === "line" ? { xAxis: { ...props.xAxis, domain: timeDomain, format: () => "" } } : {}),
    ...(props.kind === "line" && props.legend && (props.legendPlacement === "top-start" || lineDetailsEnabled(props))
      ? { legend: false }
      : {}),
    ...(kind === "map" ? { viewport: DEFAULT_MAP_VIEWPORT } : {}),
    width,
    height,
    inspect: true,
  });
  if (props.kind === "line" && props.maxGap !== undefined && !lineDetailsEnabled(props)) {
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
  if (props.marker) xs.push(props.marker.at);
  if (!xs.length) return undefined;
  const lo = Math.min(...xs),
    hi = Math.max(...xs);
  return lo < hi ? [lo, hi] : undefined;
};

export type ChartSize = { width: number; height: number };
export type ChartScene = ChartSize & { kind: ChartKind; svg: string };
/** Lay out a chart in a fixed logical coordinate space, without browser measurement. */
export const layout = (spec: ChartDrawingOptions, size: ChartSize): ChartScene => ({
  ...size,
  kind: spec.kind,
  svg: renderChartSvg(spec, size.width, size.height),
});
export const toSvg = (scene: ChartScene): string => scene.svg;
