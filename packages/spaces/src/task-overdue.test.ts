import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import type { SpaceItem } from "./contracts";
import { isTaskOverdue } from "./task-overdue";

const now = new Date("2026-10-09T08:00:00Z");
const berlin = { timeZone: "Europe/Berlin" };
const task: Pick<SpaceItem, "startsAt" | "endsAt" | "deadline" | "completedAt"> = {
  startsAt: null,
  endsAt: null,
  deadline: "2026-10-08T15:00:00Z",
  completedAt: null,
};

beforeEach(() => setSystemTime(now));
afterEach(() => setSystemTime());

describe("task overdue at local day boundaries", () => {
  test("only open tasks with a past-day deadline are overdue", () => {
    expect(isTaskOverdue(task, berlin)).toBeTrue();
    expect(isTaskOverdue({ ...task, completedAt: "2026-10-08T16:00:00Z" }, berlin)).toBeFalse();
    expect(isTaskOverdue({ ...task, deadline: null }, berlin)).toBeFalse();
    expect(isTaskOverdue({ ...task, startsAt: "2026-10-08T09:00:00Z", endsAt: "2026-10-08T10:00:00Z" }, berlin)).toBeFalse();
  });

  test.each([
    ["earlier today", "2026-10-09T06:00:00Z", false],
    ["exactly midnight today", "2026-10-08T22:00:00Z", false],
    ["one minute before midnight", "2026-10-08T21:59:00Z", true],
    ["yesterday's date-only deadline at 17:00 local", "2026-10-08T15:00:00Z", true],
    ["today's date-only deadline at 17:00 local", "2026-10-09T15:00:00Z", false],
    ["future deadline", "2026-10-10T15:00:00Z", false],
  ])("%s", (_label, deadline, expected) => {
    expect(isTaskOverdue({ ...task, deadline }, berlin)).toBe(expected);
  });

  test("the same instant can be yesterday in UTC and today in Berlin", () => {
    const item = { ...task, deadline: "2026-10-08T22:30:00Z" };
    expect(isTaskOverdue(item, berlin)).toBeFalse();
    expect(isTaskOverdue(item, { timeZone: "UTC" })).toBeTrue();
  });

  test.each(["2026-03-29T08:00:00Z", "2026-10-25T08:00:00Z"])("uses local midnight across the DST change on %s", (instant) => {
    setSystemTime(new Date(instant));
    const localMidnight = instant.startsWith("2026-03") ? "2026-03-28T23:00:00Z" : "2026-10-24T22:00:00Z";
    expect(isTaskOverdue({ ...task, deadline: localMidnight }, berlin)).toBeFalse();
    expect(isTaskOverdue({ ...task, deadline: new Date(Date.parse(localMidnight) - 60_000).toISOString() }, berlin)).toBeTrue();
  });
});
