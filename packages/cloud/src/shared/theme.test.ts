import { describe, expect, test } from "bun:test";
import { readThemeFromCookieHeader, readThemePreferenceFromCookieHeader } from "./theme";

describe("readThemeFromCookieHeader", () => {
  test("defaults to light", () => {
    expect(readThemeFromCookieHeader("")).toBe("light");
    expect(readThemeFromCookieHeader(null)).toBe("light");
  });

  test("reads light and dark theme cookies", () => {
    expect(readThemeFromCookieHeader("theme=dark")).toBe("dark");
    expect(readThemeFromCookieHeader("session=abc; theme=light; other=1")).toBe("light");
  });

  test("uses the last valid duplicate theme cookie", () => {
    expect(readThemeFromCookieHeader("theme=dark; theme=light")).toBe("light");
    expect(readThemeFromCookieHeader("theme=light; theme=dark")).toBe("dark");
  });

  test("ignores invalid theme cookie values", () => {
    expect(readThemeFromCookieHeader("theme=dark; theme=broken")).toBe("dark");
    expect(readThemeFromCookieHeader("theme=broken; theme=light")).toBe("light");
  });
  test("explicit preferences win over the browser scheme hint", () => {
    expect(readThemeFromCookieHeader("theme=light; color-scheme=dark")).toBe("light");
    expect(readThemeFromCookieHeader("theme=dark; color-scheme=light")).toBe("dark");
  });
  test("Automatic uses the last valid browser scheme hint, or light", () => {
    expect(readThemeFromCookieHeader("theme=system; color-scheme=dark")).toBe("dark");
    expect(readThemeFromCookieHeader("color-scheme=dark")).toBe("dark");
    expect(readThemeFromCookieHeader("theme=broken; color-scheme=dark")).toBe("dark");
    expect(readThemeFromCookieHeader("color-scheme=light; color-scheme=dark; color-scheme=broken")).toBe("dark");
    expect(readThemeFromCookieHeader("color-scheme=dark; color-scheme=light")).toBe("light");
    expect(readThemeFromCookieHeader("theme=system; color-scheme=broken")).toBe("light");
  });
});

describe("readThemePreferenceFromCookieHeader", () => {
  test("defaults missing and invalid preferences to system", () => {
    for (const cookie of [undefined, null, "", "theme=broken", "theme=%ZZ"])
      expect(readThemePreferenceFromCookieHeader(cookie)).toBe("system");
  });
  test("reads all preferences and keeps the last valid duplicate", () => {
    expect(readThemePreferenceFromCookieHeader("theme=system")).toBe("system");
    expect(readThemePreferenceFromCookieHeader("theme=dark; theme=system; theme=broken")).toBe("system");
    expect(readThemePreferenceFromCookieHeader("theme=system; theme=light")).toBe("light");
    expect(readThemePreferenceFromCookieHeader("theme=light; theme=%64ark")).toBe("dark");
  });
});
