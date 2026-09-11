import { describe, expect, test } from "bun:test";
import { DEFAULT_MAP_VIEWPORT, normalizeMapViewport, panMapViewport, zoomMapViewport } from "./chart-map-viewport";

describe("interactive chart map viewport", () => {
  test("normalizes invalid and out-of-bounds values", () => {
    expect(
      normalizeMapViewport({
        latitude: Number.NaN,
        longitude: Number.POSITIVE_INFINITY,
        zoom: Number.NaN,
      }),
    ).toEqual(DEFAULT_MAP_VIEWPORT);
    expect(
      normalizeMapViewport({
        latitude: 90,
        longitude: 180,
        zoom: 99,
      }),
    ).toEqual({
      latitude: 87.1875,
      longitude: 174.375,
      zoom: 5,
    });
  });

  test("zooms within the stdlib map limits", () => {
    expect(zoomMapViewport(DEFAULT_MAP_VIEWPORT, 1)).toEqual({
      latitude: 45,
      longitude: 10,
      zoom: 1,
    });
    expect(zoomMapViewport({ latitude: 10, longitude: 20, zoom: 5 }, 1)).toEqual({
      latitude: 10,
      longitude: 20,
      zoom: 5,
    });
  });

  test("uses custom focus only when leaving the world overview", () => {
    const focus = { latitude: 35, longitude: 139 };
    expect(zoomMapViewport(DEFAULT_MAP_VIEWPORT, 1, focus)).toEqual({ latitude: 35, longitude: 90, zoom: 1 });
    expect(zoomMapViewport({ latitude: 12, longitude: 25, zoom: 1 }, 1, focus)).toEqual({ latitude: 12, longitude: 25, zoom: 2 });
    expect(zoomMapViewport({ latitude: 12, longitude: 25, zoom: 1 }, -1, focus)).toEqual(DEFAULT_MAP_VIEWPORT);
    expect(zoomMapViewport(DEFAULT_MAP_VIEWPORT, 1, { latitude: 0, longitude: 0 })).toEqual({ latitude: 0, longitude: 0, zoom: 1 });
  });

  test("pans relative to the visible world and clamps at its bounds", () => {
    expect(panMapViewport({ latitude: 0, longitude: 0, zoom: 1 }, 100, -50, 400, 200)).toEqual({
      latitude: -22.5,
      longitude: -45,
      zoom: 1,
    });
    expect(panMapViewport({ latitude: 0, longitude: 0, zoom: 2 }, -10_000, 10_000, 400, 200)).toEqual({
      latitude: 67.5,
      longitude: 135,
      zoom: 2,
    });
  });

  test("keeps the normalized viewport for unusable dimensions", () => {
    expect(panMapViewport({ latitude: 90, longitude: 180, zoom: 1 }, 10, 10, 0, 200)).toEqual({
      latitude: 45,
      longitude: 90,
      zoom: 1,
    });
  });
});
