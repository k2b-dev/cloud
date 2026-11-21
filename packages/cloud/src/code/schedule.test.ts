import { expect, test } from "bun:test";
import { describeCodeSchedule, describeCodeTiming, formatCodeDay, formatCodeMoment } from "@k2b/cloud/code/schedule";
import * as ssrSchedule from "@k2b/cloud/ssr/code-schedule";

test("the portable public schedule export and existing SSR entry share one implementation", () => {
  expect(ssrSchedule.describeCodeSchedule).toBe(describeCodeSchedule);
  expect(ssrSchedule.describeCodeTiming).toBe(describeCodeTiming);
});

test("schedule sentences preserve localized common shapes and unfamiliar expressions", () => {
  expect(describeCodeSchedule("0 8 * * 1-5", "de")).toBe("Mo–Fr 08:00");
  expect(describeCodeSchedule("30 6 * * *", "en")).toBe("daily 06:30");
  expect(describeCodeSchedule("*/15 * * * *", "de")).toBe("alle 15 Minuten");
  expect(describeCodeSchedule("0 7 * 1 *", "de")).toBe("0 7 * 1 *");
});

test("timing prioritizes the one-time instant and includes its explicit zone", () => {
  const input = { at: "2026-11-15T10:00:00.000Z", timeZone: "Europe/Berlin", cron: "0 7 * * *" };
  expect(describeCodeTiming(input, "de-DE")).toBe("15.11.2026, 11:00 (Europe/Berlin)");
  expect(describeCodeTiming(input, "en-GB")).toBe("15 Nov 2026, 11:00 (Europe/Berlin)");
  expect(describeCodeTiming({ cron: "30 6 * * *" }, "en")).toBe("daily 06:30");
  expect(describeCodeTiming({}, "de")).toBeNull();
});

test("minute schedules name inclusive hour ranges and weekday restrictions", () => {
  expect(describeCodeSchedule("* 7-20 * * *", "de")).toBe("Jede Minute von 7:00 bis 20:59 Uhr");
  expect(describeCodeSchedule("* 7-20 * * *", "en")).toBe("Every minute between 7:00 and 20:59");
  expect(describeCodeSchedule("*/5 7-20 * * 1-5", "de")).toBe("Alle 5 Minuten von 7:00 bis 20:59 Uhr · Mo–Fr");
  expect(describeCodeSchedule("* 7 * * *", "de")).toBe("Jede Minute von 7:00 bis 7:59 Uhr");
  expect(describeCodeSchedule("* 7-7 * * *", "de")).toBe("Jede Minute von 7:00 bis 7:59 Uhr");
  expect(describeCodeSchedule("* * * * *", "en")).toBe("Every minute");
  expect(describeCodeSchedule("*/15 * * * 1,3", "en")).toBe("Every 15 minutes · Mon, Wed");
  for (const cron of ["* 20-7 * * *", "* 7-24 * * *", "*/0 7-20 * * *", "* 7-20 1 * *"])
    expect(describeCodeSchedule(cron, "de")).toBe(cron);
});

test("a Code moment names today, else weekday, day and time, and the year only outside the current one", () => {
  // Monday, 16 November 2026, 09:00 in Berlin.
  const now = new Date("2026-11-16T08:00:00.000Z");
  const de = { locale: "de", timeZone: "Europe/Berlin", now };
  expect(formatCodeMoment("2026-11-16T06:30:00.000Z", de)).toBe("heute, 07:30");
  expect(formatCodeMoment("2026-11-15T14:28:00.000Z", de)).toBe("So, 15.11., 15:28");
  expect(formatCodeMoment("2026-11-23T06:00:00.000Z", de)).toBe("Mo, 23.11., 07:00");
  expect(formatCodeMoment("2025-11-15T14:28:00.000Z", de)).toBe("Sa, 15.11.2025, 15:28");
  // The day is the person's: 23:30 UTC on the 15th is already the 16th in Berlin.
  expect(formatCodeMoment("2026-11-15T23:30:00.000Z", de)).toBe("heute, 00:30");
  expect(formatCodeMoment("2026-11-15T14:28:00.000Z", { locale: "en", timeZone: "Europe/Berlin", now })).toBe("Sun, 11/15, 15:28");
  // An unknown zone reads in UTC instead of failing.
  expect(formatCodeMoment("2026-11-15T14:28:00.000Z", { ...de, timeZone: "Nowhere/City" })).toBe("So, 15.11., 14:28");
});

test("a Code day is the same moment without its time, with the same fixed weekday words", () => {
  const now = new Date("2026-11-16T08:00:00.000Z");
  const de = { locale: "de", timeZone: "Europe/Berlin", now };
  expect(formatCodeDay("2026-11-16T06:30:00.000Z", de)).toBe("heute");
  expect(formatCodeDay("2026-11-23T06:00:00.000Z", de)).toBe("Mo, 23.11.");
  expect(formatCodeDay("2025-11-15T14:28:00.000Z", de)).toBe("Sa, 15.11.2025");
  expect(formatCodeDay("2026-11-23T06:00:00.000Z", { locale: "en", timeZone: "Europe/Berlin", now })).toBe("Mon, 11/23");
  // The day part reads exactly as in the moment.
  expect(formatCodeMoment("2026-11-23T06:00:00.000Z", de).startsWith(`${formatCodeDay("2026-11-23T06:00:00.000Z", de)}, `)).toBe(true);
});
