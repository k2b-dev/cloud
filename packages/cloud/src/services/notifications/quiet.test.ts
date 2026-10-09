import { describe, expect, test } from "bun:test";
import { NotificationQuietHoursSchema, UpdateNotificationQuietSettingsSchema } from "../../contracts/user-notifications";
import { notificationQuietState, quietInputFromRow } from "./quiet";

const BERLIN = "Europe/Berlin";
const weekdays = [1, 2, 3, 4, 5];
const everyDay = [1, 2, 3, 4, 5, 6, 7];
const evenings = { timeZone: BERLIN, periods: [{ days: weekdays, start: "19:00", end: "07:00" }] };
const state = (quietHours: typeof evenings, at: string, doNotDisturbUntil: string | null = null) =>
  notificationQuietState({ quietHours, doNotDisturbUntil: doNotDisturbUntil ? new Date(doNotDisturbUntil) : null }, new Date(at));

describe("notification quiet state", () => {
  test("is inactive without do not disturb or quiet hours", () => {
    expect(state({ timeZone: "UTC", periods: [] }, "2026-10-06T12:00:00Z")).toEqual({
      active: false,
      reason: null,
      until: null,
      nextStart: null,
    });
  });

  test("pauses until a future instant and ignores a past one", () => {
    const empty = { timeZone: "UTC", periods: [] };
    expect(state(empty, "2026-10-06T12:00:00Z", "2026-10-06T13:30:00Z")).toEqual({
      active: true,
      reason: "doNotDisturb",
      until: "2026-10-06T13:30:00.000Z",
      nextStart: null,
    });
    expect(state(empty, "2026-10-06T12:00:00Z", "2026-10-06T11:00:00Z").active).toBe(false);
  });

  test("applies overnight quiet hours in the person's time zone", () => {
    // Tuesday 20:00 in Berlin (CEST, UTC+2) until Wednesday 07:00.
    expect(state(evenings, "2026-10-06T18:00:00Z")).toMatchObject({
      active: true,
      reason: "quietHours",
      until: "2026-10-07T05:00:00.000Z",
    });
    // Wednesday 06:59 is still quiet; 07:00 is not, and the next evening is announced.
    expect(state(evenings, "2026-10-07T04:59:00Z").active).toBe(true);
    expect(state(evenings, "2026-10-07T05:00:00Z")).toEqual({
      active: false,
      reason: null,
      until: null,
      nextStart: "2026-10-07T17:00:00.000Z",
    });
    // The same UTC instant is daytime for someone in New York.
    expect(state({ ...evenings, timeZone: "America/New_York" }, "2026-10-06T18:00:00Z").active).toBe(false);
  });

  test("lets a period run into the next day from the day it starts", () => {
    // Friday 19:00 belongs to Friday, so Saturday morning stays quiet until 07:00.
    expect(state(evenings, "2026-10-10T04:00:00Z")).toMatchObject({ active: true, until: "2026-10-10T05:00:00.000Z" });
    // Saturday noon is not quiet; the next period starts on Monday evening.
    expect(state(evenings, "2026-10-10T10:00:00Z")).toMatchObject({ active: false, nextStart: "2026-10-12T17:00:00.000Z" });
  });

  test("keeps local times when daylight saving time starts", () => {
    const nights = { timeZone: BERLIN, periods: [{ days: everyDay, start: "22:00", end: "07:00" }] };
    // Saturday 23:00 CET; the night ends at 07:00 CEST on Sunday 29 March 2026, after the clocks skipped an hour.
    expect(state(nights, "2026-03-28T22:00:00Z")).toMatchObject({ active: true, until: "2026-03-29T05:00:00.000Z" });
    expect(state(nights, "2026-03-29T04:59:00Z").active).toBe(true);
    expect(state(nights, "2026-03-29T05:00:00Z").active).toBe(false);
    // Sunday's night starts at 22:00 CEST.
    expect(state(nights, "2026-03-29T12:00:00Z").nextStart).toBe("2026-03-29T20:00:00.000Z");
  });

  test("keeps local times when daylight saving time ends", () => {
    const nights = { timeZone: BERLIN, periods: [{ days: everyDay, start: "22:00", end: "07:00" }] };
    // Saturday 23:00 CEST; the night ends at 07:00 CET on Sunday 25 October 2026, an hour later in UTC.
    expect(state(nights, "2026-10-24T21:00:00Z")).toMatchObject({ active: true, until: "2026-10-25T06:00:00.000Z" });
    expect(state(nights, "2026-10-25T05:30:00Z").active).toBe(true);
    expect(state(nights, "2026-10-25T06:00:00Z").active).toBe(false);
  });

  test("moves a start inside the skipped hour forward with the clock", () => {
    const early = { timeZone: BERLIN, periods: [{ days: [7], start: "02:30", end: "04:00" }] };
    // 02:30 does not exist on 29 March 2026 in Berlin; the period starts at 03:30 CEST.
    expect(state(early, "2026-03-29T00:00:00Z").nextStart).toBe("2026-03-29T01:30:00.000Z");
  });

  test("follows adjoining periods to the end of the whole quiet time", () => {
    const weekend = {
      timeZone: BERLIN,
      periods: [
        { days: weekdays, start: "19:00", end: "07:00" },
        { days: [6, 7], start: "00:00", end: "00:00" },
      ],
    };
    // Friday 20:00 runs through the weekend; Monday 00:00 ends it, because Sunday has no evening period.
    expect(state(weekend, "2026-10-09T18:00:00Z")).toMatchObject({ active: true, until: "2026-10-11T22:00:00.000Z" });
  });

  test("extends do not disturb by quiet hours that continue when it ends", () => {
    // Paused until Tuesday 20:00 Berlin, inside that evening's quiet hours, which end Wednesday 07:00.
    expect(state(evenings, "2026-10-06T10:00:00Z", "2026-10-06T18:00:00Z")).toEqual({
      active: true,
      reason: "doNotDisturb",
      until: "2026-10-07T05:00:00.000Z",
      nextStart: null,
    });
  });

  test("names no end for a schedule that is always quiet", () => {
    const always = { timeZone: BERLIN, periods: [{ days: everyDay, start: "00:00", end: "00:00" }] };
    expect(state(always, "2026-10-06T10:00:00Z")).toEqual({ active: true, reason: "quietHours", until: null, nextStart: null });
  });

  test("treats equal start and end as 24 hours from the start", () => {
    const fromEvening = { timeZone: "UTC", periods: [{ days: [2], start: "22:00", end: "22:00" }] };
    expect(state(fromEvening, "2026-10-06T23:00:00Z")).toMatchObject({ active: true, until: "2026-10-07T22:00:00.000Z" });
  });

  test("silences nothing when a stored schedule no longer validates", () => {
    const input = quietInputFromRow({ do_not_disturb_until: null, time_zone: "Mars/Olympus", periods: [{ days: [9] }] });
    expect(input.quietHours.periods).toEqual([]);
    expect(input.quietHours.timeZone).toBe("UTC");
  });
});

describe("quiet settings contract", () => {
  test("accepts at most one period per weekday and only real times and zones", () => {
    const period = { days: [1], start: "22:00", end: "07:00" };
    expect(NotificationQuietHoursSchema.safeParse({ timeZone: BERLIN, periods: Array(7).fill(period) }).success).toBe(true);
    expect(NotificationQuietHoursSchema.safeParse({ timeZone: BERLIN, periods: Array(8).fill(period) }).success).toBe(false);
    expect(NotificationQuietHoursSchema.safeParse({ timeZone: "Mars/Olympus", periods: [] }).success).toBe(false);
    expect(NotificationQuietHoursSchema.safeParse({ timeZone: BERLIN, periods: [{ ...period, end: "24:00" }] }).success).toBe(false);
    expect(NotificationQuietHoursSchema.safeParse({ timeZone: BERLIN, periods: [{ ...period, days: [] }] }).success).toBe(false);
    expect(NotificationQuietHoursSchema.safeParse({ timeZone: BERLIN, periods: [{ ...period, days: [1, 1] }] }).success).toBe(false);
  });

  test("requires something to update", () => {
    expect(UpdateNotificationQuietSettingsSchema.safeParse({}).success).toBe(false);
    expect(UpdateNotificationQuietSettingsSchema.safeParse({ doNotDisturbUntil: null }).success).toBe(true);
    expect(UpdateNotificationQuietSettingsSchema.safeParse({ doNotDisturbUntil: "2026-10-06T20:00:00+02:00" }).success).toBe(true);
  });
});
