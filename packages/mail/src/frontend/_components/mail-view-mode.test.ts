import { expect, test } from "bun:test";
import { mailDayGroup, mailDayGroupStarts, resolveMailLargeLayout, toggleMailLargeView } from "./mail-view-mode";

test("auto shows columns until a conversation opens, then the list beside the reader", () => {
  expect(resolveMailLargeLayout("auto", false)).toEqual({ rows: "columns", list: "full", reader: false });
  expect(resolveMailLargeLayout("auto", true)).toEqual({ rows: "lines", list: "pane", reader: true });
  expect(resolveMailLargeLayout("columns", true)).toEqual({ rows: "columns", list: "hidden", reader: true });
  expect(resolveMailLargeLayout("split", false)).toEqual({ rows: "lines", list: "pane", reader: true });
});

test("V switches to the view that is not on screen", () => {
  expect(toggleMailLargeView("auto", false)).toBe("split");
  expect(toggleMailLargeView("auto", true)).toBe("columns");
  expect(toggleMailLargeView("split", false)).toBe("columns");
  expect(toggleMailLargeView("columns", true)).toBe("split");
});

// Wednesday, 28 October 2026, 09:00 in Berlin (CET after the clocks went back on Sunday).
const now = new Date("2026-10-28T08:00:00Z");
const zone = "Europe/Berlin";

test("day groups follow the person's calendar, not UTC", () => {
  expect(mailDayGroup("2026-10-27T23:30:00Z", now, zone)).toBe("today");
  expect(mailDayGroup("2026-10-27T22:59:00Z", now, zone)).toBe("yesterday");
  expect(mailDayGroup("2026-10-26T06:00:00Z", now, zone)).toBe("week");
  // Sunday before the week started; the clocks changed that night.
  expect(mailDayGroup("2026-10-25T12:00:00Z", now, zone)).toBe("earlier");
});

test("on a Monday, Saturday already belongs to earlier weeks", () => {
  const monday = new Date("2026-10-26T08:00:00Z");
  expect(mailDayGroup("2026-10-25T12:00:00Z", monday, zone)).toBe("yesterday");
  expect(mailDayGroup("2026-10-24T12:00:00Z", monday, zone)).toBe("earlier");
});

test("with Sunday as the first day, Sunday already belongs to this week", () => {
  expect(mailDayGroup("2026-10-25T12:00:00Z", now, zone, 0)).toBe("week");
});

test("a heading goes before the first item of every group", () => {
  const items = ["2026-10-28T07:00:00Z", "2026-10-28T06:00:00Z", "2026-10-27T10:00:00Z", "2026-10-26T10:00:00Z", "2026-10-20T10:00:00Z"].map(
    (latestMessageAt) => ({ latestMessageAt }),
  );
  expect([...mailDayGroupStarts(items, now, zone)]).toEqual([
    [0, "today"],
    [2, "yesterday"],
    [3, "week"],
    [4, "earlier"],
  ]);
});
