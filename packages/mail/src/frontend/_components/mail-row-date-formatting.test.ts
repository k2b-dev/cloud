import { expect, setSystemTime, test } from "bun:test";
import { dates } from "@k2b/stdlib";

test("the installed formatter construction does not grow with Mail page size", () => {
  const native = Intl.DateTimeFormat;
  const nativeLocaleString = Date.prototype.toLocaleString;
  let constructions = 0;
  Intl.DateTimeFormat = new Proxy(native, {
    construct(target, args) {
      constructions++;
      return Reflect.construct(target, args);
    },
  });
  Date.prototype.toLocaleString = () => {
    throw new Error("Mail display must not parse localized date strings");
  };
  setSystemTime(new Date("2026-11-18T12:00:00Z"));
  try {
    // Private locale and uncommon zone isolate this guard from earlier formatter caches.
    const context = { locale: "en-x-mailbulk", timeZone: "Antarctica/Troll" };
    const format = (index: number) => {
      const input = new Date(Date.UTC(2026, 9, 1, 12, index)).toISOString();
      expect(dates.formatDateTime(input, context)).toContain("2026");
      expect(dates.formatDateTimeRelative(input, context)).toContain("2026");
    };
    for (let index = 0; index < 50; index++) format(index);
    const firstPageConstructions = constructions;
    expect(firstPageConstructions).toBeGreaterThan(0);
    for (let index = 50; index < 100; index++) format(index);
    expect(constructions).toBe(firstPageConstructions);
  } finally {
    setSystemTime();
    Intl.DateTimeFormat = native;
    Date.prototype.toLocaleString = nativeLocaleString;
  }
});

test("the installed formatter shows the timezone's DST transition and midnight", () => {
  expect(dates.formatDateTime("2026-03-29T00:30:00Z", { locale: "en-GB", timeZone: "Europe/Berlin" })).toBe("29 Mar 2026, 01:30");
  expect(dates.formatDateTime("2026-03-29T01:30:00Z", { locale: "en-GB", timeZone: "Europe/Berlin" })).toBe("29 Mar 2026, 03:30");
  expect(dates.formatDateTime("2026-01-01T18:15:00Z", { locale: "en-GB", timeZone: "Asia/Kathmandu" })).toBe("2 Jan 2026, 00:00");
});
