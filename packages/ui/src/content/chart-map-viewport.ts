import type { MapViewport } from "@k2b/stdlib";

export const DEFAULT_MAP_VIEWPORT: MapViewport = {
  latitude: 0,
  longitude: 0,
  zoom: 0,
};

const MIN_ZOOM = 0;
const MAX_ZOOM = 5;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export const normalizeMapViewport = (viewport: MapViewport | undefined): MapViewport => {
  const zoom = clamp(viewport && Number.isFinite(viewport.zoom) ? viewport.zoom : MIN_ZOOM, MIN_ZOOM, MAX_ZOOM);
  const scale = 2 ** zoom;
  const latitudeLimit = 90 - 90 / scale;
  const longitudeLimit = 180 - 180 / scale;

  return {
    latitude: clamp(viewport && Number.isFinite(viewport.latitude) ? viewport.latitude : 0, -latitudeLimit, latitudeLimit),
    longitude: clamp(viewport && Number.isFinite(viewport.longitude) ? viewport.longitude : 0, -longitudeLimit, longitudeLimit),
    zoom,
  };
};

export const zoomMapViewport = (
  viewport: MapViewport,
  delta: number,
  focus: Pick<MapViewport, "latitude" | "longitude"> = { latitude: 50, longitude: 10 },
): MapViewport =>
  normalizeMapViewport({
    ...viewport,
    ...(viewport.zoom === 0 && delta > 0 ? focus : {}),
    zoom: viewport.zoom + delta,
  });

export const panMapViewport = (viewport: MapViewport, deltaX: number, deltaY: number, width: number, height: number): MapViewport => {
  if (width <= 0 || height <= 0) return normalizeMapViewport(viewport);

  const scale = 2 ** viewport.zoom;
  return normalizeMapViewport({
    latitude: viewport.latitude + (deltaY / height) * (180 / scale),
    longitude: viewport.longitude - (deltaX / width) * (360 / scale),
    zoom: viewport.zoom,
  });
};
