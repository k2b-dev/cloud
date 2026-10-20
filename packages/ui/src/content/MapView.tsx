import type { Map as LiveMap } from "maplibre-gl";
import { children, createEffect, createMemo, createSignal, type JSX, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { Button, IconButton } from "../actions/Button";
import { prefersReducedMotion } from "../motion";
import { MapFootRow, MapGeometry, type MapScale, referenceScale, selectedMarker } from "./MapViewFrame";
import {
  DEFAULT_PADDING,
  fitCamera,
  type MapFrame,
  mapFrame,
  metersPerPixel,
  pinOffsets,
  scaleBar,
  sortMarkers,
  unprojectPoint,
} from "./map-view-geometry";
import { useMapViewMessages } from "./map-view-messages";
import type { MapViewMarker, MapViewProps, MapViewStyle } from "./map-view-types";

export type { MapViewProps } from "./map-view-types";

type MapState = "static" | "loading" | "ready" | "error" | "no-webgl" | "empty";

function supportsWebgl(): boolean {
  try {
    const canvas = document.createElement("canvas");
    // MapLibre 6 draws with WebGL 2 only; a browser with just WebGL 1 gets the static frame and the notice.
    const gl = canvas.getContext("webgl2");
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** A static server frame enhanced with a same-origin MapLibre worker only after it enters the viewport. */
export function MapView(props: MapViewProps): JSX.Element {
  const messages = useMapViewMessages();
  const frame = createMemo(() => mapFrame(props, props.height, props.padding ?? DEFAULT_PADDING));
  const selected = createMemo(() => selectedMarker(props.markers ?? [], props.selectedId));
  const selectedId = createMemo(() => selected()?.id);
  const notice = children(() => props.notice);
  const empty = children(() => props.empty);
  const [state, setState] = createSignal<MapState>("static");
  const [dark, setDark] = createSignal(false);
  const [boxStyle, setBoxStyle] = createSignal<JSX.CSSProperties>();
  const [liveScale, setLiveScale] = createSignal<MapScale>();
  const [measuredWidth, setMeasuredWidth] = createSignal<number>();
  // The zoom the person chose, once they zoomed; pin separation follows it relative to the current fit.
  const [chosenZoom, setChosenZoom] = createSignal<number>();
  const zoomFactor = createMemo(() => {
    const zoom = chosenZoom();
    const f = frame();
    const width = measuredWidth();
    if (zoom === undefined || !f || width === undefined) return 1;
    return 2 ** (zoom - fitCamera(f, width, props.padding ?? DEFAULT_PADDING).zoom);
  });
  const [needsReload, setNeedsReload] = createSignal(false);
  // The server picks the scale bar for the widest fit; once the width is known, the bar names a distance that fits it.
  const scale = createMemo((): MapScale | undefined => {
    const f = frame();
    if (!f) return undefined;
    const live = liveScale();
    if (live) return live;
    const width = measuredWidth();
    if (width === undefined) return referenceScale(f, props.padding ?? DEFAULT_PADDING);
    const camera = fitCamera(f, width, props.padding ?? DEFAULT_PADDING);
    const mpp = metersPerPixel(camera.center[1], camera.zoom);
    const bar = scaleBar(mpp);
    return { label: bar.label, width: `${bar.meters / mpp}px` };
  });
  const resolvedStyle = (): MapViewStyle => {
    const source = props.style;
    return typeof source === "object" && "dark" in source ? (dark() ? source.dark : source.light) : source;
  };
  let root!: HTMLDivElement;
  let live!: HTMLDivElement;
  let info!: HTMLDivElement;
  let map: LiveMap | undefined;
  let currentStyle: MapViewStyle | undefined;
  let disposed = false;
  let visible = false;
  let mounted = false;
  let touched = false;
  let replacingStyle = false;
  let generation = 0;
  let intersection: IntersectionObserver | undefined;
  let resize: ResizeObserver | undefined;
  let infoResize: ResizeObserver | undefined;
  const themes: MutationObserver[] = [];

  // From the person's first camera change on, the camera stays theirs; pin separation follows its zoom.
  const touch = () => {
    touched = true;
    if (map) setChosenZoom(map.getZoom());
  };
  const removeMap = () => {
    generation++;
    const previous = map;
    map = undefined;
    previous?.remove();
    setBoxStyle(undefined);
    setLiveScale(undefined);
    setChosenZoom(undefined);
    currentStyle = undefined;
    replacingStyle = false;
  };
  // MapLibre wraps its center across the antimeridian; geometry is drawn in the world copy nearest the camera.
  const worldCopy = (live: LiveMap, f: MapFrame): number => Math.round((live.getCenter().lng + 180) / 360 - (f.minX + f.spanX / 2));
  const syncOverlay = () => {
    const f = frame();
    if (!map || !f || state() !== "ready") return;
    const copy = worldCopy(map, f);
    const a = unprojectPoint(f.minX + copy, f.minY);
    const b = unprojectPoint(f.minX + copy + f.spanX, f.minY + f.spanY);
    const top = map.project([a.lon, a.lat]);
    const bottom = map.project([b.lon, b.lat]);
    setBoxStyle({
      left: `${top.x}px`,
      top: `${top.y}px`,
      width: `${bottom.x - top.x}px`,
      height: `${bottom.y - top.y}px`,
      transform: "none",
    });
    const mpp = metersPerPixel(map.getCenter().lat, map.getZoom());
    const bar = scaleBar(mpp);
    setLiveScale({ label: bar.label, width: `${bar.meters / mpp}px` });
  };
  const refit = () => {
    const f = frame();
    if (map && f && !touched) map.jumpTo(fitCamera(f, root.clientWidth, props.padding ?? DEFAULT_PADDING));
    syncOverlay();
  };
  const start = async () => {
    if (disposed || !visible || !frame()) return;
    removeMap();
    touched = false;
    if (!supportsWebgl()) {
      setState("no-webgl");
      return;
    }
    const attempt = generation;
    setState("loading");
    const fail = () => {
      if (disposed || attempt !== generation) return;
      removeMap();
      setState("error");
    };
    let engine: typeof import("./map-view-live");
    try {
      engine = await import("./map-view-live");
    } catch {
      // The map code did not load, for example because the page outlived a release that removed its files.
      // Importing the same address again cannot help; a reload fetches the current page and its map code.
      if (disposed || attempt !== generation) return;
      setNeedsReload(true);
      fail();
      return;
    }
    try {
      const { createMap } = engine;
      if (disposed || attempt !== generation) return;
      const f = frame();
      if (!f) return;
      currentStyle = resolvedStyle();
      const t = messages();
      const instance = createMap({
        container: live,
        style: currentStyle,
        ...fitCamera(f, root.clientWidth, props.padding ?? DEFAULT_PADDING),
        attributionControl: false,
        cooperativeGestures: true,
        dragRotate: false,
        // Shift-drag box zoom needs MapLibre's own stylesheet for its rectangle and starts without an input event.
        boxZoom: false,
        pitchWithRotate: false,
        touchPitch: false,
        maxPitch: 0,
        bearing: 0,
        pitch: 0,
        keyboard: true,
        trackResize: false,
        // MapLibre's own gestures (keyboard and double-click zoom, inertia) follow the same choice as our buttons.
        // The value is read when the map starts; MapLibre keeps one setting for all maps on the page.
        reduceMotion: prefersReducedMotion(),
        locale: {
          "Map.Title": t.canvasTitle,
          "CooperativeGesturesHandler.WindowsHelpText": t.gestureWindows,
          "CooperativeGesturesHandler.MacHelpText": t.gestureMac,
          "CooperativeGesturesHandler.MobileHelpText": t.gestureMobile,
        },
      });
      map = instance;
      instance.on("error", (event) => {
        // Tile and source errors name their source and leave the map usable; a style that does not load does not.
        const styleFailed = !("sourceId" in event) && !("tile" in event);
        if (styleFailed && (state() === "loading" || replacingStyle)) fail();
      });
      instance.on("style.load", () => {
        replacingStyle = false;
      });
      instance.on("load", () => {
        if (disposed || attempt !== generation) return;
        setState("ready");
        refit();
      });
      instance.on("movestart", (event) => {
        if (event.originalEvent) touch();
      });
      instance.on("move", syncOverlay);
      // Pin separation is decided again once a zoom ends, not on every animation frame.
      instance.on("zoomend", () => {
        if (map === instance && touched) setChosenZoom(instance.getZoom());
      });
      instance.on("resize", syncOverlay);
    } catch {
      fail();
    }
  };
  const clearSelectedPin = () => {
    const marker = selected();
    if (!marker || state() !== "ready" || !map) return;
    const f = frame();
    const lon = marker.point.lon + (f ? worldCopy(map, f) * 360 : 0);
    const p = map.project([lon, marker.point.lat]);
    const offset = f ? pinOffsets(sortMarkers(props.markers ?? []), f, zoomFactor(), props.ownLocation?.point).get(marker.id) : undefined;
    const x = p.x + (offset?.dx ?? 0);
    const y = p.y + (offset?.dy ?? 0);
    const w = root.clientWidth;
    const h = root.clientHeight;
    const tile = info.getBoundingClientRect();
    const bounds = root.getBoundingClientRect();
    const tileTop = tile.top - bounds.top - 8;
    const covered =
      tile.height > 0 &&
      x >= tile.left - bounds.left - 8 &&
      x <= tile.right - bounds.left + 8 &&
      y >= tileTop &&
      y <= tile.bottom - bounds.top + 8;
    if (!covered && x >= 16 && x <= w - 16 && y >= 16 && y <= h - 16) return;
    touch();
    // Put the drawn pin, offset included, in the free band above the tile.
    const targetX = w / 2;
    const targetY = tile.height > 0 ? tileTop / 2 : h / 2;
    const target = map.unproject([x + w / 2 - targetX, y + h / 2 - targetY]);
    const camera = { center: [target.lng, target.lat] satisfies [number, number] };
    if (prefersReducedMotion()) map.jumpTo(camera);
    else map.easeTo(camera);
  };
  onMount(() => {
    mounted = true;
    const theme = () => setDark(!!root.closest('.dark, .k2b-dark, [data-theme="dark"]'));
    theme();
    for (let ancestor: Element | null = root; ancestor; ancestor = ancestor.parentElement) {
      const observer = new MutationObserver(theme);
      observer.observe(ancestor, { attributes: true, attributeFilter: ["class", "data-theme"] });
      themes.push(observer);
    }
    setMeasuredWidth(root.clientWidth);
    resize = new ResizeObserver(() => {
      setMeasuredWidth(root.clientWidth);
      map?.resize();
      refit();
    });
    resize.observe(root);
    infoResize = new ResizeObserver(clearSelectedPin);
    infoResize.observe(info);
    const enter = () => {
      visible = true;
      intersection?.disconnect();
      if (frame()) void start();
    };
    if (!frame()) setState("empty");
    if (typeof IntersectionObserver === "undefined") enter();
    else {
      intersection = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) enter();
        },
        { threshold: 0, rootMargin: "0px" },
      );
      intersection.observe(root);
    }
  });
  createEffect(
    on(
      frame,
      (value) => {
        if (!mounted) return;
        if (!value) {
          removeMap();
          setState("empty");
        } else if (state() === "empty") {
          setState("static");
          if (visible) void start();
        } else refit();
      },
      { defer: true },
    ),
  );
  createEffect(() => {
    const style = resolvedStyle();
    if (state() === "ready" && map && style !== currentStyle) {
      currentStyle = style;
      replacingStyle = true;
      map.setStyle(style);
    }
  });
  createEffect(() => {
    selected();
    state();
    untrack(clearSelectedPin);
  });
  onCleanup(() => {
    disposed = true;
    intersection?.disconnect();
    resize?.disconnect();
    infoResize?.disconnect();
    for (const observer of themes) observer.disconnect();
    removeMap();
  });
  const zoom = (direction: "in" | "out") => {
    if (!map || state() !== "ready") return;
    touch();
    const options = { animate: !prefersReducedMotion() };
    if (direction === "in") map.zoomIn(options);
    else map.zoomOut(options);
  };
  return (
    <div
      ref={root}
      class={`k2b-map-view${props.class ? ` ${props.class}` : ""}`}
      style={{ height: `${props.height}px` }}
      data-state={state()}
      role="region"
      aria-label={messages().mapLabel}
    >
      <span class="k2b-sr-only">{messages().summary({ count: props.markers?.length ?? 0 })}</span>
      <div ref={live} class="k2b-map-view__live" />
      <Show
        when={frame()}
        fallback={
          <div class="k2b-map-view__empty">
            <Show when={empty()}>
              <span>{empty()}</span>
            </Show>
          </div>
        }
      >
        {(value) => (
          <MapGeometry {...props} frame={value()} boxStyle={boxStyle()} zoomFactor={zoomFactor()} onSelect={props.onSelect} interactive />
        )}
      </Show>
      <div class="k2b-map-view__messages">
        <Show when={notice()}>
          <div class="k2b-map-view__notice">{notice()}</div>
        </Show>
        <Show when={state() === "loading" || state() === "error" || state() === "no-webgl"}>
          <div class="k2b-map-view__status" role="status">
            <i
              aria-hidden="true"
              class={state() === "loading" ? "ti ti-loader-2 k2b-spin" : state() === "error" ? "ti ti-alert-circle" : "ti ti-info-circle"}
            />
            <span>{state() === "loading" ? messages().loading : state() === "error" ? messages().error : messages().noWebgl}</span>
            <Show when={state() === "error"}>
              <Button size="xs" variant="text" onClick={() => (needsReload() ? window.location.reload() : void start())}>
                {needsReload() ? messages().reload : messages().retry}
              </Button>
            </Show>
          </div>
        </Show>
      </div>
      <div class="k2b-map-view__controls">
        <div class="k2b-map-view__zoom">
          <IconButton label={messages().zoomIn} tooltip={false} disabled={state() !== "ready"} onClick={() => zoom("in")}>
            <i class="ti ti-plus" aria-hidden="true" />
          </IconButton>
          <IconButton label={messages().zoomOut} tooltip={false} disabled={state() !== "ready"} onClick={() => zoom("out")}>
            <i class="ti ti-minus" aria-hidden="true" />
          </IconButton>
        </div>
        <Show when={props.onLocate}>
          <IconButton
            class="k2b-map-view__locate"
            tooltip={false}
            label={messages().locate}
            aria-pressed={!!props.ownLocation}
            onClick={() => props.onLocate?.()}
          >
            <i class="ti ti-current-location" aria-hidden="true" />
          </IconButton>
        </Show>
      </div>
      <div class="k2b-map-view__foot">
        <div ref={info} class="k2b-map-view__info" aria-live="polite">
          <Show when={selectedId()} keyed>
            {(_id) => {
              // Keep the tile's state and focus for this selection while its marker data refreshes.
              const initial = selected();
              const current = () => selected() ?? initial;
              const marker: MapViewMarker = {
                get id() {
                  return current()!.id;
                },
                get point() {
                  return current()!.point;
                },
                get mark() {
                  return current()!.mark;
                },
                get label() {
                  return current()!.label;
                },
                get tone() {
                  return current()!.tone;
                },
                get selected() {
                  return current()!.selected;
                },
              };
              return props.infoTile?.(marker);
            }}
          </Show>
        </div>
        <MapFootRow scale={scale()}>{props.attribution}</MapFootRow>
      </div>
    </div>
  );
}
