import { describe, expect, test } from "bun:test";
import { activityAgo, activityDayLabel, activityGroup, activityRows, activityWhen } from "./activity-timeline";

// A fixed "now": Friday, 13 Nov 2026, 16:45 in Berlin (CET, UTC+1). Never the clock of the day the test runs.
const NOW = new Date("2026-11-13T15:45:00Z");
const ZONE = "Europe/Berlin";
/** An instant in Berlin time: summer time 2026 until 25 Oct (UTC+2), otherwise UTC+1. */
const berlin = (local: string) =>
  new Date(`${local}:00${local >= "2026-03-29T03:00" && local < "2026-10-25T03:00" ? "+02:00" : "+01:00"}`).toISOString();

describe("dividers", () => {
  test("today, yesterday, the days up to seven back, then one divider", () => {
    expect(activityGroup(berlin("2026-11-13T00:05"), NOW, ZONE)).toEqual({ kind: "today", day: "2026-11-13" });
    expect(activityGroup(berlin("2026-11-12T23:59"), NOW, ZONE)).toEqual({ kind: "yesterday", day: "2026-11-12" });
    expect(activityGroup(berlin("2026-11-06T15:02"), NOW, ZONE)).toEqual({ kind: "day", day: "2026-11-06" });
    expect(activityGroup(berlin("2026-11-05T23:59"), NOW, ZONE)).toEqual({ kind: "older", day: null });
  });

  test("the day counts in the application's time zone, not in UTC", () => {
    // 23:30 UTC on 12 Nov is already 13 Nov in Berlin, and still 12 Nov in UTC.
    expect(activityGroup("2026-11-12T23:30:00Z", NOW, ZONE).kind).toBe("today");
    expect(activityGroup("2026-11-12T23:30:00Z", NOW, "UTC").kind).toBe("yesterday");
  });

  test("an instant in the future stands under today", () => {
    expect(activityGroup(berlin("2026-11-13T17:00"), NOW, ZONE).kind).toBe("today");
  });

  test("a day divider names the weekday; another year adds the year", () => {
    expect(activityDayLabel("2026-11-10", NOW, "de", ZONE)).toBe("Di., 10. Nov.");
    expect(activityDayLabel("2026-11-10", NOW, "en", ZONE)).toBe("Tue, Nov 10");
    expect(activityDayLabel("2025-12-31", NOW, "en", ZONE)).toBe("Wed, Dec 31, 2025");
  });
});

describe("meta line", () => {
  test("time and distance as in the approved mockup", () => {
    const line = (local: string) => `${activityWhen(berlin(local), NOW, "de", ZONE)} · ${activityAgo(berlin(local), NOW, "de", ZONE)}`;
    expect(line("2026-11-13T14:06")).toBe("14:06 · vor 2 Std.");
    expect(line("2026-11-12T17:15")).toBe("17:15 · vor 1 Tag");
    expect(line("2026-11-08T18:32")).toBe("18:32 · vor 5 Tagen");
    expect(line("2026-10-21T14:31")).toBe("21. Okt., 14:31 · vor 3 Wochen");
    expect(line("2025-03-03T09:12")).toBe("3. März 2025, 09:12 · vor 1 Jahr");
  });

  test("minutes, hours, days, weeks, months, years", () => {
    const ago = (local: string) => activityAgo(berlin(local), NOW, "de", ZONE);
    expect(ago("2026-11-13T16:45")).toBe("vor 1 Min.");
    expect(ago("2026-11-13T16:33")).toBe("vor 12 Min.");
    expect(ago("2026-11-13T08:31")).toBe("vor 8 Std.");
    expect(ago("2026-11-04T10:00")).toBe("vor 9 Tagen");
    expect(ago("2026-10-30T10:00")).toBe("vor 2 Wochen");
    expect(ago("2026-09-01T10:00")).toBe("vor 2 Monaten");
    expect(ago("2023-11-01T10:00")).toBe("vor 3 Jahren");
  });

  test("English", () => {
    expect(activityAgo(berlin("2026-11-13T10:45"), NOW, "en", ZONE)).toBe("6 hr. ago");
    expect(activityAgo(berlin("2026-10-21T14:31"), NOW, "en", ZONE)).toBe("3 weeks ago");
    expect(activityWhen(berlin("2026-10-21T14:31"), NOW, "en", ZONE)).toBe("Oct 21, 14:31");
  });

  test("the time reads in the application's time zone", () => {
    expect(activityWhen("2026-11-13T13:06:00Z", NOW, "de", ZONE)).toBe("14:06");
    expect(activityWhen("2026-11-13T13:06:00Z", NOW, "de", "UTC")).toBe("13:06");
  });
});

describe("rows", () => {
  type E = { at: string; kind: string; who: string };
  const e = (local: string, kind: string, who = "Mira Lang"): E => ({ at: berlin(local), kind, who });
  const key = (entry: E) => (entry.kind === "single" ? null : `${entry.kind}|${entry.who}`);
  const rows = (entries: E[], withKey = true) => activityRows(entries, { now: NOW, timeZone: ZONE, key: withKey ? key : undefined });

  test("newest first, a divider only on the first row of a group", () => {
    const result = rows([
      e("2026-10-27T10:38", "single"),
      e("2026-11-13T08:30", "single"),
      e("2026-11-13T08:31", "single"),
      e("2026-10-28T08:14", "single"),
    ]);
    expect(result.map((row) => [row.entry.at, row.divider?.kind ?? null])).toEqual([
      [berlin("2026-11-13T08:31"), "today"],
      [berlin("2026-11-13T08:30"), null],
      [berlin("2026-10-28T08:14"), "older"],
      [berlin("2026-10-27T10:38"), null],
    ]);
  });

  test("equal entries after each other on the same day become one row with a count; the newest leads", () => {
    const result = rows([
      e("2026-11-13T13:00", "fetch", "automatic"),
      e("2026-11-13T12:00", "fetch", "automatic"),
      e("2026-11-13T11:00", "fetch", "automatic"),
      e("2026-11-13T14:06", "fetch"),
      e("2026-11-12T17:15", "fetch", "automatic"),
    ]);
    expect(result.map((row) => [row.entry.at, row.all.length])).toEqual([
      [berlin("2026-11-13T14:06"), 1],
      [berlin("2026-11-13T13:00"), 3],
      [berlin("2026-11-12T17:15"), 1],
    ]);
  });

  test("an entry in between splits a bundle; without a key nothing bundles", () => {
    const result = rows([
      e("2026-11-13T13:00", "fetch"),
      e("2026-11-13T12:00", "note"),
      e("2026-11-13T11:00", "fetch"),
      e("2026-11-13T10:00", "single"),
      e("2026-11-13T09:00", "single"),
    ]);
    expect(result.map((row) => row.all.length)).toEqual([1, 1, 1, 1, 1]);
    expect(rows([e("2026-11-13T13:00", "fetch"), e("2026-11-13T12:00", "fetch")], false).map((row) => row.all.length)).toEqual([1, 1]);
  });

  test("equal times keep the order of the input", () => {
    const result = activityRows([e("2026-11-12T17:15", "single", "a"), e("2026-11-12T17:15", "single", "b")], { now: NOW, timeZone: ZONE });
    expect(result.map((row) => row.entry.who)).toEqual(["a", "b"]);
  });
});
