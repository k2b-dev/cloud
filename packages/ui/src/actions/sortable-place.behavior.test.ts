import { describe, expect, test } from "bun:test";
import { clampIndex, gapAt, gapForIndex, indexForGap, LINE_REACH, placeCount } from "./sortable-place";

// Four 40 px rows without gaps: bottoms at 40, 80, 120, 160.
const bottoms = [40, 80, 120, 160];

describe("sortable places", () => {
  test("the line sits above the row under the pointer, and never further below the pointer than its reach", () => {
    expect(gapAt(bottoms, 5)).toBe(0);
    expect(gapAt(bottoms, 50)).toBe(1);
    expect(gapAt(bottoms, 79 - LINE_REACH)).toBe(1);
    expect(gapAt(bottoms, 80 - LINE_REACH)).toBe(2);
    expect(gapAt(bottoms, 400)).toBe(4);
    expect(gapAt([], 400)).toBe(0);
    for (let y = 0; y < 200; y++) {
      const gap = gapAt(bottoms, y);
      const lineY = gap === 0 ? 0 : bottoms[gap - 1]!;
      expect(lineY).toBeLessThanOrEqual(y + LINE_REACH);
    }
  });

  test("a gap and the index it gives agree in both directions, inside one list and from another", () => {
    // The moved row is at index 1 of this list.
    expect([0, 1, 2, 3, 4].map((gap) => indexForGap(gap, 1))).toEqual([0, 1, 1, 2, 3]);
    expect([0, 1, 2, 3].map((index) => gapForIndex(index, 1))).toEqual([0, 1, 3, 4]);
    for (const index of [0, 1, 2, 3]) expect(indexForGap(gapForIndex(index, 1), 1)).toBe(index);
    // From another list, every gap is its own place.
    expect([0, 2, 4].map((gap) => indexForGap(gap, -1))).toEqual([0, 2, 4]);
    expect([0, 2, 4].map((index) => gapForIndex(index, -1))).toEqual([0, 2, 4]);
  });

  test("another list has one place more than rows; indexes stay inside the places", () => {
    expect(placeCount(4, true)).toBe(4);
    expect(placeCount(4, false)).toBe(5);
    expect(placeCount(0, false)).toBe(1);
    expect(clampIndex(-1, 5)).toBe(0);
    expect(clampIndex(9, 5)).toBe(4);
  });
});
