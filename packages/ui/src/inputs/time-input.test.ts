import { describe, expect, test } from "bun:test";
import { filterTimeText, parseTimeText, snapTime, timeLimitError, timeToMinutes } from "./time-input";

const read = (text: string) => {
  const result = parseTimeText(text);
  return result.kind === "time" ? result.value : result.kind;
};

describe("time input rules", () => {
  test("typing keeps up to four digits and one separator after the hour", () => {
    expect(["9", "9:3", "9.30", "9h30", "930", "0930", "12345", "1a2b", "930:", ":30", "09:305"].map(filterTimeText)).toEqual([
      "9",
      "9:3",
      "9:30",
      "9:30",
      "930",
      "0930",
      "1234",
      "12",
      "930",
      "30",
      "09:30",
    ]);
  });

  test("short input means a full clock time", () => {
    expect(["9", "09", "930", "0930", "9:5", "9:30", "9.30", "9:", "23:59", "0", "24", "2400", " 7 "].map(read)).toEqual([
      "09:00",
      "09:00",
      "09:30",
      "09:30",
      "09:05",
      "09:30",
      "09:30",
      "09:00",
      "23:59",
      "00:00",
      "24:00",
      "24:00",
      "07:00",
    ]);
  });

  test("anything else is no time, and an empty text is empty", () => {
    expect(["24:01", "25", "9:60", "abc", "12345", "1:2:3"].map(read)).toEqual(["error", "error", "error", "error", "error", "error"]);
    expect(read("")).toBe("empty");
    expect(read("  ")).toBe("empty");
  });

  test("a step snaps to its grid from the earliest time or midnight and never leaves the day", () => {
    expect(snapTime("09:07", 15)).toBe("09:00");
    expect(snapTime("09:08", 15)).toBe("09:15");
    expect(snapTime("09:07", 15, "08:10")).toBe("09:10");
    expect(snapTime("23:58", 30)).toBe("23:30");
    expect(snapTime("09:07", 1)).toBe("09:07");
    expect(snapTime("09:07", undefined)).toBe("09:07");
  });

  test("bounds name the nearest allowed time; 24:00 is allowed only through max", () => {
    expect(timeLimitError("07:30", { min: "08:00" })).toEqual({ code: "earliest", time: "08:00" });
    expect(timeLimitError("18:30", { max: "18:00" })).toEqual({ code: "latest", time: "18:00" });
    expect(timeLimitError("12:00", { min: "08:00", max: "18:00" })).toBeUndefined();
    expect(timeLimitError("24:00", {})).toEqual({ code: "latest", time: "23:59" });
    expect(timeLimitError("24:00", { max: "24:00" })).toBeUndefined();
    expect(timeToMinutes("24:00")).toBe(1440);
    expect(timeToMinutes("24:01")).toBeNull();
    expect(timeToMinutes("9:30")).toBeNull();
  });
});
