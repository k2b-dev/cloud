import { describe, expect, test } from "bun:test";
import {
  decodePolyline6,
  fitCamera,
  MIN_SPAN,
  mapFrame,
  metersPerPixel,
  pinOffsets,
  projectPoint,
  scaleBar,
  sortMarkers,
  unprojectPoint,
} from "./map-view-geometry";
import type { MapViewMarker } from "./map-view-types";

const marker = (id: string, mark?: string | number, lat = 48.4, lon = 10): MapViewMarker => ({ id, mark, point: { lat, lon }, label: id });
describe("MapView geometry", () => {
  test("decodes the known Google line at precision six, latitude first", () => {
    expect(decodePolyline6("_izlhA~rlgdF_{geC~ywl@_kwzCn`{nI")).toEqual([
      { lat: 38.5, lon: -120.2 },
      { lat: 40.7, lon: -120.95 },
      { lat: 43.252, lon: -126.453 },
    ]);
    expect(decodePolyline6("")).toEqual([]);
    expect(() => decodePolyline6("_")).toThrow(RangeError);
    expect(() => decodePolyline6("??_")).toThrow(RangeError);
  });
  test("Mercator round trips and clamps polar latitudes", () => {
    for (const point of [
      { lat: 48.4, lon: 10 },
      { lat: -70, lon: -160 },
      { lat: 0, lon: 0 },
    ]) {
      const p = projectPoint(point);
      const restored = unprojectPoint(p.x, p.y);
      expect(restored.lat).toBeCloseTo(point.lat, 8);
      expect(restored.lon).toBeCloseTo(point.lon, 8);
    }
    expect(projectPoint({ lat: 90, lon: 0 })).toEqual(projectPoint({ lat: 85.051129, lon: 0 }));
  });
  test("one point has a symmetric minimum box and empty geometry has none", () => {
    const f = mapFrame({ markers: [marker("one")] }, 352)!;
    expect(f.spanX).toBe(MIN_SPAN);
    expect(f.spanY).toBe(MIN_SPAN);
    expect(f.referenceWidth).toBe(256);
    expect(fitCamera(f, 352).zoom).toBeCloseTo(16, 10);
    expect(fitCamera(f, 352).center[0]).toBeCloseTo(10, 10);
    expect(fitCamera(f, 352).center[1]).toBeCloseTo(48.4, 10);
    expect(mapFrame({}, 400)).toBeNull();
  });
  test("fits all vertices at several widths with the same width as CSS", () => {
    const markers = [marker("one", 1), marker("two", 2, 48.42, 10.04)];
    const lines = [
      {
        id: "route",
        points: [
          { lat: 48.39, lon: 9.98 },
          { lat: 48.43, lon: 10.01 },
        ],
      },
    ];
    const areas = [
      {
        id: "area",
        polygon: [
          { lat: 48.44, lon: 10.06 },
          { lat: 48.4, lon: 10.05 },
        ],
      },
    ];
    const ownLocation = { point: { lat: 48.38, lon: 9.97 } };
    const f = mapFrame({ markers, lines, areas, ownLocation }, 400)!;
    for (const width of [240, 390, 768, 1024]) {
      const camera = fitCamera(f, width);
      const center = projectPoint({ lon: camera.center[0], lat: camera.center[1] });
      const scale = 512 * 2 ** camera.zoom;
      expect(f.spanX * scale).toBeCloseTo(Math.min(width - 96, f.referenceWidth), 6);
      for (const point of [...markers.map((m) => m.point), ...lines[0]!.points, ...areas[0]!.polygon, ownLocation.point]) {
        const p = projectPoint(point);
        const x = width / 2 + (p.x - center.x) * scale;
        const y = 200 + (p.y - center.y) * scale;
        expect(x).toBeGreaterThanOrEqual(48 - 1e-6);
        expect(x).toBeLessThanOrEqual(width - 48 + 1e-6);
        expect(y).toBeGreaterThanOrEqual(48 - 1e-6);
        expect(y).toBeLessThanOrEqual(352 + 1e-6);
      }
    }
    expect(mapFrame({ markers, lines, areas, ownLocation, fit: "markers" }, 400)).toEqual(mapFrame({ markers }, 400));
    expect(mapFrame({ lines, fit: "markers" }, 400)).toEqual(mapFrame({ lines }, 400));
    expect(mapFrame({ lines: [{ id: "encoded", polyline6: "_izlhA~rlgdF_{geC~ywl@_kwzCn`{nI" }] }, 400)).not.toBeNull();
  });
  test("sorts numbers, letters, plus and unmarked pins, keeping equal marks stable", () => {
    const pins = [
      marker("empty"),
      marker("plus", "+"),
      marker("B", "B"),
      marker("two", 2),
      marker("one", 1),
      marker("a", "A"),
      marker("one-again", 1),
    ];
    expect(sortMarkers(pins).map((m) => m.id)).toEqual(["one", "one-again", "two", "a", "B", "plus", "empty"]);
    expect(pins[0]?.id).toBe("empty");
  });
  test("attaches hits top right of stops, then uses the first free deterministic candidate", () => {
    const pins = sortMarkers([marker("stop", "A"), marker("first", 1), marker("next", 2)]);
    const f = mapFrame({ markers: pins }, 352)!;
    const offsets = pinOffsets(pins, f);
    expect(offsets.get("stop")).toEqual({ dx: 0, dy: 0 });
    expect(offsets.get("first")).toEqual({ dx: 17, dy: -17 });
    expect(offsets.get("next")?.dx).toBeCloseTo(28 / Math.sqrt(2));
    expect(offsets.get("next")?.dy).toBeCloseTo(28 / Math.sqrt(2));
    expect(pinOffsets(pins, f)).toEqual(offsets);
    const hits = [marker("one", 1), marker("two", 2)];
    expect(pinOffsets(hits, f).get("one")).toEqual({ dx: 0, dy: 0 });
    expect(pinOffsets(hits, f).get("two")?.dy).toBeCloseTo(-28 / Math.sqrt(2));
    for (const width of [390, 1024]) {
      fitCamera(f, width);
      expect(pinOffsets(pins, f)).toEqual(offsets);
    }
  });
  test("uses nice scale values in metres and kilometres", () => {
    expect(metersPerPixel(60, 5)).toBeCloseTo(metersPerPixel(0, 5) / 2, 8);
    expect(scaleBar(3)).toEqual({ meters: 200, label: "200 m" });
    expect(scaleBar(30)).toEqual({ meters: 2000, label: "2 km" });
    expect(scaleBar(6000)).toEqual({ meters: 500000, label: "500 km" });
    expect(scaleBar(1, 96)).toEqual({ meters: 50, label: "50 m" });
  });
});
