import { describe, expect, test } from "bun:test";
import type { UpcomingSlot } from "../../../contracts";
import { defaultShiftRange, groupSlotsByDay, nextQuarterHour } from "./utils";

describe("Venue workspace helpers", () => {
  test("free time starts at the next quarter hour and lasts two hours", () => {
    expect(nextQuarterHour(new Date("2026-09-28T13:29:12.000Z")).toISOString()).toBe("2026-09-28T13:30:00.000Z");
    expect(nextQuarterHour(new Date("2026-09-28T13:30:00.000Z")).toISOString()).toBe("2026-09-28T13:30:00.000Z");
    expect(nextQuarterHour(new Date("2026-09-28T13:30:00.001Z")).toISOString()).toBe("2026-09-28T13:45:00.000Z");
    expect(nextQuarterHour(new Date("2026-09-28T23:52:00.000Z")).toISOString()).toBe("2026-09-29T00:00:00.000Z");
    expect(defaultShiftRange(new Date("2026-09-28T13:29:00.000Z"))).toEqual({
      start: "2026-09-28T13:30:00.000Z",
      end: "2026-09-28T15:30:00.000Z",
    });
  });

  test("groups shifts by their day and keeps their order", () => {
    const slot = (date: string, title: string) => ({ date, template: { title } }) as UpcomingSlot;
    const groups = groupSlotsByDay([slot("2026-09-29", "Early"), slot("2026-09-29", "Late"), slot("2026-10-01", "Lunch")]);
    expect(groups.map((group) => [group.date, group.slots.map((entry) => entry.template.title)])).toEqual([
      ["2026-09-29", ["Early", "Late"]],
      ["2026-10-01", ["Lunch"]],
    ]);
    expect(groupSlotsByDay([])).toEqual([]);
  });
});
