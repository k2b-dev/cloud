import { describe, expect, test } from "bun:test";
import { mailV2LaterTimes } from "./mail-v2-later";
import { mailV2Messages } from "./mail-v2-messages";

const de = mailV2Messages.resolve(["de"]).t;
const en = mailV2Messages.resolve(["en"]).t;
const berlin = { locale: "de", timeZone: "Europe/Berlin" };
/** The times as one line each; Intl may join a time and "PM" with a narrow space. */
const lines = (times: ReturnType<typeof mailV2LaterTimes>) =>
  times.map((time) => `${time.label}${time.meta ? ` · ${time.meta}` : ""} = ${time.at}`.replace(/ /g, " "));

describe("Mail v2 Later and Remind me: the offered times", () => {
  test("before 17:00 on a weekday: today at 17:00, tomorrow at 8:00 and next week's Monday at 8:00", () => {
    // Wednesday, 11:00 in Berlin
    expect(lines(mailV2LaterTimes(berlin, de, Date.parse("2026-11-25T10:00:00Z")))).toEqual([
      "Heute, 17:00 = 2026-11-25T16:00:00.000Z",
      "Morgen, 8:00 · Do., 26. Nov. = 2026-11-26T07:00:00.000Z",
      "Nächste Woche · Mo., 30. Nov., 8:00 = 2026-11-30T07:00:00.000Z",
    ]);
  });

  test("from 17:00 on, today is no longer offered", () => {
    expect(lines(mailV2LaterTimes(berlin, de, Date.parse("2026-11-25T16:00:00Z")))[0]).toStartWith("Morgen, 8:00");
    expect(lines(mailV2LaterTimes(berlin, de, Date.parse("2026-11-25T15:59:00Z")))[0]).toStartWith("Heute, 17:00");
  });

  test("on Friday and Saturday the next week is named by its day; on Sunday it is tomorrow and stands once", () => {
    expect(lines(mailV2LaterTimes(berlin, de, Date.parse("2026-11-27T10:00:00Z")))).toEqual([
      "Heute, 17:00 = 2026-11-27T16:00:00.000Z",
      "Morgen, 8:00 · Sa., 28. Nov. = 2026-11-28T07:00:00.000Z",
      "Montag, 8:00 · 30. Nov. = 2026-11-30T07:00:00.000Z",
    ]);
    expect(lines(mailV2LaterTimes(berlin, de, Date.parse("2026-11-28T18:00:00Z")))).toEqual([
      "Morgen, 8:00 · So., 29. Nov. = 2026-11-29T07:00:00.000Z",
      "Montag, 8:00 · 30. Nov. = 2026-11-30T07:00:00.000Z",
    ]);
    expect(lines(mailV2LaterTimes(berlin, de, Date.parse("2026-11-29T10:00:00Z")))).toEqual([
      "Heute, 17:00 = 2026-11-29T16:00:00.000Z",
      "Morgen, 8:00 · Mo., 30. Nov. = 2026-11-30T07:00:00.000Z",
    ]);
  });

  test("the day and the hours are the person's time zone, not UTC or the server's", () => {
    // 23:30 UTC on Wednesday is Thursday 00:30 in Berlin and Wednesday 18:30 in New York.
    const now = Date.parse("2026-11-25T23:30:00Z");
    expect(lines(mailV2LaterTimes(berlin, de, now))[0]).toBe("Heute, 17:00 = 2026-11-26T16:00:00.000Z");
    expect(lines(mailV2LaterTimes({ locale: "de", timeZone: "America/New_York" }, de, now))).toEqual([
      "Morgen, 8:00 · Do., 26. Nov. = 2026-11-26T13:00:00.000Z",
      "Nächste Woche · Mo., 30. Nov., 8:00 = 2026-11-30T13:00:00.000Z",
    ]);
  });

  test("across a DST change the wall time stays 8:00 and 17:00", () => {
    // Saturday before the clocks go back in Berlin (Sunday, 25 October 2026, 03:00 → 02:00): 17:00 is still summer
    // time (UTC+2), tomorrow's and Monday's 8:00 are winter time (UTC+1).
    expect(lines(mailV2LaterTimes(berlin, de, Date.parse("2026-10-24T08:00:00Z")))).toEqual([
      "Heute, 17:00 = 2026-10-24T15:00:00.000Z",
      "Morgen, 8:00 · So., 25. Okt. = 2026-10-25T07:00:00.000Z",
      "Montag, 8:00 · 26. Okt. = 2026-10-26T07:00:00.000Z",
    ]);
    // The clocks go forward on Sunday, 28 March 2027: Monday's 8:00 is summer time.
    expect(lines(mailV2LaterTimes(berlin, de, Date.parse("2027-03-26T08:00:00Z"))).at(-1)).toBe(
      "Montag, 8:00 · 29. März = 2027-03-29T06:00:00.000Z",
    );
  });

  test("the words and the clock follow the locale", () => {
    expect(lines(mailV2LaterTimes({ locale: "en", timeZone: "Europe/Berlin" }, en, Date.parse("2026-11-27T10:00:00Z")))).toEqual([
      "Today, 5:00 PM = 2026-11-27T16:00:00.000Z",
      "Tomorrow, 8:00 AM · Sat, Nov 28 = 2026-11-28T07:00:00.000Z",
      "Monday, 8:00 AM · Nov 30 = 2026-11-30T07:00:00.000Z",
    ]);
  });
});
