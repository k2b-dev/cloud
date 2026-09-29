import { describe, expect, test } from "bun:test";
import { blockMinimum, fittingCount } from "./fit-list";

describe("fittingCount", () => {
  // Rows 24 px high with 8 px gaps end at 24, 56, 88, 120, and 152.
  const bottoms = [24, 56, 88, 120, 152];

  test("shows every row that fits, without room for a count", () => {
    expect(fittingCount(bottoms, 152, 24)).toBe(5);
    expect(fittingCount([], 0, 24)).toBe(0);
  });

  test("leaves room for the '+N more' line once a row is cut", () => {
    // 130 px hold four rows, but the count line needs 24 px, so three rows remain.
    expect(fittingCount(bottoms, 130, 24)).toBe(3);
    expect(fittingCount(bottoms, 20, 24)).toBe(0);
  });

  test("tolerates subpixel rounding at the edge", () => {
    expect(fittingCount(bottoms, 151.6, 24)).toBe(5);
  });
});

describe("blockMinimum", () => {
  test("keeps the heading, the first row, and the count line when more rows follow", () => {
    expect(blockMinimum(64, [36, 80, 124], 24)).toBe(124);
    expect(blockMinimum(64, [36], 24)).toBe(100);
    expect(blockMinimum(64, [], 24)).toBe(0);
    expect(blockMinimum(64.4, [20.2, 48], 24)).toBe(109);
  });
});
