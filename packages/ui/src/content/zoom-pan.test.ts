import { describe, expect, test } from "bun:test";
import { clampZoomPan, panZoomPan, ZOOM_PAN_FIT, ZOOM_PAN_MAX_SCALE, type ZoomPanGeometry, zoomZoomPanAt } from "./zoom-pan";

// A 200×100 diagram centered in a 400×300 viewport.
const geometry: ZoomPanGeometry = { width: 400, height: 300, content: { left: 100, top: 100, width: 200, height: 100 } };

describe("zoom-pan math", () => {
  test("zoom keeps the content point under the anchor and stays between fit and the maximum", () => {
    const zoomed = zoomZoomPanAt(ZOOM_PAN_FIT, 2, { x: 200, y: 150 }, geometry);
    expect(zoomed).toEqual({ scale: 2, x: -200, y: -150 });
    expect(zoomZoomPanAt(zoomed, 100, { x: 200, y: 150 }, geometry).scale).toBe(ZOOM_PAN_MAX_SCALE);
    expect(zoomZoomPanAt(zoomed, 0.1, { x: 0, y: 0 }, geometry)).toEqual(ZOOM_PAN_FIT);
  });

  test("zoom toward a point keeps that point under the pointer", () => {
    const filled: ZoomPanGeometry = { width: 400, height: 300, content: { left: 0, top: 0, width: 400, height: 300 } };
    const zoomed = zoomZoomPanAt(ZOOM_PAN_FIT, 2, { x: 150, y: 120 }, filled);
    // Content point (150, 120) stays at screen (150, 120).
    expect(zoomed.x + 150 * zoomed.scale).toBe(150);
    expect(zoomed.y + 120 * zoomed.scale).toBe(120);
  });

  test("panning a large zoomed diagram stops where its edge meets the viewport edge", () => {
    const zoomed = { scale: 4, x: -800, y: -450 };
    // Content spans x 400..1200 at 4×; its left edge may not pass the viewport's left edge.
    expect(panZoomPan(zoomed, 10_000, 0, geometry).x).toBe(-400);
    // Its right edge may not pass the viewport's right edge.
    expect(panZoomPan(zoomed, -10_000, 0, geometry).x).toBe(400 - 4 * 300);
  });

  test("a zoomed diagram smaller than the viewport stays fully inside it", () => {
    const small: ZoomPanGeometry = { width: 400, height: 300, content: { left: 180, top: 140, width: 40, height: 20 } };
    const zoomed = { scale: 2, x: -200, y: -150 };
    const right = panZoomPan(zoomed, 10_000, 10_000, small);
    expect(right.x + 2 * (180 + 40)).toBe(400);
    expect(right.y + 2 * (140 + 20)).toBe(300);
    const left = panZoomPan(zoomed, -10_000, -10_000, small);
    expect(left.x + 2 * 180).toBe(0);
    expect(left.y + 2 * 140).toBe(0);
  });

  test("fit is always a valid position and has no offset", () => {
    expect(clampZoomPan({ scale: 1, x: 90, y: -40 }, geometry)).toEqual(ZOOM_PAN_FIT);
    expect(clampZoomPan({ scale: Number.NaN, x: 0, y: 0 }, geometry)).toEqual(ZOOM_PAN_FIT);
  });
});
