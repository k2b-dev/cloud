import { describe, expect, test } from "bun:test";
import { completeClockTime, isClockTime } from "./time-input";

describe("Venue time input", () => {
  test("completes short input to a 24-hour clock time", () => {
    expect(["9", "09", "930", "0930", "9:5", "9.30", "23:59", "0"].map(completeClockTime)).toEqual([
      "09:00",
      "09:00",
      "09:30",
      "09:30",
      "09:05",
      "09:30",
      "23:59",
      "00:00",
    ]);
  });

  test("leaves anything that is no time as typed, so the field can say so", () => {
    expect(["24:00", "9:60", "abc", "", "12345"].map(completeClockTime)).toEqual(["24:00", "9:60", "abc", "", "12345"]);
    expect(["09:30", "9:30", "24:00"].map(isClockTime)).toEqual([true, false, false]);
  });
});
