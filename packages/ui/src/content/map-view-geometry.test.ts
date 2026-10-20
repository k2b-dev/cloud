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
    const f = mapFrame({ markers: [marker("one")] }, 352, 48)!;
    expect(f.spanX).toBe(MIN_SPAN);
    expect(f.spanY).toBe(MIN_SPAN);
    expect(f.referenceWidth).toBe(256);
    expect(fitCamera(f, 352, 48).zoom).toBeCloseTo(16, 10);
    expect(fitCamera(f, 352, 48).center[0]).toBeCloseTo(10, 10);
    expect(fitCamera(f, 352, 48).center[1]).toBeCloseTo(48.4, 10);
    expect(mapFrame({}, 400, 48)).toBeNull();
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
    const f = mapFrame({ markers, lines, areas, ownLocation }, 400, 48)!;
    for (const width of [240, 390, 768, 1024]) {
      const camera = fitCamera(f, width, 48);
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
    expect(mapFrame({ markers, lines, areas, ownLocation, fit: "markers" }, 400, 48)).toEqual(mapFrame({ markers }, 400, 48));
    expect(mapFrame({ lines, fit: "markers" }, 400, 48)).toEqual(mapFrame({ lines }, 400, 48));
    expect(mapFrame({ lines: [{ id: "encoded", polyline6: "_izlhA~rlgdF_{geC~ywl@_kwzCn`{nI" }] }, 400, 48)).not.toBeNull();
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
    const f = mapFrame({ markers: pins }, 352, 48)!;
    const offsets = pinOffsets(pins, f);
    expect(offsets.get("stop")).toEqual({ dx: 0, dy: 0 });
    expect(offsets.get("first")?.dx).toBeCloseTo(17, 9);
    expect(offsets.get("first")?.dy).toBeCloseTo(-17, 9);
    expect(offsets.get("next")?.dx).toBeCloseTo(28 / Math.sqrt(2));
    expect(offsets.get("next")?.dy).toBeCloseTo(28 / Math.sqrt(2));
    expect(pinOffsets(pins, f)).toEqual(offsets);
    const hits = [marker("one", 1), marker("two", 2)];
    expect(pinOffsets(hits, f).get("one")).toEqual({ dx: 0, dy: 0 });
    expect(pinOffsets(hits, f).get("two")?.dy).toBeCloseTo(-28 / Math.sqrt(2));
    for (const width of [390, 1024]) {
      fitCamera(f, width, 48);
      expect(pinOffsets(pins, f)).toEqual(offsets);
    }
  });
  test("a hit beside a stop is drawn top right of the stop, wherever it lies around it", () => {
    const pins = sortMarkers([marker("stop", "A", 48.4, 10), marker("hit", 1, 48.39996, 9.99994), marker("far", 2, 48.41, 10.02)]);
    const f = mapFrame({ markers: pins }, 360, 48)!;
    const offsets = pinOffsets(pins, f);
    const scale = f.overlapWidth / f.spanX;
    const drawn = (id: string) => {
      const p = projectPoint(pins.find((pin) => pin.id === id)!.point);
      const o = offsets.get(id)!;
      return { x: (p.x - f.minX) * scale + o.dx, y: (p.y - f.minY) * scale + o.dy };
    };
    expect(drawn("hit").x - drawn("stop").x).toBeCloseTo(17, 9);
    expect(drawn("hit").y - drawn("stop").y).toBeCloseTo(-17, 9);
  });
  test("keeps stops apart and decides separation at phone width", () => {
    // A wide route: C and "+" are a pin apart on a wide screen but would cover each other on a phone.
    const pins = sortMarkers([
      marker("c", "C", 48.493, 9.399),
      marker("plus", "+", 48.493, 9.43),
      marker("d", "D", 48.491, 9.204),
      marker("a", "A", 48.398, 9.991),
    ]);
    const f = mapFrame({ markers: pins }, 360, 48)!;
    const offsets = pinOffsets(pins, f);
    expect(offsets.get("c")).toEqual({ dx: 0, dy: 0 });
    expect(Math.hypot(offsets.get("plus")!.dx, offsets.get("plus")!.dy)).toBeCloseTo(28, 9);
    const phoneScale = f.overlapWidth / f.spanX;
    expect(f.overlapWidth).toBeCloseTo(390 - 96, 9);
    const at = (id: string) => {
      const m = pins.find((pin) => pin.id === id)!;
      const p = projectPoint(m.point);
      const o = offsets.get(id)!;
      return { x: (p.x - f.minX) * phoneScale + o.dx, y: (p.y - f.minY) * phoneScale + o.dy };
    };
    expect(Math.hypot(at("plus").x - at("c").x, at("plus").y - at("c").y)).toBeGreaterThanOrEqual(28 - 1e-9);
  });
  test("never fits further out than MapLibre allows: the world stays at least as tall as the map", () => {
    // Pins across the whole world on a phone: the narrow width would ask for a zoom below the one where the world fills 400 px.
    const markers = [marker("west", 1, 0, -170), marker("east", 2, 0, 170)];
    const f = mapFrame({ markers }, 400, 48)!;
    const camera = fitCamera(f, 390, 48);
    expect(512 * 2 ** camera.zoom).toBeCloseTo(400, 6);
    expect(f.minWidth).toBeCloseTo(f.spanX * 400, 12);
    // A city keeps its ordinary fit.
    const city = mapFrame({ markers: [marker("a", 1, 48.39, 9.98), marker("b", 2, 48.41, 10)] }, 400, 48)!;
    expect(city.minWidth).toBeLessThan(Math.min(390 - 96, city.referenceWidth));
    expect(fitCamera(city, 390, 48).zoom).toBeCloseTo(Math.log2(Math.min(390 - 96, city.referenceWidth) / (city.spanX * 512)), 9);
  });
  test("uses nice scale values in metres and kilometres", () => {
    expect(metersPerPixel(60, 5)).toBeCloseTo(metersPerPixel(0, 5) / 2, 8);
    expect(scaleBar(3)).toEqual({ meters: 200, label: "200 m" });
    expect(scaleBar(30)).toEqual({ meters: 2000, label: "2 km" });
    expect(scaleBar(6000)).toEqual({ meters: 500000, label: "500 km" });
    expect(scaleBar(1, 96)).toEqual({ meters: 50, label: "50 m" });
  });
});
