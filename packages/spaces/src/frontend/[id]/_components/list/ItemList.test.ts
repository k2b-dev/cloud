import { describe, expect, test } from "bun:test";
import { dates } from "@k2b/stdlib";
import type { SpaceItem } from "@/contracts";
import { getEffectiveSchedule, groupItems } from "./item-list-groups";

const SPACE_ID = "Space1";
const COLUMN_ID = "Col001";
let nextItemId = 0;

const item = (overrides: Partial<SpaceItem> = {}): SpaceItem => ({
  id: `It${String(++nextItemId).padStart(4, "0")}`,
  spaceId: SPACE_ID,
  columnId: COLUMN_ID,
  title: "Item",
  description: null,
  location: null,
  url: null,
  startsAt: null,
  endsAt: null,
  allDay: false,
  deadline: null,
  estimatedDurationMinutes: null,
  activeBlockerCount: 0,
  priority: null,
  recurrence: null,
  recurringEventId: null,
  recurrenceId: null,
  rank: "1024",
  completedAt: null,
  createdBy: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("Spaces overview schedule", () => {
  test("uses event starts and task deadlines as the effective schedule", () => {
    const event = item({
      startsAt: "2026-02-10T09:00:00.000Z",
      endsAt: "2026-02-10T10:00:00.000Z",
      deadline: "2026-02-12T00:00:00.000Z",
    });
    const task = item({ deadline: "2026-02-11T12:00:00.000Z" });

    expect(getEffectiveSchedule(event)).toBe(event.startsAt);
    expect(getEffectiveSchedule(task)).toBe(task.deadline);
  });

  test("separates overdue tasks, past events, exact dates, and unscheduled items", () => {
    const dateConfig = { timeZone: "UTC", locale: "en" };
    const today = dates.today(dateConfig);
    const yesterday = dates.addDays(today, -1, dateConfig).toISOString();
    const tomorrow = dates.addDays(today, 1, dateConfig).toISOString();
    const grouped = groupItems(
      [
        item({ title: "Overdue", deadline: yesterday }),
        item({ title: "Past event", startsAt: yesterday, endsAt: yesterday }),
        item({ title: "Today", deadline: today.toISOString() }),
        item({ title: "Tomorrow", startsAt: tomorrow, endsAt: tomorrow }),
        item({ title: "No date" }),
      ],
      "deadline",
      [],
      [],
      dateConfig,
    );

    expect(grouped.groups.map((group) => group.key)).toEqual([
      "overdue",
      "past-events",
      `date:${dates.formatDateKey(today, dateConfig)}`,
      `date:${dates.formatDateKey(tomorrow, dateConfig)}`,
      "none",
    ]);
    expect(grouped.groups.map((group) => group.label)).toEqual(["Overdue", "Past events", "Today", "Tomorrow", "No date"]);
  });
});
