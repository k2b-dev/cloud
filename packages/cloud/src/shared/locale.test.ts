import { describe, expect, it } from "bun:test";
import { canonicalLocale, DEFAULT_LOCALE, normalizeLocale } from "./locale";

describe("canonicalLocale", () => {
  it("canonicalizes casing and keeps regional subtags", () => {
    expect(canonicalLocale("DE-ch")).toBe("de-CH");
    expect(canonicalLocale(" en-us ")).toBe("en-US");
    expect(canonicalLocale("de")).toBe("de");
  });

  it("rejects empty and structurally invalid tags", () => {
    expect(canonicalLocale("")).toBeUndefined();
    expect(canonicalLocale("   ")).toBeUndefined();
    expect(canonicalLocale(null)).toBeUndefined();
    expect(canonicalLocale(undefined)).toBeUndefined();
    expect(canonicalLocale("not a locale!")).toBeUndefined();
    expect(canonicalLocale("_de")).toBeUndefined();
  });
});

describe("normalizeLocale", () => {
  it("returns the canonical tag for valid input", () => {
    expect(normalizeLocale("de-CH")).toBe("de-CH");
  });

  it("falls back deterministically on invalid input", () => {
    expect(normalizeLocale("!!", "de")).toBe("de");
    expect(normalizeLocale(undefined)).toBe(DEFAULT_LOCALE);
  });
});
