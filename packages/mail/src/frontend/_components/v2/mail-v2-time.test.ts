import { describe, expect, test } from "bun:test";
import { mailV2MessageTime, mailV2RowTime } from "./mail-v2-time";

// A Friday morning in Berlin; the times below are UTC.
const now = Date.parse("2026-11-27T09:00:00.000Z");
const de = { locale: "de", timeZone: "Europe/Berlin" };

describe("Mail v2 times", () => {
  test("a row names the time today, yesterday, the weekday within a week", () => {
    expect(mailV2RowTime("2026-11-27T08:42:00.000Z", de, now)).toBe("09:42");
    expect(mailV2RowTime("2026-11-26T15:00:00.000Z", de, now)).toBe("gestern");
    expect(mailV2RowTime("2026-11-25T08:00:00.000Z", de, now)).toMatch(/^Mi\.?$/);
  });

  test("the day follows the reader's time zone, not UTC", () => {
    // 23:30 UTC on Thursday is already Friday in Berlin.
    expect(mailV2RowTime("2026-11-26T23:30:00.000Z", de, now)).toBe("00:30");
  });

  test("a message names its day and its time", () => {
    expect(mailV2MessageTime("2026-11-27T08:42:00.000Z", de, now)).toBe("heute, 09:42");
    expect(mailV2MessageTime("2026-11-26T15:02:00.000Z", de, now)).toBe("gestern, 16:02");
    expect(mailV2MessageTime("2026-11-27T08:42:00.000Z", { locale: "en", timeZone: "Europe/Berlin" }, now)).toBe("today, 09:42 AM");
  });
});
