import { GEO_MAX_POLYLINE_CHARS, type GeoPoint } from "../../contracts/geo";
import { GeoError, limitExceeded } from "./errors";

const R = 6_371_008.8;
const rad = Math.PI / 180;
const longitudeDelta = (delta: number) => ((delta + 540) % 360) - 180;
export const geoDistance = (a: GeoPoint, b: GeoPoint) => {
  const sinA = Math.sin(a.lat * rad),
    cosA = Math.cos(a.lat * rad);
  const sinB = Math.sin(b.lat * rad),
    cosB = Math.cos(b.lat * rad);
  const delta = longitudeDelta(b.lon - a.lon) * rad,
    cosDelta = Math.cos(delta);
  // atan2 retains the angular distance when haversine would round nearly opposite points to exactly π.
  return R * Math.atan2(Math.hypot(cosB * Math.sin(delta), cosA * sinB - sinA * cosB * cosDelta), sinA * sinB + cosA * cosB * cosDelta);
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
const interpolate = (a: GeoPoint, b: GeoPoint, t: number): GeoPoint => {
  const vector = (p: GeoPoint) => ({
    x: Math.cos(p.lat * rad) * Math.cos(p.lon * rad),
    y: Math.cos(p.lat * rad) * Math.sin(p.lon * rad),
    z: Math.sin(p.lat * rad),
  });
  const from = vector(a),
    to = vector(b);
  const nx = from.y * to.z - from.z * to.y,
    ny = from.z * to.x - from.x * to.z,
    nz = from.x * to.y - from.y * to.x;
  const normal = Math.hypot(nx, ny, nz),
    dot = from.x * to.x + from.y * to.y + from.z * to.z;
  // Exactly opposite endpoints do not define a unique arc; the route must include an intermediate point.
  if (dot < 0 && normal <= 8 * Number.EPSILON) throw new GeoError("GEO_UNSUPPORTED_OPTION");
  if (t === 0 || !normal) return a;
  if (t === 1) return b;
  const angle = Math.atan2(normal, dot) * t,
    cos = Math.cos(angle),
    sin = Math.sin(angle);
  // Rotate from the first endpoint in its tangent direction, without subtracting opposing endpoint weights.
  const x = from.x * cos + ((ny * from.z - nz * from.y) / normal) * sin,
    y = from.y * cos + ((nz * from.x - nx * from.z) / normal) * sin,
    z = from.z * cos + ((nx * from.y - ny * from.x) / normal) * sin;
  return { lat: Math.atan2(z, Math.hypot(x, y)) / rad, lon: Math.atan2(y, x) / rad };
};
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
const segmentProjection = (a: GeoPoint, b: GeoPoint) => {
  const length = geoDistance(a, b) / R;
  const sinA = Math.sin(a.lat * rad),
    cosA = Math.cos(a.lat * rad);
  const deltaB = longitudeDelta(b.lon - a.lon) * rad;
  const bearing = Math.atan2(
    Math.sin(deltaB) * Math.cos(b.lat * rad),
    cosA * Math.sin(b.lat * rad) - sinA * Math.cos(b.lat * rad) * Math.cos(deltaB),
  );
  const sinBearing = Math.sin(bearing),
    cosBearing = Math.cos(bearing);
  return (point: GeoPoint) => {
    if (!length) return { t: 0, distance: geoDistance(point, a) };
    const delta = longitudeDelta(point.lon - a.lon) * rad;
    const sinPoint = Math.sin(point.lat * rad),
      cosPoint = Math.cos(point.lat * rad),
      cosDelta = Math.cos(delta);
    const east = cosPoint * Math.sin(delta),
      north = cosA * sinPoint - sinA * cosPoint * cosDelta;
    // Great-circle along-track and cross-track angles, using one prepared bearing per segment.
    const along = Math.atan2(east * sinBearing + north * cosBearing, sinA * sinPoint + cosA * cosPoint * cosDelta);
    if (along < 0 || along > length) {
      const from = geoDistance(point, a),
        to = geoDistance(point, b);
      return from <= to ? { t: 0, distance: from } : { t: 1, distance: to };
    }
    return { t: along / length, distance: R * Math.asin(Math.min(1, Math.abs(east * cosBearing - north * sinBearing))) };
  };
};
export const locateOnGeoLine = (point: GeoPoint, line: readonly GeoPoint[]) => {
  let at = 0,
    atMeters = 0,
    distanceToRouteMeters = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!,
      b = line[i]!,
      length = geoDistance(a, b),
      match = segmentProjection(a, b)(point);
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
const simplify = (points: readonly GeoPoint[], tolerance: number, pointLimit: number): GeoPoint[] => {
  const keep = new Set([0, points.length - 1]);
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    let furthest = -1,
      distance = tolerance;
    const project = segmentProjection(points[start]!, points[end]!);
    for (let i = start + 1; i < end; i++) {
      const next = project(points[i]!).distance;
      if (next > distance) {
        distance = next;
        furthest = i;
      }
    }
    if (furthest >= 0) {
      keep.add(furthest);
      // This tolerance already cannot fit: stop work and try the next tolerance.
      if (keep.size > pointLimit) return [...points];
      stack.push([start, furthest], [furthest, end]);
    }
  }
  return [...keep].sort((a, b) => a - b).map((index) => points[index]!);
};
export const simplifyGeoLine = (points: readonly GeoPoint[], minimumToleranceMeters = 0, pointLimit = 2000) => {
  let toleranceMeters = minimumToleranceMeters,
    reduced = [...points];
  // Bound quadratic Douglas–Peucker work independently of the decoded input size.
  while (reduced.length > pointLimit * 2) {
    toleranceMeters = toleranceMeters ? toleranceMeters * 2 : 1;
    reduced = reduceRadialDistance(points, toleranceMeters);
  }
  let line = minimumToleranceMeters ? simplify(reduced, toleranceMeters, pointLimit) : reduced;
  while (line.length > pointLimit) {
    toleranceMeters ||= 1;
    line = simplify(reduced, toleranceMeters, pointLimit);
    if (line.length > pointLimit) toleranceMeters *= 2;
  }
  return { line, toleranceMeters };
};
