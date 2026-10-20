import { Map, type MapOptions, setWorkerUrl } from "maplibre-gl";
import workerUrl from "./map-view-worker.js" with { type: "file" };

export function createMap(options: MapOptions): Map {
  setWorkerUrl(new URL(workerUrl, import.meta.url).href);
  const map = new Map(options);
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  // The shared overlay projects a flat, north-up Mercator plane even if a style requests a globe.
  map.on("style.load", () => map.setProjection({ type: "mercator" }));
  return map;
}
