import type { MapViewFrameProps, MapViewLine, MapViewMarker, MapViewPoint } from "./map-view-types";

export const MIN_SPAN = 256 / (512 * 2 ** 16);
export const EARTH_CIRCUMFERENCE = 40075016.686;
/** Room around the fitted geometry: clears the floating controls, the notice, the scale bar and the attribution. */
export const DEFAULT_PADDING = 64;
/** Phones are first-class: pin separation is decided for the narrowest common screen, then holds at every width. */
const PHONE_WIDTH = 390;
/**
 * `referenceWidth` is the fitted width when the container is wide enough; `minWidth` keeps the whole world at least as
 * tall as the map, the smallest zoom MapLibre allows, so a world-scale fit lands where MapLibre puts it.
 */
export type MapFrame = {
  minX: number;
  minY: number;
  spanX: number;
  spanY: number;
  aspect: number;
  referenceWidth: number;
  minWidth: number;
  /** The fitted width on a 390 px phone: pins are kept apart at this scale, so they never cover each other there. */
  overlapWidth: number;
};

export function decodePolyline6(encoded: string): MapViewPoint[] {
  let index = 0;
  let lat = 0;
  let lon = 0;
  const next = () => {
    let value = 0;
    let shift = 0;
    let byte: number;
    do {
      if (index >= encoded.length || shift > 50) throw new RangeError("Invalid polyline6");
      byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0 || byte > 63) throw new RangeError("Invalid polyline6");
      value += (byte & 31) * 2 ** shift;
      shift += 5;
    } while (byte >= 32);
    return value % 2 ? -(value + 1) / 2 : value / 2;
  };
  const points: MapViewPoint[] = [];
  while (index < encoded.length) {
    lat += next();
    lon += next();
    points.push({ lat: lat / 1e6, lon: lon / 1e6 });
  }
  return points;
}

export const linePoints = (line: MapViewLine): MapViewPoint[] => ("points" in line ? line.points : decodePolyline6(line.polyline6));
export function projectPoint(point: MapViewPoint): { x: number; y: number } {
  const lat = (Math.max(-85.051129, Math.min(85.051129, point.lat)) * Math.PI) / 180;
  return { x: (point.lon + 180) / 360, y: (1 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / Math.PI) / 2 };
}
export function unprojectPoint(x: number, y: number): MapViewPoint {
  return { lon: x * 360 - 180, lat: (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI };
}
export function mapFrame(
  geometry: Pick<MapViewFrameProps, "markers" | "lines" | "areas" | "ownLocation" | "fit">,
  height: number,
  padding = DEFAULT_PADDING,
): MapFrame | null {
  const points = (geometry.markers ?? []).map((marker) => marker.point);
  if (geometry.fit !== "markers" || !points.length) {
    for (const line of geometry.lines ?? []) for (const point of linePoints(line)) points.push(point);
    for (const area of geometry.areas ?? []) for (const point of area.polygon) points.push(point);
    if (geometry.ownLocation) points.push(geometry.ownLocation.point);
  }
  if (!points.length) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    const { x, y } = projectPoint(point);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const spanX = Math.max(MIN_SPAN, maxX - minX);
  const spanY = Math.max(MIN_SPAN, maxY - minY);
  minX -= (spanX - (maxX - minX)) / 2;
  minY -= (spanY - (maxY - minY)) / 2;
  const aspect = spanX / spanY;
  const minWidth = spanX * height;
  const referenceWidth = Math.max((height - 2 * padding) * aspect, minWidth);
  const overlapWidth = Math.max(minWidth, Math.min(referenceWidth, PHONE_WIDTH - 2 * padding));
  return { minX, minY, spanX, spanY, aspect, referenceWidth, minWidth, overlapWidth };
}
export function fitCamera(frame: MapFrame, width: number, padding = DEFAULT_PADDING): { center: [number, number]; zoom: number } {
  const w = Math.max(Number.EPSILON, frame.minWidth, Math.min(width - 2 * padding, frame.referenceWidth));
  const center = unprojectPoint(frame.minX + frame.spanX / 2, frame.minY + frame.spanY / 2);
  return { center: [center.lon, center.lat], zoom: Math.log2(w / (frame.spanX * 512)) };
}
export const isStop = (marker: MapViewMarker): boolean => typeof marker.mark === "string" && /^[a-z+]$/i.test(marker.mark);
export function sortMarkers(markers: MapViewMarker[]): MapViewMarker[] {
  const rank = (marker: MapViewMarker): number => {
    if (typeof marker.mark === "number") return 0;
    if (typeof marker.mark === "string" && /^[a-z]$/i.test(marker.mark)) return 1;
    if (marker.mark === "+") return 2;
    return 3;
  };
  return [...markers].sort((a, b) => {
    const group = rank(a) - rank(b);
    if (group) return group;
    if (typeof a.mark === "number" && typeof b.mark === "number") return a.mark - b.mark;
    if (rank(a) === 1) return String(a.mark).toUpperCase().localeCompare(String(b.mark).toUpperCase(), "en");
    return 0;
  });
}
/**
 * `zoomFactor` is 2^(live zoom - fitted zoom): 1 for the server frame, the first client frame and the untouched live map,
 * so all three agree; when the person zooms, the separation is decided again for the new scale.
 */
export function pinOffsets(sortedMarkers: MapViewMarker[], frame: MapFrame, zoomFactor = 1): Map<string, { dx: number; dy: number }> {
  const scale = (frame.overlapWidth / frame.spanX) * zoomFactor;
  const position = (marker: MapViewMarker) => {
    const p = projectPoint(marker.point);
    return { x: (p.x - frame.minX) * scale, y: (p.y - frame.minY) * scale };
  };
  const candidates = [28, 56].flatMap((radius) =>
    [-45, 45, 135, -135, 0, 90, 180, -90].map((angle) => ({
      dx: radius * Math.cos((angle * Math.PI) / 180),
      dy: radius * Math.sin((angle * Math.PI) / 180),
    })),
  );
  const stops = sortedMarkers.filter(isStop);
  const placed: { id: string; x: number; y: number }[] = [];
  const offsets = new Map<string, { dx: number; dy: number }>();
  // Stops come first in mark order; a later stop that would cover an earlier one (such as "+" beside C) moves aside.
  for (const stop of stops) {
    const p = position(stop);
    const free = (candidate: { dx: number; dy: number }) =>
      placed.every((other) => Math.hypot(p.x + candidate.dx - other.x, p.y + candidate.dy - other.y) >= 28 - 1e-9);
    const offset = free({ dx: 0, dy: 0 }) ? { dx: 0, dy: 0 } : (candidates.find(free) ?? { dx: 0, dy: 0 });
    offsets.set(stop.id, offset);
    placed.push({ id: stop.id, x: p.x + offset.dx, y: p.y + offset.dy });
  }
  const stopPosition = new Map(placed.map((stop) => [stop.id, stop]));
  for (const marker of sortedMarkers.filter((marker) => !isStop(marker))) {
    const p = position(marker);
    const anchor = stops.find((stop) => {
      const s = stopPosition.get(stop.id)!;
      return Math.hypot(p.x - s.x, p.y - s.y) < 28;
    });
    // The attachment sits top right of where the stop is drawn, wherever the hit lies around it.
    const at = anchor ? stopPosition.get(anchor.id)! : undefined;
    let offset = at ? { dx: at.x + 17 - p.x, dy: at.y - 17 - p.y } : { dx: 0, dy: 0 };
    // The intentional top-right attachment may overlap its own stop's halo.
    const free = (candidate: typeof offset) =>
      placed.every(
        (other) => other.id === anchor?.id || Math.hypot(p.x + candidate.dx - other.x, p.y + candidate.dy - other.y) >= 28 - 1e-9,
      );
    if (!free(offset)) offset = candidates.find(free) ?? offset;
    offsets.set(marker.id, offset);
    placed.push({ id: marker.id, x: p.x + offset.dx, y: p.y + offset.dy });
  }
  return offsets;
}
/**
 * The touch hit radius of each pin in px: up to 22 px (a 44 px target), but never into a neighbour's visible mark
 * (radius up to 14 px), measured at the same phone scale as the offsets so a tap on a visible pin always reaches it.
 */
export function pinHitRadii(
  sortedMarkers: MapViewMarker[],
  frame: MapFrame,
  offsets: Map<string, { dx: number; dy: number }>,
  zoomFactor = 1,
): Map<string, number> {
  const scale = (frame.overlapWidth / frame.spanX) * zoomFactor;
  const places = sortedMarkers.map((marker) => {
    const p = projectPoint(marker.point);
    const o = offsets.get(marker.id) ?? { dx: 0, dy: 0 };
    return { id: marker.id, x: (p.x - frame.minX) * scale + o.dx, y: (p.y - frame.minY) * scale + o.dy };
  });
  return new Map(
    places.map((place) => {
      let nearest = Infinity;
      for (const other of places) if (other !== place) nearest = Math.min(nearest, Math.hypot(place.x - other.x, place.y - other.y));
      return [place.id, Math.max(12, Math.min(22, nearest - 14))];
    }),
  );
}
export const metersPerPixel = (lat: number, zoom: number): number =>
  (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);
export function scaleBar(mpp: number, maxPx = 96): { meters: number; label: string } {
  const maximum = mpp * maxPx;
  const magnitude = 10 ** Math.floor(Math.log10(maximum));
  const meters = ([5, 2, 1].find((value) => value * magnitude <= maximum) ?? 1) * magnitude;
  return { meters, label: meters >= 1000 ? `${meters / 1000} km` : `${Number(meters.toPrecision(12))} m` };
}
