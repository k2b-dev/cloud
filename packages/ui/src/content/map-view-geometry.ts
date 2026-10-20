import type { MapViewFrameProps, MapViewLine, MapViewMarker, MapViewPoint } from "./map-view-types";

export const MIN_SPAN = 256 / (512 * 2 ** 16);
export const EARTH_CIRCUMFERENCE = 40075016.686;
/** Room around the fitted geometry: clears the floating controls, the notice, the scale bar and the attribution. */
export const DEFAULT_PADDING = 64;
/** Phones are first-class: pin separation is decided from the narrowest common screen up, so it holds at every width. */
const PHONE_WIDTH = 320;
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
  /** The fitted width on a 320 px phone: pins are kept apart from this scale up, so they never cover each other there. */
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
type PinOffset = { dx: number; dy: number };
type PlacedPin = { id: string; x: number; y: number; dx: number; dy: number };
const PIN_SPACING = 28;
// An attached hit may touch its stop's halo, as in the approved mockup, but never cover the stop's mark.
const ATTACHED_SPACING = 20;

/**
 * The smallest distance between two drawn pins at every width the map can have: the geographic gap `g` (px at the
 * phone fit) grows with the fitted width by r in [1, rMax], the offsets `o` stay in px. |g·r + o| is smallest at one r.
 */
const closest = (gx: number, gy: number, ox: number, oy: number, rMax: number): number => {
  const gg = gx * gx + gy * gy;
  const r = gg === 0 ? 1 : Math.min(rMax, Math.max(1, -(gx * ox + gy * oy) / gg));
  return Math.hypot(gx * r + ox, gy * r + oy);
};

/** Deterministic places around a point: the mockup's two rings first, then wider rings for dense clusters. */
const candidateOffsets = (count: number): PinOffset[] => {
  const angles = [-45, 45, 135, -135, 0, 90, 180, -90];
  // Ring k holds 8k places, so this many rings fit every pin of a cluster at one point with room to spare.
  const rings = Math.ceil(Math.sqrt(count / 4)) + 2;
  const result: PinOffset[] = [];
  for (let ring = 1; ring <= rings; ring++) {
    const steps = ring <= 2 ? angles : Array.from({ length: 8 * ring }, (_, index) => -45 + (360 * index) / (8 * ring));
    for (const angle of steps)
      result.push({
        dx: PIN_SPACING * ring * Math.cos((angle * Math.PI) / 180),
        dy: PIN_SPACING * ring * Math.sin((angle * Math.PI) / 180),
      });
  }
  return result;
};

const pinPlaces = (sortedMarkers: MapViewMarker[], frame: MapFrame, zoomFactor: number) => {
  const scale = (frame.overlapWidth / frame.spanX) * zoomFactor;
  // A drop pin's mark sits above its point (its tip is on the point); collisions use the middle of the mark.
  return (marker: MapViewMarker) => {
    const p = projectPoint(marker.point);
    return { x: (p.x - frame.minX) * scale, y: (p.y - frame.minY) * scale - (marker.mark === undefined ? 14 : 0) };
  };
};

/**
 * Pin offsets in px, decided from the data alone: at the phone fit and checked for every wider fit up to the widest
 * one, so they hold at any width. `zoomFactor` is 2^(live zoom - fitted zoom): 1 for the server frame, the first client
 * frame and the untouched live map, so all three agree; when the person zooms, separation is decided for the new scale.
 */
export function pinOffsets(sortedMarkers: MapViewMarker[], frame: MapFrame, zoomFactor = 1): Map<string, PinOffset> {
  const position = pinPlaces(sortedMarkers, frame, zoomFactor);
  const rMax = Math.max(1, frame.referenceWidth / frame.overlapWidth);
  const candidates = candidateOffsets(sortedMarkers.length);
  const reachOf = (offset: PinOffset) => Math.hypot(offset.dx, offset.dy);
  const furthest = reachOf(candidates[candidates.length - 1]!);
  const placed: (PlacedPin & { reach: number })[] = [];
  const offsets = new Map<string, PinOffset>();
  // Pins at one point search on from where the previous one found its place, so a dense cluster costs one pass.
  const searchFrom = new Map<string, number>();
  const place = (marker: MapViewMarker, preferred: PinOffset, anchorId?: string) => {
    const p = position(marker);
    // Two pins whose points are further apart than their offsets plus one pin never meet at a wider fit
    // (|g·r + o| ≥ |g| − |o| for r ≥ 1), so only the pins near this one are checked, once per pin.
    const near = placed.filter((other) => Math.hypot(p.x - other.x, p.y - other.y) < furthest + other.reach + PIN_SPACING);
    const clear = (offset: PinOffset, anchor?: string) =>
      near.every(
        (other) =>
          closest(p.x - other.x, p.y - other.y, offset.dx - other.dx, offset.dy - other.dy, rMax) >=
          (other.id === anchor ? ATTACHED_SPACING : PIN_SPACING) - 1e-9,
      );
    let offset = preferred;
    if (!clear(preferred, anchorId)) {
      const key = `${Math.round(p.x)},${Math.round(p.y)}`;
      const first = searchFrom.get(key) ?? 0;
      const found = candidates.findIndex((candidate, index) => index >= first && clear(candidate));
      offset = candidates[found] ?? candidates[candidates.length - 1]!;
      searchFrom.set(key, found < 0 ? candidates.length : found + 1);
    }
    offsets.set(marker.id, offset);
    const pin = { id: marker.id, ...p, ...offset, reach: reachOf(offset) };
    placed.push(pin);
    return pin;
  };
  // Stops come first in mark order; a later stop that would cover an earlier one (such as "+" beside C) moves aside.
  const stops = sortedMarkers.filter(isStop).map((stop) => place(stop, { dx: 0, dy: 0 }));
  for (const marker of sortedMarkers.filter((marker) => !isStop(marker))) {
    const p = position(marker);
    const anchor = stops.find((stop) => Math.hypot(p.x - stop.x - stop.dx, p.y - stop.y - stop.dy) < PIN_SPACING);
    // The attachment sits top right of where the stop is drawn, wherever the hit lies around it.
    place(marker, anchor ? { dx: anchor.x + anchor.dx + 17 - p.x, dy: anchor.y + anchor.dy - 17 - p.y } : { dx: 0, dy: 0 }, anchor?.id);
  }
  return offsets;
}
/**
 * The touch hit radius of each pin in px: up to 22 px (a 44 px target), but never into a neighbour's visible mark
 * (radius up to 14 px) at any width, so a tap on a visible pin always reaches it.
 */
export function pinHitRadii(
  sortedMarkers: MapViewMarker[],
  frame: MapFrame,
  offsets: Map<string, PinOffset>,
  zoomFactor = 1,
): Map<string, number> {
  const position = pinPlaces(sortedMarkers, frame, zoomFactor);
  const rMax = Math.max(1, frame.referenceWidth / frame.overlapWidth);
  const places = sortedMarkers.map((marker) => ({ id: marker.id, ...position(marker), ...(offsets.get(marker.id) ?? { dx: 0, dy: 0 }) }));
  return new Map(
    places.map((place) => {
      let nearest = Infinity;
      for (const other of places)
        if (other !== place)
          nearest = Math.min(nearest, closest(place.x - other.x, place.y - other.y, place.dx - other.dx, place.dy - other.dy, rMax));
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
