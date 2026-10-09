import { describe, expect, test } from "bun:test";
import type { CalendarItem } from "@/contracts";
import { defaultCalendarFilter } from "./filter";
import {
  mergeTimelineItems,
  TIMELINE_MAX_DAYS,
  timelineBlock,
  timelineTrayFiltered,
  timelineTrayFilters,
  timelineWindow,
} from "./timeline";

const berlin = { timeZone: "Europe/Berlin", locale: "de" };

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

describe("Spaces timeline window", () => {
  test("opens on the evening before the anchor day and covers seven more days", () => {
    expect(timelineWindow(new Date("2026-10-07T22:00:00Z"), berlin)).toEqual({
      from: "2026-10-07T18:00:00.000Z",
      to: "2026-10-15T22:00:00.000Z",
    });
  });

  test("loads whole weeks at the same local time across a daylight saving change", () => {
    const range = timelineWindow(new Date("2026-10-28T23:00:00Z"), berlin);
    expect(range.from).toBe("2026-10-28T19:00:00.000Z");
    expect(timelineBlock(range, "earlier", berlin)).toEqual({ from: "2026-10-21T18:00:00.000Z", to: range.from });
    const later = timelineBlock({ from: "2026-10-14T18:00:00.000Z", to: "2026-10-22T22:00:00.000Z" }, "later", berlin);
    expect(later).toEqual({ from: "2026-10-22T22:00:00.000Z", to: "2026-10-29T23:00:00.000Z" });
  });

  test("stops growing at the widest range", () => {
    const range = { from: "2026-01-01T19:00:00.000Z", to: "2026-12-26T23:00:00.000Z" };
    expect(timelineBlock(range, "later", berlin)).toBeNull();
    expect(timelineBlock(range, "earlier", berlin)).toBeNull();
    const narrower = { ...range, to: "2026-12-20T23:00:00.000Z" };
    expect(timelineBlock(narrower, "later", berlin)?.to).toBe("2026-12-27T23:00:00.000Z");
    expect((Date.parse("2026-12-27T23:00:00.000Z") - Date.parse(range.from)) / 86_400_000).toBeLessThanOrEqual(TIMELINE_MAX_DAYS);
  });

  test("replaces the items a fresh load covered and keeps the others", () => {
    const current = {
      from: "2026-10-07T18:00:00.000Z",
      to: "2026-10-16T22:00:00.000Z",
      items: [
        item("kept-event", { startsAt: "2026-10-12T08:00:00.000Z", endsAt: "2026-10-12T09:00:00.000Z" }),
        item("deleted-task", { deadline: "2026-10-08T15:00:00.000Z" }),
        item("moved-event", { startsAt: "2026-10-08T08:00:00.000Z", endsAt: "2026-10-08T09:00:00.000Z" }),
      ],
    };
    const merged = mergeTimelineItems(current, {
      from: "2026-09-30T18:00:00.000Z",
      to: "2026-10-09T22:00:00.000Z",
      items: [
        item("moved-event", { startsAt: "2026-10-09T08:00:00.000Z", endsAt: "2026-10-09T09:00:00.000Z" }),
        item("early-task", { deadline: "2026-10-01T15:00:00.000Z" }),
      ],
    });
    expect(merged.from).toBe("2026-09-30T18:00:00.000Z");
    expect(merged.to).toBe("2026-10-16T22:00:00.000Z");
    expect(merged.items.map((entry) => entry.id).sort()).toEqual(["early-task", "kept-event", "moved-event"]);
    expect(merged.items.find((entry) => entry.id === "moved-event")?.startsAt).toBe("2026-10-09T08:00:00.000Z");
  });
});

describe("Spaces timeline tray queries", () => {
  test("ask for open tasks under the calendar's filter: overdue ones, and undated ones of the reader", () => {
    const queries = timelineTrayFilters({ ...defaultCalendarFilter, assignedTo: "assigned", priorities: ["high"], columnIds: ["Col001"] });
    expect(queries?.overdue).toMatchObject({
      type: "task",
      status: "active",
      assignedTo: "assigned",
      deadlineFilter: "overdue",
      priority: ["high"],
      columnIds: ["Col001"],
      sort: "deadline",
      sortDesc: true,
    });
    expect(queries?.undated).toMatchObject({ type: "task", status: "active", assignedTo: "me", deadlineFilter: "none", sort: "priority" });
  });

  test("rule out what the filter excludes", () => {
    expect(timelineTrayFilters({ ...defaultCalendarFilter, type: "event" })).toBeNull();
    expect(timelineTrayFilters({ ...defaultCalendarFilter, assignedTo: "unassigned" })?.undated).toBeNull();
  });

  test("count as filtered where the filter leaves out tasks the tray would show", () => {
    expect(timelineTrayFiltered(defaultCalendarFilter)).toBe(false);
    expect(timelineTrayFiltered({ ...defaultCalendarFilter, type: "task", colorBy: "person" })).toBe(false);
    for (const narrowed of [
      { assignedTo: "me" as const },
      { assignedTo: "unassigned" as const },
      { priorities: ["high" as const] },
      { columnIds: ["Col001"] },
      { tagIds: ["Tag001"] },
    ]) {
      expect(timelineTrayFiltered({ ...defaultCalendarFilter, ...narrowed })).toBe(true);
    }
  });
});
