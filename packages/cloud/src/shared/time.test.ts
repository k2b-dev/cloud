import { describe, expect, test } from "bun:test";
import { normalizeTimeZone } from "./time";

describe("normalizeTimeZone", () => {
  test("keeps a known zone in Intl's canonical spelling", () => {
    expect(normalizeTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
    expect(normalizeTimeZone("utc")).toBe("UTC");
    expect(normalizeTimeZone("  Asia/Kolkata  ")).toBe("Asia/Kolkata");
  });

  test("falls back for what Intl does not know and for nothing at all", () => {
    expect(normalizeTimeZone("Mars/Olympus_Mons", "Europe/Berlin")).toBe("Europe/Berlin");
    expect(normalizeTimeZone("", "Europe/Berlin")).toBe("Europe/Berlin");
    expect(normalizeTimeZone(null)).toBe("UTC");
    expect(normalizeTimeZone(undefined)).toBe("UTC");
  });

  test("an offset is UTC, because Intl and Postgres read its sign the other way round", () => {
    for (const offset of ["+01:00", "+0100", "-05:00", "-0500", "+14"]) expect(normalizeTimeZone(offset, "Europe/Berlin")).toBe("UTC");
  });
});
