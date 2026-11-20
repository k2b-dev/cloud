import { describe, expect, test } from "bun:test";
import { formatDescriptionChange, formatDescriptionNumber } from "./format";

const size = { unit: "B" };

describe("formatDescriptionNumber with unit B", () => {
  for (const [locale, negative, zero, half, petabytes, beyond] of [
    ["de", "-1,2 GB", "0 B", "0,5 B", "1,5 PB", "2500 PB"],
    ["en", "-1.2 GB", "0 B", "0.5 B", "1.5 PB", "2500 PB"],
  ] as const)
    test(`in ${locale} a size keeps its sign, a part of a byte, and the largest unit`, () => {
      expect(formatDescriptionNumber(-1_200_000_000, size, locale)).toBe(negative);
      expect(formatDescriptionNumber(0, size, locale)).toBe(zero);
      expect(formatDescriptionNumber(0.5, size, locale)).toBe(half);
      expect(formatDescriptionNumber(-0.5, size, locale)).toBe(`-${half}`);
      expect(formatDescriptionNumber(1_500_000_000_000_000, size, locale)).toBe(petabytes);
      expect(formatDescriptionNumber(2_500_000_000_000_000_000, size, locale)).toBe(beyond);
    });

  test("decimals fix the digits of a size", () => {
    expect(formatDescriptionNumber(2_400_000, { unit: "B", decimals: 3 }, "de")).toBe("2,400 MB");
    expect(formatDescriptionNumber(2_400_000, { unit: "B", decimals: 0 }, "en")).toBe("2 MB");
    expect(formatDescriptionNumber(-1_234, { unit: "B", decimals: 1 }, "en")).toBe("-1.2 KB");
  });
});

describe("formatDescriptionChange", () => {
  test("two sizes that differ but read alike both show more digits until the change shows", () => {
    expect(formatDescriptionChange(2_400_000, 2_400_100, size, "en")).toEqual(["2.4000 MB", "2.4001 MB"]);
    expect(formatDescriptionChange(2_400_000, 2_400_100, size, "de")).toEqual(["2,4000 MB", "2,4001 MB"]);
  });

  test("a change that already shows, or no change, keeps the format as given", () => {
    expect(formatDescriptionChange(1_000, 2_400_000, size, "en")).toEqual(["1 KB", "2.4 MB"]);
    expect(formatDescriptionChange(2_400_000, 2_400_000, size, "en")).toEqual(["2.4 MB", "2.4 MB"]);
    expect(formatDescriptionChange(10.001, 10.002, { style: "currency", currency: "EUR", decimals: 2 }, "en")).toEqual([
      "€10.001",
      "€10.002",
    ]);
  });
});
