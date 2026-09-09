/**
 * Placement regressions for `positionTooltipSurface`.
 *
 * The module is byte-identical to Cloud's `ui/misc/tooltip-position.ts` (only
 * the signature is reflowed across three lines), and Cloud ships no test for
 * it. `feedback-parity.test.tsx` covers the two-pass measurement; this file
 * covers the flip rules and the viewport clamps, which are pure arithmetic and
 * therefore exactly where an off-by-one would hide.
 *
 * Constants under test: 8px viewport padding, 6px trigger gap.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { positionTooltipSurface, type TooltipPlacement } from "./tooltip-position";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

const setViewport = (innerWidth: number, innerHeight: number) => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: { innerWidth, innerHeight } });
};

type Rect = { left: number; right: number; top: number; bottom: number; width: number; height: number };

const targetAt = (rect: Partial<Rect> & { top: number; height: number; left: number; width: number }): HTMLElement =>
  ({
    getBoundingClientRect: () => ({
      left: rect.left,
      right: rect.left + rect.width,
      top: rect.top,
      bottom: rect.top + rect.height,
      width: rect.width,
      height: rect.height,
    }),
  }) as unknown as HTMLElement;

/** Both measurement passes report the same box, isolating the placement maths. */
const surfaceOf = (width: number, height: number) => {
  const element = {
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
    getBoundingClientRect: () => ({ width, height }),
  };
  return element as unknown as HTMLElement & { dataset: Record<string, string>; style: Record<string, string> };
};

const place = (
  viewport: [number, number],
  target: HTMLElement,
  size: [number, number],
  placement?: TooltipPlacement,
): { left: number; top: number; placement: string } => {
  setViewport(viewport[0], viewport[1]);
  const surface = surfaceOf(size[0], size[1]);
  positionTooltipSurface(surface, target, placement);
  return {
    left: Number.parseInt(surface.style.left as string, 10),
    top: Number.parseInt(surface.style.top as string, 10),
    placement: surface.dataset.placement as string,
  };
};

describe("positionTooltipSurface placement", () => {
  beforeEach(() => setViewport(1000, 800));

  test("prefers the requested side when it fits", () => {
    const target = targetAt({ left: 400, width: 100, top: 300, height: 40 });

    // top: 300 - 50 - 6 = 244; bottom: 340 + 6 = 346.
    expect(place([1000, 800], target, [200, 50])).toEqual({ left: 350, top: 244, placement: "top" });
    expect(place([1000, 800], target, [200, 50], "top")).toEqual({ left: 350, top: 244, placement: "top" });
    expect(place([1000, 800], target, [200, 50], "bottom")).toEqual({ left: 350, top: 346, placement: "bottom" });
  });

  test("flips to the bottom when the top would cross the padding line", () => {
    // top would be 20 - 50 - 6 = -36, well above the 8px padding.
    const target = targetAt({ left: 400, width: 100, top: 20, height: 40 });
    expect(place([1000, 800], target, [200, 50], "top")).toEqual({ left: 350, top: 66, placement: "bottom" });
  });

  test("flips to the top when the bottom would cross the padding line", () => {
    // bottom would be 760 + 6 = 766, and 766 + 50 > 800 - 8.
    const target = targetAt({ left: 400, width: 100, top: 720, height: 40 });
    expect(place([1000, 800], target, [200, 50], "bottom")).toEqual({ left: 350, top: 664, placement: "top" });
  });

  test("a top placement exactly on the padding line still counts as fitting", () => {
    // top = 64 - 50 - 6 = 8, which is `>= VIEWPORT_PADDING`, so no flip.
    expect(place([1000, 800], targetAt({ left: 400, width: 100, top: 64, height: 40 }), [200, 50], "top")).toEqual({
      left: 350,
      top: 8,
      placement: "top",
    });
    // One pixel higher and it no longer fits.
    expect(place([1000, 800], targetAt({ left: 400, width: 100, top: 63, height: 40 }), [200, 50], "top").placement).toBe("bottom");
  });

  test("keeps the requested side when neither side fits", () => {
    // A surface taller than the viewport fits nowhere; `top` stays top and is
    // clamped to the padding, `bottom` stays bottom and is clamped to maxTop.
    const target = targetAt({ left: 400, width: 100, top: 300, height: 40 });
    expect(place([1000, 200], target, [200, 400], "top")).toEqual({ left: 350, top: 8, placement: "top" });

    const bottom = place([1000, 200], target, [200, 400], "bottom");
    expect(bottom.placement).toBe("bottom");
    // maxTop floors at the padding once the surface is taller than the viewport.
    expect(bottom.top).toBe(8);
  });

  test("clamps horizontally against both viewport edges", () => {
    // Centred on the left edge: the ideal left is negative.
    expect(place([1000, 800], targetAt({ left: 0, width: 20, top: 300, height: 20 }), [200, 50]).left).toBe(8);
    // Centred on the right edge: the ideal left overflows.
    expect(place([1000, 800], targetAt({ left: 980, width: 20, top: 300, height: 20 }), [200, 50]).left).toBe(792);
    // Wider than the viewport: the max bound goes below the min, and the
    // Math.max wins, so the surface pins to the left padding rather than
    // sliding off-screen to the left.
    expect(place([300, 800], targetAt({ left: 100, width: 20, top: 300, height: 20 }), [500, 50]).left).toBe(8);
  });

  test("clamps vertically against maxTop when the surface sits low", () => {
    // Room below: bottom placement at 700 + 6 = 706, under the 732 cap.
    expect(place([1000, 800], targetAt({ left: 400, width: 100, top: 660, height: 40 }), [200, 60], "bottom").top).toBe(706);

    // maxTop can only bite for an explicit "bottom" request where *neither*
    // side fits — every other branch picks bottom only when it already fits.
    // A 200px-tall target in a 300px viewport leaves no room on either side.
    const clamped = place([1000, 300], targetAt({ left: 400, width: 100, top: 50, height: 200 }), [200, 60], "bottom");
    expect(clamped.placement).toBe("bottom");
    // Desired 256, capped at 300 - 60 - 8 = 232.
    expect(clamped.top).toBe(232);
  });
});

test("places rail tooltips to the right, flips at the opposite edge and clamps vertically", () => {
  expect(place([1000, 800], targetAt({ left: 4, width: 32, top: 100, height: 32 }), [200, 40], "right")).toEqual({
    left: 42,
    top: 96,
    placement: "right",
  });
  expect(place([1000, 800], targetAt({ left: 960, width: 32, top: 0, height: 32 }), [200, 40], "right")).toEqual({
    left: 754,
    top: 8,
    placement: "left",
  });
  expect(place([1000, 800], targetAt({ left: 4, width: 32, top: 770, height: 30 }), [200, 40], "left")).toEqual({
    left: 42,
    top: 752,
    placement: "right",
  });
});
