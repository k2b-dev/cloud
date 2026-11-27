import { expect, test } from "bun:test";
import { compactDateWithDelta } from "./date-format";

const context = { timeZone: "Europe/Berlin", locale: "de", firstDayOfWeek: 1, now: "2026-11-25T09:42:00Z" } as const;

test("a moment of today names its time, a moment of another day names its day too", () => {
  expect(compactDateWithDelta("2026-11-25T09:41:00Z", context)).toStartWith("10:41 (");
  // the day counts in the zone: 23:30 UTC on the 24th is already the 25th in Berlin
  expect(compactDateWithDelta("2026-11-24T23:30:00Z", context)).toStartWith("00:30 (");
  expect(compactDateWithDelta("2026-03-02T08:00:00Z", context)).toStartWith("02. März 09:00 (");
});
