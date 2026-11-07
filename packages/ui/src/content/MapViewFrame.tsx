import { createMemo, For, type JSX, Show } from "solid-js";
import {
  DEFAULT_PADDING,
  EARTH_CIRCUMFERENCE,
  isStop,
  linePoints,
  type MapFrame,
  mapFrame,
  pinHitRadii,
  pinOffsets,
  projectPoint,
  scaleBar,
  sortMarkers,
  unprojectPoint,
} from "./map-view-geometry";
import { useMapViewMessages } from "./map-view-messages";
import type { MapViewFrameProps, MapViewMarker, MapViewPoint } from "./map-view-types";

export type { MapViewFrameProps } from "./map-view-types";

const S = 1e6;
export const mapNumber = (value: number): string => String(Number(value.toFixed(6)));
export const selectedMarker = (markers: MapViewMarker[], selectedId?: string): MapViewMarker | undefined =>
  selectedId !== undefined ? markers.find((marker) => marker.id === selectedId) : markers.find((marker) => marker.selected);

/** The CSS form of fitCamera's width rule, so the server lays out exactly what MapLibre shows. */
const fittedWidth = (frame: MapFrame, padding: number): string =>
  `max(min(100% - ${2 * padding}px, ${frame.referenceWidth}px), ${frame.minWidth}px)`;

export function frameStyle(frame: MapFrame, padding: number): JSX.CSSProperties {
  return {
    left: "50%",
    top: "50%",
    width: fittedWidth(frame, padding),
    "aspect-ratio": `${frame.spanX} / ${frame.spanY}`,
    transform: "translate(-50%, -50%)",
  };
}
const pointInFrame = (point: MapViewPoint, frame: MapFrame) => {
  const p = projectPoint(point);
  return { x: (p.x - frame.minX) / frame.spanX, y: (p.y - frame.minY) / frame.spanY };
};
const positionStyle = (point: MapViewPoint, frame: MapFrame): JSX.CSSProperties => {
  const p = pointInFrame(point, frame);
  return { left: `${mapNumber(p.x * 100)}%`, top: `${mapNumber(p.y * 100)}%` };
};
const path = (points: MapViewPoint[], frame: MapFrame, closed = false): string =>
  points
    .map((point, index) => {
      const p = projectPoint(point);
      return `${index ? "L" : "M"}${mapNumber((p.x - frame.minX) * S)} ${mapNumber((p.y - frame.minY) * S)}`;
    })
    .join(" ") + (closed && points.length ? " Z" : "");

export function MapGeometry(
  props: MapViewFrameProps & {
    frame: MapFrame;
    boxStyle?: JSX.CSSProperties;
    onSelect?: (id: string) => void;
    /** Pins are buttons in MapView; the standalone frame draws them as labelled images, never focusable. */
    interactive?: boolean;
    /** 2^(live zoom - fitted zoom), so pin separation follows the person's zoom; 1 until then. */
    zoomFactor?: number;
  },
): JSX.Element {
  const messages = useMapViewMessages();
  const markers = createMemo(() => sortMarkers(props.markers ?? []));
  const markerIds = createMemo(() => markers().map((marker) => marker.id));
  const markersById = createMemo(() => new Map(markers().map((marker) => [marker.id, marker])));
  const offsets = createMemo(() => pinOffsets(markers(), props.frame, props.zoomFactor, props.ownLocation?.point));
  const hitRadii = createMemo(() => pinHitRadii(markers(), props.frame, offsets(), props.zoomFactor));
  // Input order decides the fallback selection, as in MapView; sorting is only for drawing and keys.
  const selected = createMemo(() => selectedMarker(props.markers ?? [], props.selectedId));
  const keydown = (event: KeyboardEvent & { currentTarget: HTMLButtonElement }, id: string) => {
    const index = markerIds().indexOf(id);
    let next: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (index + 1) % markers().length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (index + markers().length - 1) % markers().length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = markers().length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    const target = markers()[next];
    if (target) {
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(".k2b-map-view__pin")[next]?.focus({ preventScroll: true });
      props.onSelect?.(target.id);
    }
  };
  return (
    <div class="k2b-map-view__fit" style={props.boxStyle ?? frameStyle(props.frame, props.padding ?? DEFAULT_PADDING)}>
      <svg
        class="k2b-map-view__geometry"
        viewBox={`0 0 ${mapNumber(props.frame.spanX * S)} ${mapNumber(props.frame.spanY * S)}`}
        preserveAspectRatio="none"
        overflow="visible"
        aria-hidden="true"
      >
        <For each={props.areas}>
          {(area) => (
            <path
              class="k2b-map-view__area"
              data-tone={area.tone ?? "accent"}
              d={path(area.polygon, props.frame, true)}
              vector-effect="non-scaling-stroke"
            />
          )}
        </For>
        <For each={props.lines}>
          {(line) => (
            <g class="k2b-map-view__line" data-tone={line.tone ?? "accent"}>
              <Show when={!line.tone || line.tone === "accent" || line.tone === "preview"}>
                <path class="k2b-map-view__casing" d={path(linePoints(line), props.frame)} vector-effect="non-scaling-stroke" />
              </Show>
              <path class="k2b-map-view__stroke" d={path(linePoints(line), props.frame)} vector-effect="non-scaling-stroke" />
            </g>
          )}
        </For>
        <Show when={props.ownLocation}>
          {(location) => {
            const p = () => projectPoint(location().point);
            return (
              <circle
                class="k2b-map-view__accuracy"
                cx={mapNumber((p().x - props.frame.minX) * S)}
                cy={mapNumber((p().y - props.frame.minY) * S)}
                r={mapNumber(
                  ((location().accuracyMeters ?? 0) / (EARTH_CIRCUMFERENCE * Math.cos((location().point.lat * Math.PI) / 180))) * S,
                )}
                vector-effect="non-scaling-stroke"
              />
            );
          }}
        </Show>
      </svg>
      <Show when={props.ownLocation}>
        {(location) => (
          <span
            class="k2b-map-view__me"
            role="img"
            aria-label={messages().ownLocation}
            style={positionStyle(location().point, props.frame)}
          />
        )}
      </Show>
      <div class="k2b-map-view__pins" role="group" aria-label={messages().pins}>
        <For each={markerIds()}>
          {(id) => {
            const marker = () => markersById().get(id)!;
            const name = () => (marker().mark === undefined ? marker().label : `${marker().mark} ${marker().label}`);
            const style = () => ({
              ...positionStyle(marker().point, props.frame),
              "--k2b-map-pin-dx": `${mapNumber(offsets().get(marker().id)?.dx ?? 0)}px`,
              "--k2b-map-pin-dy": `${mapNumber(offsets().get(marker().id)?.dy ?? 0)}px`,
              "--k2b-map-pin-hit": `${mapNumber(hitRadii().get(marker().id) ?? 22)}px`,
            });
            if (!props.interactive)
              return (
                <span
                  class="k2b-map-view__pin"
                  data-id={marker().id}
                  data-tone={marker().tone ?? "accent"}
                  data-stop={isStop(marker()) || undefined}
                  data-drop={marker().mark === undefined || undefined}
                  data-selected={selected()?.id === marker().id || undefined}
                  style={style()}
                  role="img"
                  aria-label={name()}
                >
                  <span aria-hidden="true">{marker().mark}</span>
                </span>
              );
            return (
              <button
                type="button"
                class="k2b-map-view__pin"
                data-id={marker().id}
                data-tone={marker().tone ?? "accent"}
                data-stop={isStop(marker()) || undefined}
                data-drop={marker().mark === undefined || undefined}
                style={style()}
                aria-label={name()}
                aria-pressed={selected()?.id === marker().id}
                tabIndex={(selected() ?? markers()[0])?.id === marker().id ? 0 : -1}
                onKeyDown={(event) => keydown(event, id)}
                onClick={() => props.onSelect?.(marker().id)}
              >
                <span aria-hidden="true">{marker().mark}</span>
              </button>
            );
          }}
        </For>
      </div>
    </div>
  );
}
export type MapScale = { label: string; width: string };
export function referenceScale(frame: MapFrame, padding: number): MapScale {
  const center = unprojectPoint(frame.minX + frame.spanX / 2, frame.minY + frame.spanY / 2);
  const spanMeters = frame.spanX * EARTH_CIRCUMFERENCE * Math.cos((center.lat * Math.PI) / 180);
  const bar = scaleBar(spanMeters / frame.referenceWidth);
  return { label: bar.label, width: `calc(${fittedWidth(frame, padding)} * ${bar.meters / spanMeters})` };
}
export function MapScaleBar(props: { scale: MapScale }): JSX.Element {
  return (
    <div class="k2b-map-view__scale" style={{ width: props.scale.width }}>
      <span>{props.scale.label}</span>
      <div />
    </div>
  );
}
/** The scale bar and the attribution share the bottom row, so a long attribution wraps before it covers the scale. */
export function MapFootRow(props: { scale?: MapScale; children?: JSX.Element }): JSX.Element {
  return (
    <div class="k2b-map-view__foot-row">
      <Show when={props.scale}>{(scale) => <MapScaleBar scale={scale()} />}</Show>
      <div class="k2b-map-view__attribution">{props.children}</div>
    </div>
  );
}
/** Geometry fallback without a browser, canvas, or network. Does not contain a geographic basemap image. */
export function MapViewFrame(props: MapViewFrameProps): JSX.Element {
  const messages = useMapViewMessages();
  const frame = createMemo(() => mapFrame(props, props.height, props.padding ?? DEFAULT_PADDING));
  return (
    <div
      class={`k2b-map-view${props.class ? ` ${props.class}` : ""}`}
      style={{ height: `${props.height}px` }}
      data-state="static"
      role="region"
      aria-label={messages().mapLabel}
    >
      <span class="k2b-sr-only">{messages().summary({ count: props.markers?.length ?? 0 })}</span>
      <Show when={frame()}>{(value) => <MapGeometry {...props} frame={value()} />}</Show>
      <div class="k2b-map-view__foot">
        <MapFootRow scale={frame() ? referenceScale(frame()!, props.padding ?? DEFAULT_PADDING) : undefined}>
          {props.attribution}
        </MapFootRow>
      </div>
    </div>
  );
}
