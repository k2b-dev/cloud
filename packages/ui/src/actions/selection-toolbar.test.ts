import { describe, expect, test } from "bun:test";
import { selectionToolbarPosition } from "./SelectionToolbar";

const viewport = { width: 1000, height: 800 };
const toolbar = { width: 200, height: 38 };

describe("selectionToolbarPosition", () => {
  test("centers the toolbar over the selection with a gap", () => {
    expect(selectionToolbarPosition({ top: 300, bottom: 320, left: 400, width: 100 }, toolbar, viewport)).toEqual({
      left: 350,
      top: 254,
      side: "above",
    });
  });

  test("goes below when the space above, or above a boundary, is too small", () => {
    expect(selectionToolbarPosition({ top: 30, bottom: 50, left: 400, width: 100 }, toolbar, viewport).side).toBe("below");
    expect(selectionToolbarPosition({ top: 100, bottom: 120, left: 400, width: 100 }, toolbar, { ...viewport, top: 80 })).toEqual({
      left: 350,
      top: 128,
      side: "below",
    });
  });

  test("always goes below on request and stays inside the viewport", () => {
    expect(selectionToolbarPosition({ top: 300, bottom: 320, left: 0, width: 20 }, toolbar, viewport, "below")).toEqual({
      left: 8,
      top: 328,
      side: "below",
    });
    expect(selectionToolbarPosition({ top: 300, bottom: 320, left: 980, width: 20 }, toolbar, viewport).left).toBe(792);
  });
});
