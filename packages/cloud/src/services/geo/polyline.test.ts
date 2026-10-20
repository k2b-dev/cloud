import { expect, test } from "bun:test";
import { GEO_MAX_POLYLINE_CHARS } from "../../contracts/geo";
import { cutGeoWindow, decodePolyline6, geoDistance, locateOnGeoLine, simplifyGeoLine } from "./polyline";
import { encodeGeoTestLine } from "./geo.test-fixture";
test("polyline6 preserves negative coordinates, detects malformed and truncated values", () => {
  const points = [
    { lat: 35.14, lon: -89.94 },
    { lat: 35.145, lon: -89.93 },
    { lat: 35.15, lon: -89.92 },
  ];
  expect(decodePolyline6(encodeGeoTestLine(points))).toEqual(points);
  for (const value of ["_", "?", "~~~~~~", "\u0000\u0000"]) expect(() => decodePolyline6(value)).toThrow();
});
test("window interpolation and route position are in meters", () => {
  const points = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 1 },
  ];
  const cut = cutGeoWindow(points, 20000, 50000);
  expect(geoDistance(cut[0]!, cut.at(-1)!)).toBeCloseTo(30000, 0);
  expect(locateOnGeoLine({ lat: 0.001, lon: 0.3 }, points)).toMatchObject({
    atMeters: expect.any(Number),
    distanceToRouteMeters: expect.any(Number),
  });
  expect(locateOnGeoLine({ lat: 0, lon: 0.3 }, points).atMeters).toBeCloseTo(33358.5, 0);
  expect(() => cutGeoWindow(points, 200000, 250000)).toThrow();
});
test("window interpolation follows great-circle distance on long diagonal segments", () => {
  const cut = cutGeoWindow(
    [
      { lat: 0, lon: 0 },
      { lat: 80, lon: 80 },
    ],
    0,
    100000,
  );
  expect(Math.abs(geoDistance(cut[0]!, cut[1]!) - 100000)).toBeLessThanOrEqual(1);
});
test("cut first and simplify dense lines to at most 2,000 points", () => {
  const points = Array.from({ length: 10001 }, (_, i) => ({ lat: 49 + Math.sin(i) * 0.0001, lon: 12 + i * 0.00001 }));
  const decoded = decodePolyline6(encodeGeoTestLine(points));
  expect(decoded.length).toBe(10001);
  const cut = cutGeoWindow(decoded, 1000, 190000),
    result = simplifyGeoLine(cut);
  expect(result.line.length).toBeLessThanOrEqual(2000);
  expect(result.toleranceMeters).toBeGreaterThan(0);
  expect(result.line[0]).toEqual(cut[0]);
  expect(result.line.at(-1)).toEqual(cut.at(-1));
});
test("longitude wrapping follows the short path across the dateline", () => {
  const line = [
    { lat: 0, lon: 179.9 },
    { lat: 0, lon: -179.9 },
  ];
  expect(geoDistance(line[0]!, line[1]!)).toBeLessThan(23000);
  const cut = cutGeoWindow(line, 5000, 10000);
  expect(geoDistance(cut[0]!, cut[1]!)).toBeCloseTo(5000, 0);
});
test("maximum-size adversarial zigzag simplifies in under two seconds", () => {
  // Both deltas fit one character: two characters per vertex is the maximum density.
  // Adjacent vertices exceed the initial 1 m tolerance, forcing worst-case DP splits.
  const points = Array.from({ length: Math.floor(GEO_MAX_POLYLINE_CHARS / 2) }, (_, i) => ({
    lat: (i % 2) * 0.000014,
    lon: i * 0.000001,
  }));
  const encoded = encodeGeoTestLine(points);
  expect(encoded.length).toBe(GEO_MAX_POLYLINE_CHARS);
  const decoded = decodePolyline6(encoded);
  const start = performance.now();
  const result = simplifyGeoLine(decoded);
  expect(performance.now() - start).toBeLessThan(2000);
  expect(result.line.length).toBeLessThanOrEqual(2000);
  expect(result.line[0]).toEqual(decoded[0]);
  expect(result.line.at(-1)).toEqual(decoded.at(-1));
  expect(result.toleranceMeters).toBeGreaterThan(0);
});
