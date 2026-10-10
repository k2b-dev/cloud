import { describe, expect, test } from "bun:test";
import type { CalendarItem } from "@/contracts";
import { CALENDAR_MAX_DAYS, calendarBlock, calendarWindow, mergeCalendarItems } from "./range";

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
    expect(calendarBlock(range, "later", berlin)).toEqual({ from: range.to, to: "2026-11-01T23:00:00.000Z" });
    expect(calendarBlock(range, "earlier", berlin)).toEqual({ from: "2026-10-11T22:00:00.000Z", to: range.from });
  });

  test("stops growing at the widest range", () => {
    const range = { from: "2025-12-31T23:00:00.000Z", to: "2026-12-26T23:00:00.000Z" };
    expect(calendarBlock(range, "later", berlin)).toBeNull();
    expect(calendarBlock(range, "earlier", berlin)).toBeNull();
    const narrower = { ...range, to: "2026-12-20T23:00:00.000Z" };
    const later = calendarBlock(narrower, "later", berlin);
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
});
