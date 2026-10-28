import { expect, test } from "bun:test";
import { CalendarItemSchema as SourceItemSchema } from "@k2b/cloud/contracts";
import { parseCalendarSelections } from "../calendar-contracts";
import type { CalendarItem } from "../contracts";
import { projectSourceItem } from "./calendar-source";

const item: CalendarItem = {
  id: "Item01",
  spaceId: "Space1",
  spaceName: "Team",
  spaceColor: "#6366f1",
  title: "Review",
  descriptionPreview: null,
  location: null,
  url: null,
  startsAt: "2026-03-03T23:00:00Z",
  endsAt: "2026-03-04T23:00:00Z",
  allDay: true,
  deadline: null,
  deadlineAllDay: false,
  priority: null,
  recurrence: null,
  recurringEventId: null,
  recurrenceId: null,
  columnId: "Col001",
  assignees: [],
  activeBlockerCount: 0,
};
const zone = { timeZone: "Europe/Berlin" };
test("all-day legacy inclusive ends and exclusive midnight ends map to the same date span", () => {
  const expected = { kind: "date", start: "2026-03-04", end: "2026-03-05" };
  expect(projectSourceItem(item, "v", null, zone)).toMatchObject({ type: "event", time: expected });
  expect(projectSourceItem({ ...item, endsAt: "2026-03-04T22:59:59.999Z" }, "v", null, zone)).toMatchObject({
    type: "event",
    time: expected,
  });
  expect(projectSourceItem({ ...item, startsAt: "2026-03-28T23:00:00Z", endsAt: "2026-03-29T22:00:00Z" }, "v", null, zone)).toMatchObject({
    type: "event",
    time: { kind: "date", start: "2026-03-29", end: "2026-03-30" },
  });
});
test("deadline-only tasks remain points, including date-only and legacy all-day flags", () => {
  for (const [deadline, deadlineAllDay, due] of [
    ["2026-03-04", false, { kind: "date", date: "2026-03-04" }],
    ["2026-03-04T11:00:00Z", true, { kind: "date", date: "2026-03-04" }],
    ["2026-03-04T11:00:00Z", false, { kind: "instant", at: "2026-03-04T11:00:00Z", timeZone: "Europe/Berlin" }],
  ] as const) {
    const result = projectSourceItem({ ...item, startsAt: null, endsAt: null, deadline, deadlineAllDay }, "v", null, zone);
    expect(result).toMatchObject({ type: "deadline", done: false, due });
    expect(result).not.toHaveProperty("time");
    expect(SourceItemSchema.safeParse(result).success).toBe(true);
  }
});
test("moving an occurrence and creating an exception row preserves its identity and series link", () => {
  const recurring = {
    ...item,
    allDay: false,
    recurringEventId: "Series",
    recurrenceId: "2026-03-04T09:00:00.000Z",
    isRecurringInstance: true,
  };
  const original = projectSourceItem({ ...recurring, id: "Series:2026-03-04T09:00:00.000Z" }, "v1", "FREQ=DAILY", zone);
  const moved = projectSourceItem(
    { ...recurring, id: "Except", startsAt: "2026-03-05T10:00:00Z", endsAt: "2026-03-05T11:00:00Z" },
    "v2",
    "FREQ=DAILY",
    zone,
  );
  const longRule = projectSourceItem(recurring, "v3", `FREQ=DAILY${";".repeat(1000)}`, zone);
  expect(longRule.type === "event" && longRule.occurrence?.rule).toBeNull();
  expect(SourceItemSchema.safeParse(longRule).success).toBe(true);
  expect(original.id).toBe(moved.id);
  expect(moved).toMatchObject({
    occurrence: { seriesId: "Series", originalStart: recurring.recurrenceId, rule: "FREQ=DAILY" },
    ref: { type: "spaces.item", id: "Series" },
    open: { rel: "open", href: "/app/spaces/Space1?item=Series&occurrence=2026-03-04T09%3A00%3A00.000Z" },
  });
});
test("calendar selections preserve opaque colons and reject invalid or oversized selections", () => {
  expect(parseCalendarSelections(["absence:mine:team"])).toEqual([{ appId: "absence", calendarId: "mine:team" }]);
  expect(parseCalendarSelections([])).toEqual([]);
  for (const values of [["absence"], [":calendar"], ["absence:"], Array(101).fill("absence:mine")])
    expect(() => parseCalendarSelections(values)).toThrow();
});
