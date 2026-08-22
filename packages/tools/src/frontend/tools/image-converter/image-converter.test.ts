import { describe, expect, test } from "bun:test";
import { buildBase64ImageTag, fitWithin, nextClockwiseRotation, rotatedDimensions, uniqueOutputNames } from "./image-converter";

describe("image converter helpers", () => {
  test("rotates dimensions and advances quarter turns", () => {
    expect(rotatedDimensions(1200, 800, 90)).toEqual({ width: 800, height: 1200 });
    expect(rotatedDimensions(1200, 800, 180)).toEqual({ width: 1200, height: 800 });
    expect(nextClockwiseRotation(0)).toBe(90);
    expect(nextClockwiseRotation(270)).toBe(0);
  });

  test("fits within both optional limits without upscaling", () => {
    expect(fitWithin(2400, 1600, 1200, 900)).toEqual({ width: 1200, height: 800 });
    expect(fitWithin(800, 600, 1200, 900)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(1200, 800, null, 400)).toEqual({ width: 600, height: 400 });
  });

  test("creates safe unique output names with a jpg extension", () => {
    expect(uniqueOutputNames(["photo.png", "photo.webp", "PHOTO.gif", "folder/name.png"], "jpeg")).toEqual([
      "photo.jpg",
      "photo-2.jpg",
      "PHOTO-3.jpg",
      "name.jpg",
    ]);
  });

  test("builds an escaped image tag with stable dimensions", () => {
    expect(buildBase64ImageTag('data:image/png;base64,a&b"', 'logo & "team".png', { width: 320, height: 80 })).toBe(
      '<img src="data:image/png;base64,a&amp;b&quot;" alt="logo &amp; &quot;team&quot;" width="320" height="80">',
    );
  });
});
