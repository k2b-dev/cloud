import { describe, expect, test } from "bun:test";
import { hourCycleOf, readTime, timeExample } from "./time-text";

describe("a time read from text", () => {
  const cases: [text: string, locale: string, time: string | undefined][] = [
    ["14:30", "de", "14:30"],
    ["1430", "de", "14:30"],
    ["930", "de", "09:30"],
    ["0930", "de", "09:30"],
    ["9", "de", "09:00"],
    ["9:30", "de", "09:30"],
    ["9.30", "de", "09:30"],
    ["17,05", "de", "17:05"],
    ["14:30:00", "de", "14:30"],
    ["14:30:15", "de", "14:30"],
    ["14 Uhr", "de", "14:00"],
    ["14:30 Uhr", "de", "14:30"],
    ["14h30", "de", "14:30"],
    ["１４：３０", "de", "14:30"],
    ["  08:05  ", "de", "08:05"],
    ["02:30 PM", "en-US", "14:30"],
    ["2:30pm", "en-US", "14:30"],
    ["2:30 p", "en-US", "14:30"],
    ["12:15 am", "en-US", "00:15"],
    ["12 pm", "en-US", "12:00"],
    ["14:30", "en-US", "14:30"],
    // a day period is unambiguous on a 24-hour clock too
    ["2:30 PM", "en-GB", "14:30"],
    ["2:30 PM", "de", "14:30"],
    // digits of other scripts, as a locale may write them
    ["٢:٣٠ م", "ar-EG", "14:30"],
    ["۱۴:۳۰", "fa", "14:30"],
    // a pasted date is no time: seconds come only after colons
    ["12.11.26", "de", undefined],
    ["12.11.2026", "de", undefined],
    ["14.30.00", "de", undefined],
    ["", "de", undefined],
    ["   ", "de", undefined],
    ["abends", "de", undefined],
    ["24:00", "de", undefined],
    ["12:60", "de", undefined],
    ["12345", "de", undefined],
    ["14:30:60", "de", undefined],
    ["1:2:3:4", "de", undefined],
    ["13:00 pm", "en-US", undefined],
    ["0 am", "en-US", undefined],
  ];
  for (const [text, locale, time] of cases)
    test(`${JSON.stringify(text)} in ${locale} is ${time ?? "no time"}`, () => {
      expect(readTime(text, locale)).toBe(time);
    });
});

describe("the clock and the example of a locale", () => {
  test("German and British English count 24 hours, American English twelve", () => {
    expect([hourCycleOf("de"), hourCycleOf("en-GB"), hourCycleOf("en-US")]).toEqual([24, 24, 12]);
  });
  test("the example of every locale is read back as 14:30", () => {
    for (const locale of ["de", "en-GB", "en-US", "ar-EG", "fa", "hi-IN", "ja"])
      expect(readTime(timeExample(locale), locale)).toBe("14:30");
  });
  test("the example is 14:30 in the locale's own form", () => {
    expect(timeExample("de")).toBe("14:30");
    expect(timeExample("en-GB")).toBe("14:30");
    expect(timeExample("en-US").replace(/\s/g, " ")).toBe("2:30 PM");
  });
});
