import type { GeoPoint } from "../../contracts/geo";
import { decodePolyline6, simplifyGeoLine } from "./polyline";

export const encodePolyline6 = (points: readonly GeoPoint[]) => {
  let lat = 0,
    lon = 0,
    output = "";
  const encode = (value: number) => {
    let n = value < 0 ? -value * 2 - 1 : value * 2;
    while (n >= 32) {
      output += String.fromCharCode((n % 32) + 95);
      n = Math.floor(n / 32);
    }
    output += String.fromCharCode(n + 63);
  };
  for (const point of points) {
    const nextLat = Math.round(point.lat * 1e6),
      nextLon = Math.round(point.lon * 1e6);
    encode(nextLat - lat);
    encode(nextLon - lon);
    lat = nextLat;
    lon = nextLon;
  }
  return output;
};
export const compactRouteLine = (line: readonly GeoPoint[], tolerance = 0, pointLimit = 2000) => {
  const simplified = simplifyGeoLine([...line], tolerance, pointLimit);
  return { polyline6: encodePolyline6(simplified.line), simplificationToleranceMeters: 2 * simplified.toleranceMeters };
};
export const joinRouteLines = (lines: readonly string[]) => {
  const points: GeoPoint[] = [];
  for (const line of lines) {
    const next = decodePolyline6(line);
    const last = points.at(-1),
      first = next[0]!;
    points.push(...(last && last.lat === first.lat && last.lon === first.lon ? next.slice(1) : next));
  }
  return encodePolyline6(points);
};
