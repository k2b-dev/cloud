import { describe, expect, test } from "bun:test";
import { resolveByteRange } from "./byte-range";

describe("attachment byte ranges", () => {
  test("selects the bytes a player asks for", () => {
    expect(resolveByteRange(null, 100)).toBeNull();
    expect(resolveByteRange("bytes=0-", 100)).toEqual({ start: 0, endExclusive: 100 });
    expect(resolveByteRange("bytes=0-1", 100)).toEqual({ start: 0, endExclusive: 2 });
    expect(resolveByteRange("bytes=10-19", 100)).toEqual({ start: 10, endExclusive: 20 });
    expect(resolveByteRange("bytes=90-500", 100)).toEqual({ start: 90, endExclusive: 100 });
    expect(resolveByteRange("bytes=-10", 100)).toEqual({ start: 90, endExclusive: 100 });
    expect(resolveByteRange("bytes=-500", 100)).toEqual({ start: 0, endExclusive: 100 });
  });

  test("refuses ranges outside the body or in another unit", () => {
    for (const header of ["bytes=100-", "bytes=20-10", "bytes=-0", "bytes=-", "items=0-1", "bytes=0-1,5-6"])
      expect(resolveByteRange(header, 100)).toBe("unsatisfiable");
    expect(resolveByteRange("bytes=0-", 0)).toBe("unsatisfiable");
  });
});
