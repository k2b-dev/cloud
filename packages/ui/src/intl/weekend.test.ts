import { describe, expect, test } from "bun:test";
import { dayOfWeekOfKey, isWeekendColumn, isWeekendKey, weekendDays } from "./weekend";

describe("locale weekend days", () => {
  for (const [locale, days] of [
    ["de-DE", [6, 0]],
    ["he-IL", [5, 6]],
    ["ar-SA", [5, 6]],
    ["fa-IR", [5]],
    ["en-IN", [0]],
    [undefined, [6, 0]],
    ["not a locale!!", [6, 0]],
  ] as const) {
    test(`${locale ?? "no locale"} uses the expected JavaScript day numbers`, () => {
      expect(weekendDays(locale)).toEqual(new Set(days));
    });
  }

  test("falls back when the engine has neither week-data API", () => {
    const prototype = Intl.Locale.prototype;
    const descriptors = ["getWeekInfo", "weekInfo"].map((key) => [key, Object.getOwnPropertyDescriptor(prototype, key)] as const);
    try {
      for (const [key] of descriptors) Object.defineProperty(prototype, key, { configurable: true, value: undefined });
      // A fresh tag bypasses the per-tag cache; India normally has Sunday only.
      expect(weekendDays("en-IN-u-nu-latn")).toEqual(new Set([6, 0]));
    } finally {
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(prototype, key, descriptor);
        else Reflect.deleteProperty(prototype, key);
      }
    }
  });

  test("reads date keys without depending on the runtime's time zone", () => {
    expect(dayOfWeekOfKey("2026-10-24")).toBe(6);
    expect(isWeekendKey("2026-10-23", "he-IL")).toBe(true);
    expect(isWeekendKey("2026-10-25", "he-IL")).toBe(false);
  });

  test("keeps the configured week start when marking columns", () => {
    const columns = (firstDay: number, locale: string) => Array.from({ length: 7 }, (_, index) => isWeekendColumn(index, firstDay, locale));
    expect(columns(1, "de-DE")).toEqual([false, false, false, false, false, true, true]);
    expect(columns(0, "de-DE")).toEqual([true, false, false, false, false, false, true]);
    expect(columns(1, "he-IL")).toEqual([false, false, false, false, true, true, false]);
    expect(columns(0, "he-IL")).toEqual([false, false, false, false, false, true, true]);
  });
});
