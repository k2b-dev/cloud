import { describe, expect, test } from "bun:test";
import type { CalendarItem } from "@/contracts";
import {
  CALENDAR_MAX_DAYS,
  calendarBlock,
  calendarBlockDays,
  isBlockLoadingCalendarView,
  isScrollingCalendarView,
  calendarItemsEnd,
  calendarWindow,
  countCalendarDays,
  mergeCalendarItems,
} from "./range";

const berlin = { timeZone: "Europe/Berlin", locale: "de", firstDayOfWeek: 1 as const };

const item = (id: string, times: Partial<CalendarItem>): CalendarItem => ({
  id,
  spaceId: "spc_1",
  spaceName: "Team",
  spaceColor: "#3b82f6",
  title: id,
  descriptionPreview: null,
  location: null,
  url: null,
  startsAt: null,
  endsAt: null,
  allDay: false,
  deadline: null,
  priority: null,
  recurrence: null,
  recurringEventId: null,
  recurrenceId: null,
  columnId: "col_1",
  assignees: [],
  activeBlockerCount: 0,
  ...times,
});

describe("Spaces calendar day and week ranges", () => {
  test("the day view loads a week before its day and three after it", () => {
    // Friday, October 9, 2026, in Berlin.
    expect(calendarWindow("day", new Date("2026-10-08T22:00:00Z"), berlin)).toEqual({
      from: "2026-10-01T22:00:00.000Z",
      to: "2026-10-30T23:00:00.000Z",
    });
  });

  test("the week view loads the week before and the two after its week", () => {
    expect(calendarWindow("week", new Date("2026-10-08T22:00:00Z"), berlin)).toEqual({
      from: "2026-09-27T22:00:00.000Z",
      to: "2026-10-18T22:00:00.000Z",
    });
  });

  test("loads whole weeks from midnight to midnight across a clock change", () => {
    const range = { from: "2026-10-18T22:00:00.000Z", to: "2026-10-25T23:00:00.000Z" };
    expect(calendarBlock(range, "later", 7, berlin)).toEqual({ from: range.to, to: "2026-11-01T23:00:00.000Z" });
    expect(calendarBlock(range, "earlier", 7, berlin)).toEqual({ from: "2026-10-11T22:00:00.000Z", to: range.from });
  });

  test("stops growing at the widest range", () => {
    const range = { from: "2025-12-31T23:00:00.000Z", to: "2026-12-26T23:00:00.000Z" };
    expect(calendarBlock(range, "later", 7, berlin)).toBeNull();
    expect(calendarBlock(range, "earlier", 7, berlin)).toBeNull();
    const narrower = { ...range, to: "2026-12-20T23:00:00.000Z" };
    const later = calendarBlock(narrower, "later", 7, berlin);
    expect(later?.to).toBe("2026-12-27T23:00:00.000Z");
    expect((Date.parse(later!.to) - Date.parse(range.from)) / 86_400_000).toBeLessThanOrEqual(CALENDAR_MAX_DAYS);
  });

  test("replaces the items a fresh load covered and keeps the others", () => {
    const current = {
      from: "2026-10-07T22:00:00.000Z",
      to: "2026-10-16T22:00:00.000Z",
      items: [
        item("kept-event", { startsAt: "2026-10-12T08:00:00.000Z", endsAt: "2026-10-12T09:00:00.000Z" }),
        item("deleted-task", { deadline: "2026-10-08T15:00:00.000Z" }),
        item("moved-event", { startsAt: "2026-10-08T08:00:00.000Z", endsAt: "2026-10-08T09:00:00.000Z" }),
      ],
    };
    const merged = mergeCalendarItems(current, {
      from: "2026-09-30T22:00:00.000Z",
      to: "2026-10-09T22:00:00.000Z",
      items: [
        item("moved-event", { startsAt: "2026-10-09T08:00:00.000Z", endsAt: "2026-10-09T09:00:00.000Z" }),
        item("early-task", { deadline: "2026-10-01T15:00:00.000Z" }),
      ],
    });
    expect(merged.from).toBe("2026-09-30T22:00:00.000Z");
    expect(merged.to).toBe("2026-10-16T22:00:00.000Z");
    expect(merged.items.map((entry) => entry.id).sort()).toEqual(["early-task", "kept-event", "moved-event"]);
    expect(merged.items.find((entry) => entry.id === "moved-event")?.startsAt).toBe("2026-10-09T08:00:00.000Z");
  });

  test("the loaded days hold the night after the last one until 06:00 on the wall clock, also when the clocks go back", () => {
    // The days up to Friday, October 9: the night runs until 06:00 summer time on Saturday.
    expect(calendarItemsEnd("2026-10-09T22:00:00.000Z", berlin)).toBe("2026-10-10T04:00:00.000Z");
    // The days up to Saturday, October 24: at 03:00 the clocks go back, so the night ends at 06:00 winter time.
    expect(calendarItemsEnd("2026-10-24T22:00:00.000Z", berlin)).toBe("2026-10-25T05:00:00.000Z");
  });

  test("a fresh load also replaces what it covered in the night after its last day", () => {
    const current = {
      from: "2026-09-30T22:00:00.000Z",
      to: "2026-10-16T22:00:00.000Z",
      // Due at 04:00 on Saturday: the night of Friday, October 9.
      items: [item("done-in-the-night", { deadline: "2026-10-10T02:00:00.000Z" })],
    };
    const merged = mergeCalendarItems(current, { from: "2026-09-30T22:00:00.000Z", to: "2026-10-09T22:00:00.000Z", items: [] }, berlin);
    expect(merged.items).toEqual([]);
  });

  test("counts what the days in view show, with each night on the day before it", () => {
    const items = [
      item("standup", { startsAt: "2026-10-09T07:15:00.000Z", endsAt: "2026-10-09T07:30:00.000Z" }),
      // 05:00 on Saturday still belongs to Friday's night.
      item("night-deadline", { deadline: "2026-10-10T03:00:00.000Z" }),
      item("saturday", { deadline: "2026-10-10T08:00:00.000Z" }),
      // A deadline without a time on Saturday, stored at its midnight.
      item("due-saturday", { deadline: "2026-10-09T22:00:00.000Z", allDay: true }),
      // All day from Thursday to Saturday.
      item("fair", { startsAt: "2026-10-07T22:00:00.000Z", endsAt: "2026-10-10T22:00:00.000Z", allDay: true }),
      item("next-week", { startsAt: "2026-10-12T08:00:00.000Z", endsAt: "2026-10-12T09:00:00.000Z" }),
    ];
    expect(countCalendarDays(items, "2026-10-09", "2026-10-09", berlin)).toBe(3);
    expect(countCalendarDays(items, "2026-10-10", "2026-10-10", berlin)).toBe(3);
    expect(countCalendarDays(items, "2026-10-05", "2026-10-11", berlin)).toBe(5);
  });
});

describe("Spaces month blocks", () => {
  test("month loads sixteen whole weeks around the first, across the Berlin clock change", () => {
    expect(calendarWindow("month", new Date("2026-10-08T22:00:00Z"), berlin)).toEqual({
      from: "2026-08-23T22:00:00.000Z",
      to: "2026-12-13T23:00:00.000Z",
    });
    expect(calendarWindow("month", new Date("2026-10-09T12:00:00Z"), { ...berlin, firstDayOfWeek: 0 })).toEqual({
      from: "2026-08-22T22:00:00.000Z",
      to: "2026-12-12T23:00:00.000Z",
    });
  });
  test("loads eight weeks instead of the timed views' one, and keeps the maximum range", () => {
    expect(calendarBlockDays("month")).toBe(56);
    expect(calendarBlockDays("day")).toBe(7);
    expect(calendarBlockDays("week")).toBe(7);
    const range = calendarWindow("month", new Date("2026-10-09T12:00:00Z"), berlin);
    expect(calendarBlock(range, "earlier", 56, berlin)).toEqual({ from: "2026-06-28T22:00:00.000Z", to: range.from });
    expect(calendarBlock(range, "later", 56, berlin)).toEqual({ from: range.to, to: "2027-02-07T23:00:00.000Z" });
    expect(calendarBlock({ from: "2026-01-01T00:00:00Z", to: "2026-12-01T00:00:00Z" }, "later", 56, berlin)).toBeNull();
  });
  test("month uses block loading without acquiring timed-day deadline or count policy", () => {
    expect(isBlockLoadingCalendarView("month")).toBe(true);
    expect(isScrollingCalendarView("month")).toBe(false);
    expect(isBlockLoadingCalendarView("year")).toBe(false);
  });
});
