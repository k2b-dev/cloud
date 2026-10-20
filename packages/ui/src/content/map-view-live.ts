import { LngLat, Map, type MapOptions, setWorkerUrl } from "maplibre-gl";
import workerUrl from "./map-view-worker.js" with { type: "file" };

export function createMap(options: MapOptions): Map {
  setWorkerUrl(new URL(workerUrl, import.meta.url).href);
  const map = new Map({
    ...options,
    // MapLibre would move a wide or polar fit to keep the poles out of view; the server frame cannot know that rule,
    // so the camera stays where fitCamera puts it and only latitude and zoom keep their ordinary limits.
    transformConstrain: (center, zoom) => ({
      center: new LngLat(center.lng, Math.max(-85.051129, Math.min(85.051129, center.lat))),
      zoom: Math.max(options.minZoom ?? -2, Math.min(options.maxZoom ?? 22, zoom)),
    }),
  });
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
