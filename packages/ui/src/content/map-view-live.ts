/// <reference path="./maplibre-worker.d.ts" />
import { addProtocol, LngLat, Map, type MapOptions, removeProtocol, setWorkerUrl } from "maplibre-gl";
// The build points this at a copy named map-view-worker.js, because @k2b/ssr serves only .js files.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs" with { type: "file" };

export function createMap(options: MapOptions, onResourceError: () => void): Map {
  setWorkerUrl(new URL(workerUrl, import.meta.url).href);
  // MapLibre catches glyph fetch failures and silently renders a fallback font. Use its
  // public protocol hook so the host can retain geometry and offer a visible retry.
  const protocol = `k2b-glyph-${crypto.randomUUID()}`;
  addProtocol(protocol, async (params, controller) => {
    try {
      const url = new URL(params.url).searchParams.get("url");
      if (!url) throw new Error("Map glyph unavailable");
      const response = await fetch(url, {
        headers: params.headers,
        credentials: params.credentials ?? "same-origin",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Map glyph unavailable");
      return { data: await response.arrayBuffer() };
    } catch {
      if (!controller.signal.aborted) onResourceError();
      throw new Error("Map glyph unavailable");
    }
  });
  let map: Map;
  try {
    map = new Map({
      ...options,
      async transformRequest(url, type) {
        const request = (await options.transformRequest?.(url, type)) ?? { url };
        return type === "Glyphs"
          ? { ...request, url: `${protocol}://glyph?url=${encodeURIComponent(new URL(request.url, document.baseURI).href)}` }
          : request;
      },
      // MapLibre would move a wide or polar fit to keep the poles out of view; the server frame cannot know that rule,
      // so the camera stays where fitCamera puts it and only latitude and zoom keep their ordinary limits.
      transformConstrain: (center, zoom) => ({
        center: new LngLat(center.lng, Math.max(-85.051129, Math.min(85.051129, center.lat))),
        zoom: Math.max(options.minZoom ?? -2, Math.min(options.maxZoom ?? 22, zoom)),
      }),
    });
  } catch (cause) {
    removeProtocol(protocol);
    throw cause;
  }
  map.on("remove", () => removeProtocol(protocol));
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  // The shared overlay projects a flat, north-up Mercator plane even if a style requests a globe.
  // Terrain would lift features off that plane, so a style's terrain is switched off as well.
  map.on("style.load", () => {
    map.setProjection({ type: "mercator" });
    if (map.getTerrain()) map.setTerrain(null);
  });
  return map;
}
