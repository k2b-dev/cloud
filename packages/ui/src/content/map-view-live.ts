/// <reference path="./maplibre-worker.d.ts" />
import { addProtocol, LngLat, Map, type MapOptions, removeProtocol, setWorkerUrl } from "maplibre-gl";
// The build points this at a copy named map-view-worker.js, because @k2b/ssr serves only .js files.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs" with { type: "file" };

import { validateMapGlyphs } from "./map-view-glyphs";

let resourceProtocolId = 0;

export function createMap(options: MapOptions, resourceFailed: () => void): Map {
  setWorkerUrl(new URL(workerUrl, import.meta.url).href);
  // MapLibre 6 substitutes local glyphs on failure and treats HTTP 404 tiles as empty.
  // A map error listener cannot observe either failure. Use its public protocol hook to keep failure explicit,
  // without a second request, global fetch patch, provider URL, or cross-map shared state.
  const protocol = `k2b-map-resource-${++resourceProtocolId}`;
  const lifetime = new AbortController();
  addProtocol(protocol, async (request, cancellation) => {
    const signal = AbortSignal.any([lifetime.signal, cancellation.signal]);
    try {
      const path = request.url.slice(protocol.length + 3);
      const separator = path.indexOf("/");
      const glyph = path.slice(0, separator) === "Glyphs";
      const response = await fetch(decodeURIComponent(path.slice(separator + 1)), {
        method: request.method,
        headers: request.headers,
        body: request.body,
        credentials: request.credentials ?? "same-origin",
        cache: request.cache,
        referrerPolicy: request.referrerPolicy,
        signal,
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new Error("Map resource failed");
      }
      const data = await response.arrayBuffer();
      signal.throwIfAborted();
      if (glyph) validateMapGlyphs(data);
      return {
        data,
        cacheControl: response.headers.get("cache-control") ?? undefined,
        expires: response.headers.get("expires") ?? undefined,
        etag: response.headers.get("etag") ?? undefined,
      };
    } catch {
      if (!signal.aborted) resourceFailed();
      throw new Error("Map resource failed");
    }
  });
  const clean = () => {
    lifetime.abort();
    removeProtocol(protocol);
  };
  let map: Map;
  try {
    map = new Map({
      ...options,
      transformRequest: async (url, type) => {
        const request = (await options.transformRequest?.(url, type)) ?? { url };
        return type === "Glyphs" || type === "Tile"
          ? { ...request, url: `${protocol}://${type}/${encodeURIComponent(new URL(request.url, location.href).href)}` }
          : request;
      },
      // MapLibre would move a wide or polar fit to keep the poles out of view; the server frame cannot know that rule,
      // so the camera stays where fitCamera puts it and only latitude and zoom keep their ordinary limits.
      transformConstrain: (center, zoom) => ({
        center: new LngLat(center.lng, Math.max(-85.051129, Math.min(85.051129, center.lat))),
        zoom: Math.max(options.minZoom ?? -2, Math.min(options.maxZoom ?? 22, zoom)),
      }),
    });
  } catch (error) {
    clean();
    throw error;
  }
  map.on("remove", clean);
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
