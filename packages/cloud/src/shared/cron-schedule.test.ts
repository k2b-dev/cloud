import { expect, test } from "bun:test";
import { visitCronDaySlots } from "./cron-schedule";

const slots = (cron: string, from: string, to: string, timezone = "Europe/Berlin") => {
  const found: string[] = [];
  visitCronDaySlots({ cron, timezone }, new Date(from), new Date(to), (slot) => found.push(slot.toISOString()));
  return found;
};
// Monday, 16 November 2026, as a local Berlin day.
const monday = ["2026-11-15T23:00:00.000Z", "2026-11-16T23:00:00.000Z"] as const;

test("a wildcard weekday plans every day, not Sunday alone", () => {
  // Every 15 minutes from 07:00 to 19:45 local time: 13 hours with 4 starts each.
  const quarter = slots("*/15 7-19 * * *", ...monday);
  expect(quarter).toHaveLength(52);
  expect(quarter[0]).toBe("2026-11-16T06:00:00.000Z");
  expect(quarter.at(-1)).toBe("2026-11-16T18:45:00.000Z");
  expect(slots("0 9 * * *", ...monday)).toEqual(["2026-11-16T08:00:00.000Z"]);
  // An explicit Sunday, as 0 or 7, still plans nothing on a Monday.
  expect(slots("0 9 * * 0", ...monday)).toEqual([]);
  expect(slots("0 9 * * 7", ...monday)).toEqual([]);
  expect(slots("0 9 * * 1-5", ...monday)).toEqual(["2026-11-16T08:00:00.000Z"]);
});
