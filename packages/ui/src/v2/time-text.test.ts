import { describe, expect, test } from "bun:test";
import { caretInHour, formatTime, parseTime, stepTime, usesDayPeriods } from "./time-text";

describe("a time of day in the @k2b/ui locale", () => {
  test("German writes 24 hours, American English twelve with a day period", () => {
    expect(usesDayPeriods("de")).toBe(false);
    expect(formatTime("14:30", "de")).toBe("14:30");
    expect(formatTime("09:05", "de")).toBe("09:05");
    expect(formatTime("00:00", "de")).toBe("00:00");
    expect(usesDayPeriods("en-US")).toBe(true);
    expect(formatTime("14:30", "en-US").replace(/\s/g, " ")).toBe("2:30 PM");
    expect(formatTime("00:15", "en-US").replace(/\s/g, " ")).toBe("12:15 AM");
  });

  test("German reads what people type, never a day period", () => {
    for (const [typed, hhmm] of [
      ["14:30", "14:30"],
      ["1430", "14:30"],
      ["930", "09:30"],
      ["9", "09:00"],
      ["9.30", "09:30"],
      ["9,30", "09:30"],
      [" 23 59 ", "23:59"],
      ["0:00", "00:00"],
    ])
      expect(parseTime(typed!, "de")).toBe(hhmm);
    for (const typed of ["", "24:00", "12:60", "12345", "1:2:3", "2:30 pm", "abends"]) expect(parseTime(typed, "de")).toBeUndefined();
  });

  test("American English reads a day period and also the 24-hour clock", () => {
    expect(parseTime("2:30 PM", "en-US")).toBe("14:30");
    expect(parseTime("2:30pm", "en-US")).toBe("14:30");
    expect(parseTime("2:30 p", "en-US")).toBe("14:30");
    expect(parseTime("12:15 am", "en-US")).toBe("00:15");
    expect(parseTime("12 pm", "en-US")).toBe("12:00");
    expect(parseTime("14:30", "en-US")).toBe("14:30");
    expect(parseTime("13:00 pm", "en-US")).toBeUndefined();
    expect(parseTime(formatTime("09:45", "en-US"), "en-US")).toBe("09:45");
  });

  test("the arrows turn the hour or the minute round the clock; the caret decides which", () => {
    expect(stepTime("23:30", "hour", 1)).toBe("00:30");
    expect(stepTime("00:30", "hour", -1)).toBe("23:30");
    expect(stepTime("14:59", "minute", 1)).toBe("14:00");
    expect(stepTime("14:00", "minute", -1)).toBe("14:59");
    expect(caretInHour("14:30", 0)).toBe(true);
    expect(caretInHour("14:30", 2)).toBe(true);
    expect(caretInHour("14:30", 3)).toBe(false);
    expect(caretInHour("2:30 PM", 1)).toBe(true);
    expect(caretInHour("2:30 PM", 4)).toBe(false);
  });
});
