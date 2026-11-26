import { describe, expect, test } from "bun:test";
import { carrySizes, indexAtOffset, prefixOffsets } from "./virtual-sizes";

describe("the size model of virtual lists", () => {
  test("offsets are the prefix sums of the heights, recomputed from the first stale one", () => {
    const sizes = Float64Array.from([40, 72, 52, 40]);
    const offsets = prefixOffsets(sizes, 0, 4, new Float64Array(1), 0);
    expect([...offsets]).toEqual([0, 40, 112, 164, 204]);
    sizes[2] = 60;
    expect([...prefixOffsets(sizes, 0, 4, offsets, 2)]).toEqual([0, 40, 112, 172, 212]);
    // a window [1, 3) counts from its own start
    expect([...prefixOffsets(sizes, 1, 3, new Float64Array(1), 0)]).toEqual([0, 72, 132]);
  });

  test("the item at an offset is the one whose bottom lies below it", () => {
    const offsets = prefixOffsets(Float64Array.from([40, 72, 52]), 0, 3, new Float64Array(1), 0);
    expect(indexAtOffset(offsets, 3, 0)).toBe(0);
    expect(indexAtOffset(offsets, 3, 39.9)).toBe(0);
    expect(indexAtOffset(offsets, 3, 40)).toBe(1);
    expect(indexAtOffset(offsets, 3, 500)).toBe(2);
    expect(indexAtOffset(new Float64Array(1), 0, 10)).toBe(0);
  });

  test("a changed list keeps the heights of its known keys and estimates new ones; no known key starts afresh", () => {
    const carried = carrySizes(["a", "b", "c"], Float64Array.from([40, 72, 52]), ["new", "c", "a"], () => 10);
    expect(carried && [...carried]).toEqual([10, 52, 40]);
    expect(carrySizes(["a"], Float64Array.from([40]), ["x", "y"], () => 10)).toBeNull();
  });
});
