import { describe, expect, test } from "bun:test";
import { dates } from "@k2b/stdlib";
import { timelineFrom, timelineItems, timelineTo, timelineZone } from "../../test/timeline-data";
import {
  buildTimelineModel,
  spanCss,
  spanPx,
  type TimelineItem,
  type TimelineItemEntry,
  type TimelineModel,
  type TimelineMoreEntry,
  type TimelineUnits,
  timelineDayKey,
  timelineHourOf,
} from "./timeline-model";

const context = { timeZone: timelineZone, locale: "en" };
const units: TimelineUnits = [54, 48, 160, 40, 32];
const time = (value: string) => new Date(value).getTime();
const at = (day: number, clock: string) => time(`2026-10-${String(day).padStart(2, "0")}T${clock}:00+02:00`);
const date = (day: number, clock: string) => new Date(at(day, clock));
const model = (items: readonly TimelineItem[] = timelineItems, from = timelineFrom, to = timelineTo, today = "2026-10-08") =>
  buildTimelineModel({ from: time(from), to: time(to), today, items, context });
const px = (built: TimelineModel, t: number) => spanPx(built.posOf(t), units);
const entry = (built: TimelineModel, id: string) => built.entries.get(id) as TimelineItemEntry;

describe("Timeline model", () => {
  test("keeps waking hours proportional and folds every night and every run of empty days", () => {
    const built = model();
    expect(built.groups.map((group) => group.key)).toEqual([
      "day:2026-10-07",
      "day:2026-10-08",
      "day:2026-10-09",
      "fold:2026-10-10:2026-10-11",
      "day:2026-10-12",
      "day:2026-10-13",
    ]);
    // An hour is one hour unit; a night is one night unit, whatever its length.
    expect(px(built, at(8, "10:00")) - px(built, at(8, "09:00"))).toBe(54);
    expect(px(built, at(9, "06:00")) - px(built, at(8, "22:00"))).toBe(48 + 40 + 32);
    // The weekend is one fold from Friday 22:00 to Monday 06:00, then Monday's heading and all-day row.
    expect(px(built, at(12, "06:00")) - px(built, at(9, "22:00"))).toBe(160 + 40 + 32);
    expect(spanCss(built.posOf(at(8, "07:30")))).toBe(
      "calc(5.5 * var(--k2b-timeline-hour) + 1 * var(--k2b-timeline-night) + 2 * var(--k2b-timeline-head) + 2 * var(--k2b-timeline-row))",
    );
  });

  test("always keeps today open and starts the strip at the first loaded time", () => {
    const built = model([], "2026-10-08T12:00:00+02:00", "2026-10-09T00:00:00+02:00");
    expect(built.groups.map((group) => [group.key, group.today])).toEqual([["day:2026-10-08", true]]);
    expect(px(built, at(8, "12:00"))).toBe(40);
    expect(built.groups[0]!.hours.map((hour) => new Date(hour.time).getUTCHours())).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  test("keeps a day open while its waking hours are loaded only in part, at either edge", () => {
    // Wednesday's evening and Tuesday's morning are empty, but the rest of either day is not loaded yet.
    const built = model([], "2026-10-07T18:00:00+02:00", "2026-10-13T12:00:00+02:00");
    expect(built.groups.map((group) => group.key)).toEqual([
      "day:2026-10-07",
      "day:2026-10-08",
      "fold:2026-10-09:2026-10-12",
      "day:2026-10-13",
    ]);
    // A whole empty day at the edge folds: its waking hours are all loaded.
    expect(model([], "2026-10-07T05:00:00+02:00", "2026-10-08T22:00:00+02:00").groups.map((group) => group.key)).toEqual([
      "fold:2026-10-07:2026-10-07",
      "day:2026-10-08",
    ]);
  });

  test("gives every loaded day its group, also today when the range ends in the night before it", () => {
    const items: TimelineItem[] = [
      { id: "a", label: "A", start: date(8, "10:00"), end: date(8, "11:00") },
      { id: "n", label: "Night", start: date(9, "01:00"), end: date(9, "02:00") },
      { id: "h", label: "Holiday", start: "2026-10-09", allDay: true },
    ];
    const built = model(items, "2026-10-08T00:00:00+02:00", "2026-10-09T03:00:00+02:00", "2026-10-09");
    expect(built.groups.map((group) => [group.key, group.today])).toEqual([
      ["day:2026-10-08", false],
      ["day:2026-10-09", true],
    ]);
    const night = entry(built, "n");
    expect([night.kind, built.groups[night.group]!.key]).toEqual(["folded", "day:2026-10-09"]);
    expect(entry(built, "h").group).toBe(1);
    // Today's group holds no time of its own: the night before it reaches the end of the range.
    expect(spanPx(built.groups[1]!.size, units)).toBe(40 + 32);
  });

  test("shifts every time from the end of a leading night or fold by one amount when earlier days load", () => {
    // The start edge lies in a night (Thursday from midnight) or a fold (an empty Wednesday): a load re-spreads the
    // times inside it, but not the times after it, which the component holds in place.
    for (const [from, items] of [
      ["2026-10-08T00:00:00+02:00", timelineItems],
      ["2026-10-07T00:00:00+02:00", timelineItems.filter((item) => item.id !== "e1")],
    ] as const) {
      const before = model(items, from);
      const after = model(items, "2026-10-01T00:00:00+02:00");
      const first = before.segments.find((segment) => segment.t1 > segment.t0)!;
      expect(first.kind).not.toBe("wake");
      const shifts = [first.t1, at(8, "08:30"), at(9, "12:00"), at(13, "20:00")].map((t) => px(after, t) - px(before, t));
      expect(new Set(shifts.map((shift) => shift.toFixed(6))).size).toBe(1);
      // Inside the night or fold, the same time lands elsewhere.
      expect(px(after, first.t0) - px(before, first.t0)).not.toBeCloseTo(shifts[0]!, 3);
    }
  });

  test("keeps a day with only night items folded, and stacks those items in their fold under their own day", () => {
    const built = model();
    const night = entry(built, "n1");
    expect(night.kind).toBe("folded");
    expect(built.groups[night.group]!.key).toBe("day:2026-10-09");
    // Placed over the whole night fold before Friday, which lies before Friday's group.
    expect(spanPx(night.at, units)).toBe(-48);
    expect(spanPx(night.size, units)).toBe(48);
    expect([night.lane, night.lanes]).toEqual([0, 1]);
  });

  test("stacks up to three items in a night or fold and collapses the rest into a +n entry in the third place", () => {
    // Nightly backups at 02:00 over a quiet week, and a task due at 23:59 before it.
    const items: TimelineItem[] = [
      ...Array.from({ length: 6 }, (_, day) => ({
        id: `b${day}`,
        label: "Backup",
        start: date(9 + day, "02:00"),
        kind: "marker" as const,
      })),
      { id: "due", label: "Report due", start: date(9, "23:59"), kind: "marker", checked: false },
    ];
    const built = model(items, "2026-10-08T06:00:00+02:00", "2026-10-15T00:00:00+02:00");
    const fold = built.groups.find((group) => group.kind === "fold")!;
    // From Thursday 22:00, the fold holds all seven in time order.
    expect(fold.key).toBe("fold:2026-10-09:2026-10-14");
    expect([entry(built, "b0").kind, entry(built, "b0").lane, entry(built, "b0").lanes]).toEqual(["folded", 0, 3]);
    expect([entry(built, "due").lane, entry(built, "due").lanes]).toEqual([1, 3]);
    const more = built.entries.get("more:b1") as TimelineMoreEntry;
    expect([more.kind, more.area, more.lane, more.lanes]).toEqual(["more", "fold", 2, 3]);
    expect(more.hidden.map((hidden) => hidden.id)).toEqual(["b1", "b2", "b3", "b4", "b5"]);
    expect([spanPx(more.at, units), spanPx(more.size, units)]).toEqual([spanPx(entry(built, "b0").at, units), 160]);
    expect(fold.entries.map((value) => value.id)).toEqual(["b0", "due", "more:b1"]);
  });

  test("gives a +n entry an id no item has", () => {
    const items: TimelineItem[] = ["a", "b", "c", "d"].map((id) => ({ id, label: id, start: date(8, "09:00"), end: date(8, "10:00") }));
    const built = model([...items, { id: "more:c", label: "Taken", start: date(8, "12:00"), kind: "marker" }]);
    expect(built.entries.get("more:c")?.kind).toBe("marker");
    expect((built.entries.get("more:c:2") as TimelineMoreEntry).hidden.map((hidden) => hidden.id)).toEqual(["c", "d"]);
    expect(new Set(built.order).size).toBe(built.order.length);
  });

  test("labels a band cut by the range with its own times", () => {
    const built = model([{ id: "x", label: "Offsite", start: date(7, "17:00"), end: date(7, "19:00") }]);
    const band = entry(built, "x");
    expect([band.start, band.end]).toEqual([at(7, "17:00"), at(7, "19:00")]);
    // Its place starts with the range.
    expect(spanPx(built.groups[band.group]!.at, units) + spanPx(band.at, units)).toBe(px(built, time(timelineFrom)));
    expect(spanPx(band.size, units)).toBe(54);
  });

  test("lays out up to three overlapping bands and collapses the rest into a +n entry in the third lane", () => {
    const built = model();
    const lanes = (id: string) => [entry(built, id).lane, entry(built, id).lanes];
    expect(lanes("e3")).toEqual([0, 2]);
    expect(lanes("e4")).toEqual([1, 2]);
    // Monday 09:00–12:00 needs four lanes: two stay, the others become one +n entry.
    expect(lanes("e12")).toEqual([0, 3]);
    expect(lanes("e13")).toEqual([1, 3]);
    const more = built.entries.get("more:e14") as TimelineMoreEntry;
    expect(more.kind).toBe("more");
    expect(more.area).toBe("band");
    expect(more.hidden.map((hidden) => hidden.id)).toEqual(["e14", "e15"]);
    expect([more.lane, more.lanes]).toEqual([2, 3]);
    expect(more.start).toBe(at(12, "10:00"));
    expect(more.end).toBe(at(12, "12:00"));
    expect(built.entries.has("e14")).toBe(false);
  });

  test("shows two lanes of all-day items, collapses only where a third is needed, and echoes them on covered days", () => {
    const items: TimelineItem[] = [
      { id: "a", label: "A", start: "2026-10-08", end: "2026-10-10", allDay: true },
      { id: "b", label: "B", start: "2026-10-08", allDay: true },
      { id: "c", label: "C", start: "2026-10-09", allDay: true },
      { id: "d", label: "D", start: "2026-10-09", end: "2026-10-09T18:00:00+02:00", allDay: true },
    ];
    const built = model(items, "2026-10-08T06:00:00+02:00", "2026-10-10T00:00:00+02:00");
    const [thursday, friday] = built.groups;
    expect(entry(built, "a").lane).toBe(0);
    expect(entry(built, "b").lane).toBe(1);
    const more = built.entries.get("more:c") as TimelineMoreEntry;
    expect(more.hidden.map((hidden) => hidden.id)).toEqual(["c", "d"]);
    expect(more.lane).toBe(1);
    expect(thursday!.entries.map((value) => value.id)).toEqual(["a", "b"]);
    expect(friday!.entries.map((value) => value.id)).toEqual(["more:c"]);
    expect(friday!.echoes.map((value) => value.id)).toEqual(["a"]);
    expect([thursday!.row, friday!.row]).toEqual([true, true]);
    // A multi-day item spans from the start of its first group to the end of its last.
    expect(spanPx(entry(built, "a").size, units)).toBe(spanPx(thursday!.size, units) + spanPx(friday!.size, units));
  });

  test("lists all-day items first, then timed entries by start, and keeps that order for the keyboard", () => {
    const built = model();
    const thursday = built.groups[1]!;
    expect(thursday.entries.map((value) => value.id)).toEqual(["a2", "e2", "e3", "e4", "e5", "t1", "e6", "t2", "e7"]);
    expect(built.order.slice(0, 4)).toEqual(["a1", "e1", "a2", "e2"]);
    expect(new Set(built.order).size).toBe(built.order.length);
  });

  test("labels free time of an hour or more in half hours and marks three hours as long", () => {
    const built = model();
    const monday = built.groups.find((group) => group.key === "day:2026-10-12")!;
    expect(monday.gaps.map((gap) => [gap.hours, gap.long])).toEqual([
      [2.5, false],
      [1, false],
      [2, false],
      [1.5, false],
    ]);
    const tuesday = built.groups.find((group) => group.key === "day:2026-10-13")!;
    expect(tuesday.gaps.map((gap) => [gap.hours, gap.long])).toEqual([
      [2.5, false],
      [13, true],
    ]);
  });

  test("turns the time at a position back into that time", () => {
    const built = model();
    for (const t of [at(8, "06:00"), at(8, "14:20"), at(9, "21:59"), at(12, "08:30")]) {
      expect(Math.abs(built.timeAt(px(built, t), units) - t)).toBeLessThan(1_000);
    }
  });

  test("shifts every known position by the same amount when earlier days load", () => {
    const before = model();
    const after = model(timelineItems, "2026-10-05T00:00:00+02:00");
    const shifts = [at(8, "06:00"), at(8, "14:20"), at(9, "12:00"), at(12, "10:00"), at(13, "20:00")].map(
      (t) => px(after, t) - px(before, t),
    );
    expect(shifts[0]).toBeGreaterThan(0);
    expect(new Set(shifts.map((shift) => shift.toFixed(6))).size).toBe(1);
  });

  test("keeps a day of waking hours sixteen hours long across both clock changes", () => {
    for (const [from, to, today, open] of [
      ["2026-10-25T00:00:00+02:00", "2026-10-26T00:00:00+01:00", "2026-10-25", "2026-10-25T05:00:00.000Z"],
      ["2026-03-29T00:00:00+01:00", "2026-03-30T00:00:00+02:00", "2026-03-29", "2026-03-29T04:00:00.000Z"],
    ] as const) {
      const built = buildTimelineModel({ from: time(from), to: time(to), today, items: [], context });
      const wake = built.segments.find((segment) => segment.kind === "wake")!;
      expect(spanPx(wake.size, units)).toBe(16 * 54);
      expect(new Date(wake.t0).toISOString()).toBe(open);
      expect(built.groups[0]!.hours).toHaveLength(16);
    }
  });

  test("puts the hour of a repeated midnight on its day, as stdlib does", () => {
    // Amman turned its clocks back from 01:00 to midnight on 25 October 2019, so that midnight happened twice.
    const amman = { timeZone: "Asia/Amman", locale: "en" };
    const built = buildTimelineModel({
      from: timelineHourOf("2019-10-24", 0, amman),
      to: timelineHourOf("2019-10-26", 0, amman),
      today: "2019-10-25",
      items: [{ id: "x", label: "Late call", start: "2019-10-25T00:30:00+03:00", end: "2019-10-25T00:45:00+03:00" }],
      context: amman,
    });
    expect(built.groups.map((group) => group.key)).toEqual(["fold:2019-10-24:2019-10-24", "day:2019-10-25"]);
    expect(built.groups[entry(built, "x").group]!.key).toBe("day:2019-10-25");
  });

  test("returns an empty strip for an empty or inverted range and skips invalid items", () => {
    expect(model([], timelineTo, timelineFrom).groups).toEqual([]);
    const built = model([{ id: "x", label: "Broken", start: "not a date" }]);
    expect(built.entries.size).toBe(0);
  });

  test("finds days and hours in a time zone as stdlib does, across clock changes and repeated midnights", () => {
    for (const timeZone of ["Europe/Berlin", "America/New_York", "Australia/Lord_Howe", "Asia/Kolkata", "Asia/Amman", "America/Havana"]) {
      const zone = { timeZone };
      for (const key of ["2019-10-25", "2026-03-08", "2026-03-29", "2026-10-04", "2026-10-25", "2026-11-01", "2026-12-31"]) {
        for (const hour of [0, 6, 12, 22]) {
          const value = `${key}T${String(hour).padStart(2, "0")}:00`;
          const expected = new Date(dates.zonedDateTimeToInstant(value, timeZone, { disambiguation: "compatible" })).getTime();
          expect(timelineHourOf(key, hour, zone)).toBe(expected);
          expect(timelineDayKey(expected, zone)).toBe(dates.formatDateKey(new Date(expected), zone));
        }
      }
    }
  });
});
