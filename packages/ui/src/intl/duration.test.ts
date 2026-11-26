import { expect, test } from "bun:test";
import { chartMessages } from "../content/chart-message-catalog";
import { durationIn, durationWords } from "./duration";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

test("a span reads as the calendar writes it, from seconds to days", () => {
  expect(
    [4 * SECOND, 2.5 * SECOND, 42 * SECOND, 12 * MINUTE, HOUR, 90 * MINUTE, 2 * HOUR, 26 * HOUR, 48 * HOUR].map(durationWords.de),
  ).toEqual(["4 Sek.", "2,5 Sek.", "42 Sek.", "12 Min", "1 Std.", "1 Std. 30", "2 Std.", "1 Tag 2 Std.", "2 Tage"]);
  expect([4 * SECOND, 2.5 * SECOND, 12 * MINUTE, HOUR, 90 * MINUTE, 2 * HOUR, 26 * HOUR, 48 * HOUR].map(durationWords.en)).toEqual([
    "4 sec",
    "2.5 sec",
    "12 min",
    "1 hr",
    "1 hr 30 min",
    "2 hrs",
    "1 day 2 hr",
    "2 days",
  ]);
  // half a minute up rounds to the next minute, a span just short of a day to the day
  expect(durationWords.en(59.6 * SECOND)).toBe("1 min");
  expect(durationWords.de(24 * HOUR - 20 * SECOND)).toBe("1 Tag");
});

test("the chart's catalog and a drawing without one give the same words", () => {
  for (const locale of ["de", "en"] as const) {
    const t = chartMessages.resolve([locale]).t;
    for (const span of [4 * SECOND, 12 * MINUTE, 90 * MINUTE, 26 * HOUR])
      expect(t.chartDuration({ milliseconds: span })).toBe(durationIn(locale)(span));
  }
  expect(durationIn("de-AT")).toBe(durationWords.de);
  expect(durationIn("fr")).toBe(durationWords.en);
});
