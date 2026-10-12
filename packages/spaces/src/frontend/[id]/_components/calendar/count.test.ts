import { describe, expect, test } from "bun:test";
import type { DateContext } from "@k2b/stdlib";
import type { CalendarItem } from "@/contracts";
import { countCalendarItems } from "./count";

const berlin: DateContext = { locale: "en", timeZone: "Europe/Berlin", weekStartsOn: 1 };
const base = (patch: Partial<CalendarItem>): CalendarItem => ({
  id: "Item01",
  spaceId: "Space1",
  spaceName: "Planning",
  spaceColor: "#3b82f6",
  title: "Item",
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
  tags: [],
  columnId: "Col001",
  assignees: [],
  activeBlockerCount: 0,
  ...patch,
});
const items = [
  base({ id: "Event1", startsAt: "2026-09-29T10:00:00+02:00", endsAt: "2026-09-29T11:00:00+02:00" }),
  base({ id: "Event2", startsAt: "2026-09-30T23:30:00+02:00", endsAt: "2026-09-30T23:59:00+02:00" }),
  base({ id: "Event3", startsAt: "2026-10-31T23:30:00+01:00", endsAt: "2026-11-01T00:30:00+01:00" }),
  base({ id: "Event4", allDay: true, startsAt: "2026-09-29T22:00:00.000Z", endsAt: "2026-10-02T22:00:00.000Z" }),
  base({ id: "Event5", allDay: true, startsAt: "2026-10-31T23:00:00.000Z", endsAt: "2026-11-01T23:00:00.000Z" }),
  base({ id: "Task01", deadline: "2026-10-14T22:00:00.000Z" }),
];

describe("Spaces calendar item counts", () => {
  test("count only items overlapping October's own days in Berlin", () => {
    expect(countCalendarItems(items, "2026-10-01", "2026-10-31", berlin)).toBe(3);
  });

  test("count a deadline at the month's first midnight, not one at the next month's, and no range that ends at the first", () => {
    const count = (item: CalendarItem) => countCalendarItems([item], "2026-10-01", "2026-10-31", berlin);
    expect(count(base({ deadline: "2026-09-30T22:00:00.000Z" }))).toBe(1);
    expect(count(base({ deadline: "2026-10-31T23:00:00.000Z" }))).toBe(0);
    expect(count(base({ allDay: true, startsAt: "2026-09-29T22:00:00.000Z", endsAt: "2026-09-30T22:00:00.000Z" }))).toBe(0);
    expect(count(base({ startsAt: "2026-09-30T23:30:00+02:00", endsAt: "2026-10-01T00:00:00+02:00" }))).toBe(0);
  });

  test("count all six items over the whole grid, padding days included", () => {
    expect(countCalendarItems(items, "2026-09-28", "2026-11-01", berlin)).toBe(6);
  });

  test("count zero-length and reversed entries as points and leave undated items out", () => {
    const points = [
      base({ startsAt: "2026-10-15T10:00:00+02:00", endsAt: "2026-10-15T10:00:00+02:00" }),
      base({ startsAt: "2026-10-15T10:00:00+02:00", endsAt: "2026-10-15T09:00:00+02:00" }),
      base({ endsAt: "2026-10-15T10:00:00+02:00" }),
    ];
    expect(countCalendarItems(points, "2026-10-01", "2026-10-31", berlin)).toBe(2);
  });
});
