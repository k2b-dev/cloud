import { describe, expect, test } from "bun:test";
import { PDF_LIMITS, pageImageWidth } from "./pdf-limits";

describe("pageImageWidth", () => {
  test("follows the shown width and the pixel ratio, at most 2", () => {
    expect(pageImageWidth(600, 1, 1.414)).toBe(600);
    expect(pageImageWidth(600, 3, 1.414)).toBe(1200);
  });

  test("draws a small page at least 400 px wide", () => {
    expect(pageImageWidth(120, 1, 1.414)).toBe(400);
  });

  test("never passes the image width or the canvas pixel limit, also for a very tall page", () => {
    // A wide page meets the width limit first, a portrait page the pixel limit.
    expect(pageImageWidth(5000, 2, 0.5)).toBe(PDF_LIMITS.maxImageWidth);
    expect(pageImageWidth(5000, 2, 1.414)).toBe(Math.floor(Math.sqrt(PDF_LIMITS.maxCanvasPixels / 1.414)));
    for (const ratio of [1.414, 10, 1000, 100_000]) {
      const width = pageImageWidth(1200, 2, ratio);
      expect(width).toBeGreaterThanOrEqual(1);
      expect(width * width * ratio).toBeLessThanOrEqual(PDF_LIMITS.maxCanvasPixels);
    }
  });
});
