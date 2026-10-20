import { GEO_MAX_POLYLINE_CHARS, type GeoPoint } from "../../contracts/geo";
import { GeoError, limitExceeded } from "./errors";

const R = 6_371_008.8;
const rad = Math.PI / 180;
const longitudeDelta = (delta: number) => ((delta + 540) % 360) - 180;
export const geoDistance = (a: GeoPoint, b: GeoPoint) => {
  const h =
    Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((longitudeDelta(b.lon - a.lon) * rad) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, h)));
};
export const decodePolyline6 = (encoded: string): GeoPoint[] => {
  if (encoded.length > GEO_MAX_POLYLINE_CHARS) limitExceeded("along.polyline6", GEO_MAX_POLYLINE_CHARS, encoded.length);
  let index = 0,
    lat = 0,
    lon = 0;
  const points: GeoPoint[] = [];
  const value = () => {
    let result = 0,
      factor = 1;
    for (let count = 0; count < 6 && index < encoded.length; count++) {
      const part = encoded.charCodeAt(index++) - 63;
      if (part < 0 || part > 63) throw new GeoError("GEO_UNSUPPORTED_OPTION");
      result += (part & 31) * factor;
      if (part < 32) return result % 2 ? -(result + 1) / 2 : result / 2;
      factor *= 32;
    }
    throw new GeoError("GEO_UNSUPPORTED_OPTION");
  };
  while (index < encoded.length) {
    lat += value();
    lon += value();
    const point = { lat: lat / 1e6, lon: lon / 1e6 };
    if (Math.abs(point.lat) > 90 || Math.abs(point.lon) > 180) throw new GeoError("GEO_UNSUPPORTED_OPTION");
    points.push(point);
  }
  if (points.length < 2) throw new GeoError("GEO_UNSUPPORTED_OPTION");
  return points;
};
const interpolate = (a: GeoPoint, b: GeoPoint, t: number): GeoPoint => ({
  lat: a.lat + (b.lat - a.lat) * t,
  lon: longitudeDelta(a.lon + longitudeDelta(b.lon - a.lon) * t),
});
export const cutGeoWindow = (points: readonly GeoPoint[], fromMeters: number, toMeters: number): GeoPoint[] => {
  const output: GeoPoint[] = [];
  let at = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!,
      length = geoDistance(a, b),
      end = at + length;
    if (length && end > fromMeters && at < toMeters) {
      if (!output.length) output.push(interpolate(a, b, Math.max(0, (fromMeters - at) / length)));
      output.push(interpolate(a, b, Math.min(1, (toMeters - at) / length)));
    }
    at = end;
    if (at >= toMeters) break;
  }
  if (output.length < 2) throw new GeoError("GEO_UNSUPPORTED_OPTION");
  return output;
};
const segmentProjection = (point: GeoPoint, a: GeoPoint, b: GeoPoint) => {
  const scale = Math.cos(((a.lat + b.lat + point.lat) * rad) / 3);
  const x = longitudeDelta(b.lon - a.lon) * rad * R * scale,
    y = (b.lat - a.lat) * rad * R;
  const px = longitudeDelta(point.lon - a.lon) * rad * R * scale,
    py = (point.lat - a.lat) * rad * R;
  const t = x || y ? Math.max(0, Math.min(1, (px * x + py * y) / (x * x + y * y))) : 0;
  return { t, distance: geoDistance(point, interpolate(a, b, t)) };
};
export const locateOnGeoLine = (point: GeoPoint, line: readonly GeoPoint[]) => {
  let at = 0,
    atMeters = 0,
    distanceToRouteMeters = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!,
      b = line[i]!,
      length = geoDistance(a, b),
      match = segmentProjection(point, a, b);
    if (match.distance < distanceToRouteMeters) {
      distanceToRouteMeters = match.distance;
      atMeters = at + match.t * length;
    }
    at += length;
  }
  return { atMeters, distanceToRouteMeters };
};
/** Linear minimum-spacing pass before the more expensive Douglas–Peucker stage. */
const reduceRadialDistance = (points: readonly GeoPoint[], tolerance: number): GeoPoint[] => {
  const line = [points[0]!];
  for (let i = 1; i < points.length - 1; i++) {
    if (geoDistance(line.at(-1)!, points[i]!) > tolerance) line.push(points[i]!);
  }
  line.push(points.at(-1)!);
  return line;
};
/** Iterative Douglas–Peucker: no recursion depth depends on untrusted line length. */
const simplify = (points: readonly GeoPoint[], tolerance: number): GeoPoint[] => {
  const keep = new Set([0, points.length - 1]);
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    let furthest = -1,
      distance = tolerance;
    for (let i = start + 1; i < end; i++) {
      const next = segmentProjection(points[i]!, points[start]!, points[end]!).distance;
      if (next > distance) {
        distance = next;
        furthest = i;
      }
    }
    if (furthest >= 0) {
      keep.add(furthest);
      // This tolerance already cannot fit: stop work and try the next tolerance.
      if (keep.size > 2000) return [...points];
      stack.push([start, furthest], [furthest, end]);
    }
  }
  return [...keep].sort((a, b) => a - b).map((index) => points[index]!);
};
export const simplifyGeoLine = (points: readonly GeoPoint[]) => {
  let toleranceMeters = 0,
    reduced = [...points];
  // Bound quadratic Douglas–Peucker work independently of the decoded input size.
  while (reduced.length > 4000) {
    toleranceMeters = toleranceMeters ? toleranceMeters * 2 : 1;
    reduced = reduceRadialDistance(points, toleranceMeters);
  }
  let line = reduced;
  while (line.length > 2000) {
    toleranceMeters ||= 1;
    line = simplify(reduced, toleranceMeters);
    if (line.length > 2000) toleranceMeters *= 2;
  }
  return { line, toleranceMeters };
};
