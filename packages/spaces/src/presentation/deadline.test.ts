import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { deadlineDayKey, formatDeadline, isDateOnlyDeadline } from "./deadline";

beforeEach(() => setSystemTime(new Date("2025-10-24T12:00:00Z")));
afterEach(() => setSystemTime());

for (const timeZone of ["America/Los_Angeles", "Europe/Berlin", "Pacific/Kiritimati"]) {
  test.each([
    ["de", "Fr., 24. Okt."],
    ["en", "Fri, Oct 24"],
  ])(`formats a calendar date without shifting it in ${timeZone} (%s)`, (locale, label) => {
    expect(isDateOnlyDeadline("2025-10-24")).toBeTrue();
    expect(deadlineDayKey("2025-10-24", { timeZone, locale })).toBe("2025-10-24");
    expect(formatDeadline("2025-10-24", { timeZone, locale })).toBe(label);
    expect(formatDeadline("2026-10-24", { timeZone, locale })).toContain("2026");
  });
}

test.each([
  ["America/Los_Angeles", "2025-10-23", "Do., 23. Okt., 17:00", "Thu, Oct 23, 17:00"],
  ["Europe/Berlin", "2025-10-24", "Fr., 24. Okt., 02:00", "Fri, Oct 24, 02:00"],
  ["Pacific/Kiritimati", "2025-10-24", "Fr., 24. Okt., 14:00", "Fri, Oct 24, 14:00"],
])("formats timed deadlines in %s", (timeZone, key, de, en) => {
  const deadline = "2025-10-24T00:00:00Z";
  expect(isDateOnlyDeadline(deadline)).toBeFalse();
  expect(deadlineDayKey(deadline, { timeZone })).toBe(key);
  expect(formatDeadline(deadline, { timeZone, locale: "de" })).toBe(de);
  expect(formatDeadline(deadline, { timeZone, locale: "en" })).toBe(en);
});

test("the current year is the application's year", () => {
  setSystemTime(new Date("2025-12-31T12:00:00Z"));
  expect(formatDeadline("2026-01-01", { locale: "en", timeZone: "Pacific/Kiritimati" })).not.toContain("2026");
  expect(formatDeadline("2026-01-01", { locale: "en", timeZone: "America/Los_Angeles" })).toContain("2026");
});
