import { describe, expect, test } from "bun:test";
import { dates } from "@k2b/stdlib";
import {
  buildDays,
  type CalendarDayHours,
  clockAt,
  type DayEntry,
  type DayGeometry,
  dayGroups,
  dayHeight,
  dayHeightTerms,
  dayKeyOf,
  dayLanes,
  dayMinuteAt,
  dayTopY,
  dayY,
  dayYTerms,
  freeGaps,
  gapProposal,
  instantInDay,
  instantsInDay,
  minuteInDay,
  placeEntry,
  resizedInDay,
  termsCss,
  wakeMinutes,
} from "./calendar-days";

const hours: CalendarDayHours = [6, 22];
const berlin = { timeZone: "Europe/Berlin" };
const at = (wall: string) => new Date(dates.zonedDateTimeToInstant(wall, "Europe/Berlin", { disambiguation: "compatible" }));
const entry = (id: string, start: string, end: string, extra: Partial<DayEntry<string>> = {}): DayEntry<string> => ({
  item: id,
  start: at(start),
  end: at(end),
  allDay: false,
  marker: false,
  ...extra,
});

describe("the day starts at 06:00", () => {
  test("an instant before six belongs to the night of the day before", () => {
    expect(dayKeyOf(at("2026-10-10T05:59"), hours, berlin)).toBe("2026-10-09");
    expect(dayKeyOf(at("2026-10-10T06:00"), hours, berlin)).toBe("2026-10-10");
    expect(dayKeyOf(at("2026-10-09T23:30"), hours, berlin)).toBe("2026-10-09");
  });

  test("minutes count from six on the wall clock, into the night after midnight", () => {
    expect(minuteInDay("2026-10-09", at("2026-10-09T06:00"), hours, berlin)).toBe(0);
    expect(minuteInDay("2026-10-09", at("2026-10-09T22:30"), hours, berlin)).toBe(990);
    expect(minuteInDay("2026-10-09", at("2026-10-10T02:00"), hours, berlin)).toBe(1200);
    expect(instantInDay("2026-10-09", 1200, hours, berlin).toISOString()).toBe(at("2026-10-10T02:00").toISOString());
    expect(clockAt(1200, hours)).toBe("02:00");
    expect(wakeMinutes(hours)).toBe(960);
  });

  test("an event across midnight that ends by six stays one band of the evening's day", () => {
    const placed = placeEntry(entry("Stage", "2026-10-10T22:30", "2026-10-11T02:00"), hours, berlin);
    expect(placed).toEqual({ kind: "band", key: "2026-10-10", band: { item: "Stage", start: 990, end: 1200 } });
  });

  test("an event that runs past six into the next day is a bar of the all-day row", () => {
    const placed = placeEntry(entry("Trip", "2026-10-20T09:00", "2026-10-22T17:00"), hours, berlin);
    expect(placed).toEqual({ kind: "span", span: { item: "Trip", firstKey: "2026-10-20", lastKey: "2026-10-22", marker: false } });
  });

  test("an all-day event ends on the day before its exclusive midnight", () => {
    const placed = placeEntry(entry("Fair", "2026-10-07T00:00", "2026-10-14T00:00", { allDay: true }), hours, berlin);
    expect(placed).toEqual({ kind: "span", span: { item: "Fair", firstKey: "2026-10-07", lastKey: "2026-10-13", marker: false } });
  });
});

describe("clock changes", () => {
  test("the night of the spring change keeps eight rows on the wall clock", () => {
    // 2026-03-29: 02:00 becomes 03:00 in Berlin, so the night has seven real hours.
    const band = placeEntry(entry("Shift", "2026-03-28T22:00", "2026-03-29T06:00"), hours, berlin);
    expect(band).toEqual({ kind: "band", key: "2026-03-28", band: { item: "Shift", start: 960, end: 1440 } });
    // A wall time the change skips moves forward, as the clock does.
    expect(instantInDay("2026-03-28", 1230, hours, berlin).toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });

  test("an event in the hour the autumn change repeats keeps its real length", () => {
    // 2026-10-25: 03:00 summer time falls back to 02:00, so 02:30 CEST to 02:15 CET lasts 45 minutes.
    const start = new Date("2026-10-25T00:30:00.000Z");
    const end = new Date("2026-10-25T01:15:00.000Z");
    const placed = placeEntry({ item: "Backup", start, end, allDay: false, marker: false }, hours, berlin);
    expect(placed).toEqual({ kind: "band", key: "2026-10-24", band: { item: "Backup", start: 1230, end: 1275 } });
  });

  test("a slot the spring change cuts into keeps the length it was drawn with", () => {
    // 02:30 to 03:00 does not exist on 2026-03-29; 02:30 moves forward to 03:30, past the end.
    const slot = instantsInDay("2026-03-28", 1230, 1260, hours, berlin);
    expect([slot.start.toISOString(), slot.end.toISOString()]).toEqual(["2026-03-29T01:30:00.000Z", "2026-03-29T02:00:00.000Z"]);
    // Elsewhere a slot is its two wall-clock times.
    const morning = instantsInDay("2026-03-29", 180, 240, hours, berlin);
    expect([morning.start.toISOString(), morning.end.toISOString()]).toEqual([
      at("2026-03-29T09:00").toISOString(),
      at("2026-03-29T10:00").toISOString(),
    ]);
  });

  test("a resized entry in the hour the autumn change repeats keeps the instant of its other edge", () => {
    // 02:15 CET, the second 02:15 of 2026-10-25, to 04:00 CET; its end moves to 05:00.
    const entry = { start: new Date("2026-10-25T01:15:00.000Z"), end: new Date("2026-10-25T03:00:00.000Z") };
    const later = resizedInDay(entry, "end", "2026-10-24", { start: 1215, end: 1380 }, hours, berlin);
    expect([later.start.toISOString(), later.end.toISOString()]).toEqual(["2026-10-25T01:15:00.000Z", "2026-10-25T04:00:00.000Z"]);
    // Its start moves to 03:00 CET; the end stays.
    const shorter = resizedInDay(entry, "start", "2026-10-24", { start: 1260, end: 1320 }, hours, berlin);
    expect([shorter.start.toISOString(), shorter.end.toISOString()]).toEqual(["2026-10-25T02:00:00.000Z", "2026-10-25T03:00:00.000Z"]);
  });

  test("the day after a change still starts at six on the wall clock", () => {
    expect(dayKeyOf(at("2026-10-25T05:59"), hours, berlin)).toBe("2026-10-24");
    expect(minuteInDay("2026-10-25", at("2026-10-25T06:00"), hours, berlin)).toBe(0);
    expect(minuteInDay("2026-03-29", at("2026-03-29T06:00"), hours, berlin)).toBe(0);
  });
});

describe("days", () => {
  test("a night with an entry opens, the others stay folded, and empty days are empty", () => {
    const days = buildDays(
      "2026-10-09",
      "2026-10-12",
      [
        entry("Standup", "2026-10-09T09:15", "2026-10-09T09:30"),
        entry("Deadline", "2026-10-09T23:59", "2026-10-09T23:59", { marker: true }),
        entry("Stage", "2026-10-10T22:30", "2026-10-11T02:00"),
      ],
      hours,
      berlin,
    );
    expect([...days.values()].map((day) => [day.key, day.night, day.empty])).toEqual([
      ["2026-10-09", true, false],
      ["2026-10-10", true, false],
      ["2026-10-11", false, true],
      ["2026-10-12", false, true],
    ]);
    expect(days.get("2026-10-09")?.markers).toEqual([{ item: "Deadline", minute: 1079 }]);
  });

  test("a bar reaches every day it covers inside the range", () => {
    const days = buildDays(
      "2026-10-09",
      "2026-10-11",
      [entry("Fair", "2026-10-07T00:00", "2026-10-11T00:00", { allDay: true })],
      hours,
      berlin,
    );
    expect([...days.values()].map((day) => day.spans.length)).toEqual([1, 1, 0]);
  });

  test("runs of empty days merge, today and the opened day never fold, and an unfolded run shows its days", () => {
    const empty = new Set(["2026-10-10", "2026-10-11", "2026-10-13", "2026-10-14"]);
    const keys = ["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14"];
    expect(dayGroups(keys, (key) => empty.has(key), new Set(["2026-10-13"]))).toEqual([
      { kind: "day", key: "2026-10-09" },
      { kind: "empty", keys: ["2026-10-10", "2026-10-11"] },
      { kind: "day", key: "2026-10-12" },
      { kind: "day", key: "2026-10-13" },
      { kind: "empty", keys: ["2026-10-14"] },
    ]);
    // The day the reader opened stays a day of its own.
    expect(dayGroups(keys, (key) => empty.has(key), new Set(["2026-10-01", "2026-10-11"])).slice(1, 3)).toEqual([
      { kind: "empty", keys: ["2026-10-10"] },
      { kind: "day", key: "2026-10-11" },
    ]);
    expect(dayGroups(keys, (key) => empty.has(key), new Set(["2026-10-10", "2026-10-11"])).slice(1, 3)).toEqual([
      { kind: "day", key: "2026-10-10" },
      { kind: "day", key: "2026-10-11" },
    ]);
  });

  test("empty days that load before an unfolded run fold on their own and leave the run open", () => {
    const unfolded = new Set(["2026-10-10", "2026-10-11"]);
    const keys = ["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12"];
    expect(dayGroups(keys, (key) => key !== "2026-10-12", unfolded)).toEqual([
      { kind: "empty", keys: ["2026-10-07", "2026-10-08", "2026-10-09"] },
      { kind: "day", key: "2026-10-10" },
      { kind: "day", key: "2026-10-11" },
      { kind: "day", key: "2026-10-12" },
    ]);
  });
});

describe("free time", () => {
  const bands = [
    { item: "a", start: 195, end: 210 },
    { item: "b", start: 270, end: 315 },
    { item: "c", start: 390, end: 435 },
  ];

  test("lies between the bands of the waking hours", () => {
    expect(freeGaps(bands, 960, Number.NEGATIVE_INFINITY)).toEqual([
      { start: 0, end: 195, past: false },
      { start: 210, end: 270, past: false },
      { start: 315, end: 390, past: false },
      { start: 435, end: 960, past: false },
    ]);
  });

  test("the gap that holds now starts at the next quarter hour, and earlier gaps are past", () => {
    expect(freeGaps(bands, 960, 328)).toEqual([
      { start: 0, end: 195, past: true },
      { start: 210, end: 270, past: true },
      { start: 330, end: 390, past: false },
      { start: 435, end: 960, past: false },
    ]);
  });

  test("leaves out gaps shorter than the minimum", () => {
    expect(freeGaps([{ item: "a", start: 0, end: 950 }], 960, Number.NEGATIVE_INFINITY)).toEqual([]);
    expect(freeGaps([{ item: "a", start: 0, end: 900 }], 960, Number.NEGATIVE_INFINITY, 60)).toEqual([
      { start: 900, end: 960, past: false },
    ]);
  });

  test("creates a short gap whole, a long one for an hour, and a morning from nine", () => {
    expect(gapProposal({ start: 210, end: 270 }, hours)).toEqual([210, 270]);
    expect(gapProposal({ start: 435, end: 960 }, hours)).toEqual([435, 495]);
    expect(gapProposal({ start: 0, end: 960 }, hours)).toEqual([180, 240]);
    expect(gapProposal({ start: 0, end: 200 }, hours)).toEqual([0, 60]);
  });
});

describe("lanes and geometry", () => {
  test("overlapping bands share the width", () => {
    const lanes = dayLanes(
      [
        { item: "a", start: 0, end: 60 },
        { item: "b", start: 30, end: 90 },
        { item: "c", start: 120, end: 130 },
      ],
      20,
    );
    expect(lanes.map((band) => [band.item, band.lane, band.lanes])).toEqual([
      ["a", 0, 2],
      ["b", 1, 2],
      ["c", 0, 1],
    ]);
  });

  test("an open night is half as tall below its bar; a folded one is a row", () => {
    const open: DayGeometry = { hour: 56, nightHour: 28, nightBar: 32, fold: 40, wake: 960, expanded: true };
    expect(dayY(open, 60)).toBe(56);
    expect(dayY(open, 960)).toBe(896);
    expect(dayTopY(open, 960)).toBeCloseTo(928);
    expect(dayY(open, 1440)).toBe(896 + 32 + 8 * 28);
    expect(dayHeight(open)).toBe(896 + 32 + 224);
    expect(dayMinuteAt(open, 896 + 32 + 56)).toBe(1080);
    expect(dayMinuteAt(open, 100)).toBeCloseTo(107.14, 1);
    const folded = { ...open, expanded: false };
    expect(dayHeight(folded)).toBe(936);
    expect(dayMinuteAt(folded, 920)).toBe(960);
  });
});

describe("terms", () => {
  test("say the same as the pixel geometry", () => {
    const open: DayGeometry = { hour: 56, nightHour: 28, nightBar: 32, fold: 40, wake: 960, expanded: true };
    const pixels = (terms: readonly number[]) => terms[0]! * 56 + terms[1]! * 28 + terms[2]! * 32 + terms[3]! * 40;
    for (const minute of [0, 90, 960, 1020, 1440]) {
      expect(pixels(dayYTerms(960, true, minute))).toBeCloseTo(dayY(open, minute));
      expect(pixels(dayYTerms(960, false, minute))).toBeCloseTo(dayY({ ...open, expanded: false }, minute));
    }
    expect(pixels(dayHeightTerms(960, false))).toBe(dayHeight({ ...open, expanded: false }));
    expect(termsCss([1.5, 0, 0, 0])).toBe("calc(1.5 * var(--k2b-calendar-hour))");
    expect(termsCss([0, 0, 0, 0])).toBe("0px");
  });
});
