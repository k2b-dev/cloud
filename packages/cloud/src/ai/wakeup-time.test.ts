import { expect, test } from "bun:test";
import { cronRangeHasCalendarMatch } from "../shared/cron-schedule";
import { AiWakeupInputSchema } from "./wakeup-contracts";
import { describeAiWakeupRhythm, nextAiWakeupAt, prepareAiWakeupTime, validateAiWakeupCron } from "./wakeup-time";

const now = new Date("2026-11-18T12:00:00.000Z");
const base = { timezone: "Europe/Berlin", note: "Bitte nachsehen" };

test("one-off times must be in the future and within one calendar year", () => {
  expect(() => prepareAiWakeupTime({ ...base, at: now.toISOString() }, now)).toThrow("future");
  expect(() => prepareAiWakeupTime({ ...base, at: "2027-11-18T12:00:01Z" }, now)).toThrow("future");
  expect(prepareAiWakeupTime({ ...base, at: "2027-11-18T12:00:00Z" }, now).cron).toBeNull();
  expect(() => prepareAiWakeupTime(base, now)).toThrow();
});

test("quarter-hour frequency validates the entire minute wheel, including adjacent hours", () => {
  for (const cron of ["* * * * *", "*/10 * * * *", "0,59 * * * *", "0-20 * * * *"])
    expect(() => validateAiWakeupCron(cron, "Europe/Berlin")).toThrow("15 minutes");
  for (const cron of ["*/15 * * * *", "0 8 * * 1-5", "0 9 1 * *", "0,15,30,45 9-17 * * *"])
    expect(validateAiWakeupCron(cron, "Europe/Berlin").cron).toBe(cron);
  expect(() => validateAiWakeupCron("0 8 30 2 *", "Europe/Berlin")).toThrow();
  expect(() => validateAiWakeupCron("0 8 * * *", "Mars/Olympus")).toThrow();
});

test("recurring commitments end within 30 days and can be renewed from now", () => {
  const alarm = prepareAiWakeupTime({ ...base, cron: "0 8 * * *" }, now);
  expect(alarm.nextAt.toISOString()).toBe("2026-11-19T07:00:00.000Z");
  expect(alarm.endsAt?.toISOString()).toBe("2026-12-18T12:00:00.000Z");
  expect(() => prepareAiWakeupTime({ ...base, cron: "0 8 * * *", endsAt: "2026-12-19T12:00:00Z" }, now)).toThrow("30 days");
  expect(() => prepareAiWakeupTime({ ...base, at: "2026-11-19T12:00:00Z", endsAt: "2026-12-01T12:00:00Z" }, now)).toThrow("Only recurring");
});

test("downtime skips old recurring slots and returns the next future occurrence", () => {
  expect(nextAiWakeupAt("*/15 * * * *", "UTC", now, new Date("2026-12-18T12:00:00Z"))?.toISOString()).toBe("2026-11-18T12:15:00.000Z");
  expect(nextAiWakeupAt("0 9 1 * *", "UTC", now, new Date("2026-11-19T12:00:00Z"))).toBeNull();
});

test("DST spring skips nonexistent times and autumn repeats a local minute only once", () => {
  expect(
    nextAiWakeupAt("30 2 * * *", "Europe/Berlin", new Date("2026-03-29T00:00:00Z"), new Date("2026-03-31T00:00:00Z"))?.toISOString(),
  ).toBe("2026-03-30T00:30:00.000Z");
  expect(
    nextAiWakeupAt("30 2 * * *", "Europe/Berlin", new Date("2026-10-25T00:30:00Z"), new Date("2026-10-27T00:00:00Z"))?.toISOString(),
  ).toBe("2026-10-26T01:30:00.000Z");
});

test("notes count Unicode characters and product rhythm text never falls back to cron", () => {
  expect(AiWakeupInputSchema.safeParse({ ...base, note: "😀".repeat(200) }).success).toBe(true);
  expect(AiWakeupInputSchema.safeParse({ ...base, note: "😀".repeat(201) }).success).toBe(false);
  expect(describeAiWakeupRhythm("0 8 * * 1-5", "de")).toContain("Mo");
  expect(describeAiWakeupRhythm("0 8 1 2 *", "de")).toBe("Eigener Rhythmus");
  expect(describeAiWakeupRhythm(null, "en")).toBe("Once");
});


test("sparse calendars skip nonmatching days without losing UTC crossings or DST occurrences", () => {
  const range = { from: new Date("2026-11-18T12:00:00Z"), to: new Date("2026-11-19T12:00:00Z") };
  expect(cronRangeHasCalendarMatch({ cron: "0 8 1 12 *", timezone: "Europe/Berlin" }, range.from, range.to)).toBe(false);
  expect(cronRangeHasCalendarMatch({ cron: "0 8 * * 4", timezone: "Europe/Berlin" }, range.from, range.to)).toBe(true);
  expect(nextAiWakeupAt("0 8 1 12 *", "Europe/Berlin", now, new Date("2026-12-18T12:00:00Z"))?.toISOString()).toBe("2026-12-01T07:00:00.000Z");
  // Restricted day-of-month and weekday use cron OR semantics.
  expect(nextAiWakeupAt("0 8 1 12 3", "Europe/Berlin", now, new Date("2026-12-18T12:00:00Z"))?.toISOString()).toBe("2026-12-01T07:00:00.000Z");
  expect(nextAiWakeupAt("0 8 1 12 3", "Europe/Berlin", new Date("2026-12-01T12:00:00Z"), new Date("2026-12-18T12:00:00Z"))?.toISOString()).toBe("2026-12-02T07:00:00.000Z");
});
