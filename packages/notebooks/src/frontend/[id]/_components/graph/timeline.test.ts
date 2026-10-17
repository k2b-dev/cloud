import { expect, test } from "bun:test";
import type { GraphNote } from "./model";
import { sortByChange, timelineArc, timelineArcWidth, timelineGroupLabel, timelineGroups, timelineOrder } from "./timeline";

const note = (id: string, updatedAt: string, order = 0): GraphNote => ({
  id,
  updatedAt,
  order,
  title: id,
  parentId: null,
  area: { key: "top", index: 0, slot: 0, title: null, count: 1 },
  depth: 0,
  out: new Set(),
  in: new Set(),
  neighbours: new Set(),
  deg: 0,
  orphan: true,
});
const options = { now: "2026-10-16T15:30:00Z", timeZone: "Europe/Berlin" };
const groupsAt = (now: string, dates: string[], timeZone = options.timeZone) =>
  timelineGroups(
    dates.map((date, i) => note(String(i), date)),
    { now, timeZone },
  );

test("calendar groups follow recent days, Monday weeks, months and years with localized labels", () => {
  const dates = [
    "2026-10-16",
    "2026-10-15",
    "2026-10-12",
    "2026-10-11",
    "2026-10-05",
    "2026-09-10",
    "2026-03-04",
    "2025-12-30",
    "2024-08-15",
  ];
  const groups = groupsAt(
    options.now,
    dates.map((date) => `${date}T12:00:00Z`),
  );
  expect(groups.map((g) => g.key)).toEqual([
    "today",
    "yesterday",
    "thisWeek",
    "lastWeek",
    "month-2026-09",
    "month-2026-03",
    "year-2025",
    "year-2024",
  ]);
  expect(groups.map((g) => g.notes.map((n) => n.id))).toEqual([["0"], ["1"], ["2"], ["3", "4"], ["5"], ["6"], ["7"], ["8"]]);
  for (const [locale, labels, expected] of [
    [
      "en",
      { today: "Today", yesterday: "Yesterday", thisWeek: "This week", lastWeek: "Last week" },
      ["Today", "Yesterday", "This week", "Last week", "September", "March", "2025", "2024"],
    ],
    [
      "de",
      { today: "Heute", yesterday: "Gestern", thisWeek: "Diese Woche", lastWeek: "Letzte Woche" },
      ["Heute", "Gestern", "Diese Woche", "Letzte Woche", "September", "März", "2025", "2024"],
    ],
  ] as const) {
    expect(groups.map((group) => timelineGroupLabel(group, { locale, labels, timeZone: options.timeZone }))).toEqual([...expected]);
  }
  expect(groups[4]).toMatchObject({ kind: "month", year: 2026, month: 9 });
  expect(groupsAt(options.now, ["2027-01-01T12:00:00Z"])[0]?.kind).toBe("today");
});

test("Monday keeps Sunday in yesterday, Saturday in last week, and the earlier Sunday in its month", () => {
  const groups = groupsAt("2026-10-19T12:00:00Z", ["2026-10-18T12:00:00Z", "2026-10-17T12:00:00Z", "2026-10-11T12:00:00Z"]);
  expect(groups.map((g) => g.key)).toEqual(["yesterday", "lastWeek", "month-2026-10"]);
});

test("the viewer's timezone decides the calendar day of the same instant", () => {
  const now = "2026-10-16T05:30:00Z";
  const dates = ["2026-10-16T02:30:00Z"];
  expect(groupsAt(now, dates, "Europe/Berlin")[0]?.kind).toBe("today");
  expect(groupsAt(now, dates, "America/New_York")[0]?.kind).toBe("yesterday");
});

test("autumn's 25-hour day still counts as yesterday", () => {
  const groups = groupsAt("2026-10-26T00:30:00+01:00", [
    "2026-10-25T00:30:00+02:00",
    "2026-10-25T23:59:00+01:00",
    "2026-10-26T00:01:00+01:00",
  ]);
  expect(groups.map((g) => [g.kind, g.notes.map((n) => n.id)])).toEqual([
    ["today", ["2"]],
    ["yesterday", ["1", "0"]],
  ]);
});

test("spring's 23-hour day does not move Saturday into today or Sunday into this week", () => {
  expect(groupsAt("2026-03-29T23:30:00+02:00", ["2026-03-28T23:59:00+01:00", "2026-03-29T00:30:00+01:00"]).map((g) => g.kind)).toEqual([
    "today",
    "yesterday",
  ]);
  expect(groupsAt("2026-03-30T00:30:00+02:00", ["2026-03-29T00:30:00+01:00", "2026-03-28T23:59:00+01:00"]).map((g) => g.kind)).toEqual([
    "yesterday",
    "lastWeek",
  ]);
});

test("change ordering uses tree order for ties, keeps invalid dates last, and leaves input unchanged", () => {
  const a = note("a", "2026-10-15T12:00:00Z", 1);
  const b = note("b", a.updatedAt, 2);
  const c = note("c", "2026-10-16T12:00:00Z", 3);
  const d = note("d", "bad", 4);
  const e = note("e", "also bad", 5);
  for (const input of [
    [b, e, c, a, d],
    [d, a, c, e, b],
    [a, b, c, d, e],
  ]) {
    const original = [...input];
    expect(timelineOrder(input)).toEqual([c, a, b, d, e]);
    expect(sortByChange(input, "asc")).toEqual([a, b, c, d, e]);
    expect(input).toEqual(original);
  }
  const sameOrder = note("same", a.updatedAt, a.order);
  expect(timelineOrder([sameOrder, a])).toEqual([sameOrder, a]);
  expect(timelineOrder([])).toEqual([]);
});

test("arc widths stay inside each lane and paths start and end on the dot", () => {
  for (const lane of [64, 110, 200]) {
    for (const dy of [0, 1, 10, 100, 1000, 100000]) {
      expect(timelineArcWidth(dy, lane)).toBeLessThanOrEqual(lane - 8);
      expect(timelineArcWidth(-dy, lane)).toBe(timelineArcWidth(dy, lane));
      const path = timelineArc(lane, 20, 20 + dy, lane);
      expect(path.startsWith(`M ${lane.toFixed(1)},20.0 C `)).toBe(true);
      expect(path.endsWith(` ${lane.toFixed(1)},${(20 + dy).toFixed(1)}`)).toBe(true);
    }
  }
  expect(timelineArc(64, 10, 30, 64)).toBe("M 64.0,10.0 C 45.0,10.0 45.0,30.0 64.0,30.0");
});

test("reciprocal links get two separate arcs inside the lane", () => {
  for (const lane of [64, 166]) {
    for (const [y1, y2] of [
      [20, 52],
      [20, 9000],
    ] as const) {
      const down = timelineArc(lane, y1, y2, lane, true);
      const up = timelineArc(lane, y2, y1, lane, true);
      expect(up).not.toBe(timelineArc(lane, y2, y1, lane));
      expect(down).toBe(timelineArc(lane, y1, y2, lane));
      const bow = (path: string) => Number(/C ([\d.-]+),/.exec(path)![1]);
      expect(bow(up)).toBeGreaterThan(bow(down));
      expect(bow(up)).toBeLessThan(lane);
      expect(bow(down)).toBeGreaterThanOrEqual(8);
    }
  }
});
