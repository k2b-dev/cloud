import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { DateContext } from "@k2b/stdlib";
import type { CalendarEvent } from "@k2b/ui";
import { countCalendarEvents, countTimeBlocks } from "./count";

const berlin: DateContext = { locale: "en", timeZone: "Europe/Berlin", weekStartsOn: 1 };
const timed = (start: string, end?: string): CalendarEvent => ({ id: "Event1", title: "Event", start, end });
const allDay = (start: string, end?: string): CalendarEvent => ({ id: "Event1", title: "Event", start, end, allDay: true });
/** A task without an event time, as the Spaces calendar hands it to the grid. */
const deadline = (at: string): CalendarEvent => ({ id: "Task01", title: "Task", start: at, end: at, allDay: true, display: "marker" });
const october = (event: CalendarEvent) => countCalendarEvents([event], "2026-10-01", "2026-11-01", berlin);

const events = [
  timed("2026-09-29T10:00:00+02:00", "2026-09-29T11:00:00+02:00"),
  timed("2026-09-30T23:30:00+02:00", "2026-09-30T23:59:00+02:00"),
  timed("2026-10-31T23:30:00+01:00", "2026-11-01T00:30:00+01:00"),
  allDay("2026-09-29T22:00:00.000Z", "2026-10-02T22:00:00.000Z"),
  allDay("2026-10-31T23:00:00.000Z", "2026-11-01T23:00:00.000Z"),
  deadline("2026-10-14T22:00:00.000Z"),
];

describe("Spaces calendar event counts", () => {
  afterEach(() => setSystemTime());

  test("count only events overlapping October's own days in Berlin", () => {
    expect(countCalendarEvents(events, "2026-10-01", "2026-11-01", berlin)).toBe(3);
  });

  test("count all six events over the whole grid, padding days included", () => {
    expect(countCalendarEvents(events, "2026-09-28", "2026-11-02", berlin)).toBe(6);
  });

  test("count a deadline at the month's first midnight, not one at the next month's, and no range that ends at the first", () => {
    expect(october(deadline("2026-09-30T22:00:00.000Z"))).toBe(1);
    expect(october(deadline("2026-10-31T23:00:00.000Z"))).toBe(0);
    expect(october(allDay("2026-09-29T22:00:00.000Z", "2026-09-30T22:00:00.000Z"))).toBe(0);
    expect(october(timed("2026-09-30T23:30:00+02:00", "2026-10-01T00:00:00+02:00"))).toBe(0);
  });

  test("give a timed event without a valid end the grid's one hour and leave an invalid start out", () => {
    expect(october(timed("2026-09-30T23:30:00+02:00"))).toBe(1);
    expect(october(timed("2026-09-30T23:30:00+02:00", "2026-09-30T23:30:00+02:00"))).toBe(1);
    expect(october(timed("2026-09-30T23:30:00+02:00", "not a date"))).toBe(1);
    expect(october(timed("2026-09-30T22:30:00+02:00", "2026-09-30T22:00:00+02:00"))).toBe(0);
    expect(october(timed("2026-10-15T10:00:00+02:00", "2026-10-15T09:00:00+02:00"))).toBe(1);
    expect(october(timed("not a date", "2026-10-15T09:00:00+02:00"))).toBe(0);
  });

  test("count all-day events without valid ranges as points", () => {
    for (const end of [undefined, "not a date", "2026-09-30T23:30:00+02:00", "2026-09-30T23:00:00+02:00"]) {
      expect(october(allDay("2026-09-30T23:30:00+02:00", end))).toBe(0);
      expect(october(allDay("2026-10-01T00:00:00+02:00", end))).toBe(1);
    }
  });

  test("place the month's edges the same way whatever today's date is", () => {
    // Havana repeats midnight on 2026-11-01; Santiago skips midnight on 2026-09-06.
    const havana: DateContext = { locale: "en", timeZone: "America/Havana" };
    const santiago: DateContext = { locale: "en", timeZone: "America/Santiago" };
    for (const today of ["2026-07-01T12:00:00Z", "2026-12-15T12:00:00Z"]) {
      setSystemTime(new Date(today));
      const dueInHavana = [deadline("2026-11-01T04:30:00.000Z")];
      expect(countCalendarEvents(dueInHavana, "2026-10-01", "2026-11-01", havana)).toBe(0);
      expect(countCalendarEvents(dueInHavana, "2026-11-01", "2026-12-01", havana)).toBe(1);
      const dueInSantiago = [deadline("2026-09-06T04:00:00.000Z")];
      expect(countCalendarEvents(dueInSantiago, "2026-09-01", "2026-10-01", santiago)).toBe(1);
      expect(countCalendarEvents(dueInSantiago, "2026-08-01", "2026-09-01", santiago)).toBe(0);
    }
  });
});

test("time blocks count the visible day's following night and exclude its previous night", () => {
  const blocks = [
    { startsAt: "2030-03-14T05:00:00Z", endsAt: "2030-03-14T06:00:00Z" },
    { startsAt: "2030-03-14T06:00:00Z", endsAt: "2030-03-14T07:00:00Z" },
    { startsAt: "2030-03-15T05:00:00Z", endsAt: "2030-03-15T06:00:00Z" },
    { startsAt: "2030-03-15T06:00:00Z", endsAt: "2030-03-15T07:00:00Z" },
  ];
  expect(countTimeBlocks(blocks, "2030-03-14", "2030-03-14", { timeZone: "UTC" })).toBe(2);
});
