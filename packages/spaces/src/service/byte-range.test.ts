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

  test("clamps an end or suffix beyond the safe integers to the body", () => {
    expect(resolveByteRange("bytes=0-99999999999999999999", 100)).toEqual({ start: 0, endExclusive: 100 });
    expect(resolveByteRange(`bytes=90-${"9".repeat(400)}`, 100)).toEqual({ start: 90, endExclusive: 100 });
    expect(resolveByteRange("bytes=-99999999999999999999", 100)).toEqual({ start: 0, endExclusive: 100 });
    expect(resolveByteRange("bytes=99999999999999999999-", 100)).toBe("unsatisfiable");
  });

  test("ignores another unit, several ranges, and malformed ranges, so the whole body answers", () => {
    for (const header of ["items=0-1", "bytes=0-1,5-6", "bytes=-", "bytes=20-10", "bytes=a-b", "bytes 0-1", ""])
      expect(resolveByteRange(header, 100)).toBeNull();
    expect(resolveByteRange("items=0-1", 0)).toBeNull();
  });

  test("refuses a single range that selects no bytes", () => {
    for (const header of ["bytes=100-", "bytes=100-200", "bytes=-0"]) expect(resolveByteRange(header, 100)).toBe("unsatisfiable");
    expect(resolveByteRange("bytes=0-", 0)).toBe("unsatisfiable");
    expect(resolveByteRange("bytes=-5", 0)).toBe("unsatisfiable");
  });
});
