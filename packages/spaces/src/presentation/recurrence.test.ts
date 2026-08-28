import { describe, expect, test } from "bun:test";
import type { Recurrence } from "@/contracts";
import { recurrenceMessages, summarizeRecurrence } from "./recurrence";

const recurrence = (rrule: string): Recurrence => ({
  rrule,
  dtstart: "2026-08-14T09:00:00.000Z",
  exdate: [],
});

describe("Spaces recurrence summaries", () => {
  test("keeps translations complete and falls back from regional German locales", () => {
    expect(recurrenceMessages.check()).toEqual([]);
    expect(
      summarizeRecurrence(recurrence("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=2"), {
        startsAt: "2026-08-14T09:00:00.000Z",
        dateConfig: { timeZone: "UTC", locale: "de-CH" },
      }),
    ).toBe("Wiederholt sich jeden Montag und Mittwoch um 09:00 Uhr für 2 Termine");
  });

  test("describes selected weekly days, time, and end date", () => {
    expect(
      summarizeRecurrence(recurrence("FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20260815T235959Z"), {
        startsAt: "2026-08-14T09:00:00.000Z",
        dateConfig: { timeZone: "UTC", locale: "en" },
      }),
    ).toBe("Repeats every Monday and Wednesday at 09:00 until Sat 15 Aug 2026");
  });

  test("uses the start weekday when no weekly days are selected", () => {
    expect(
      summarizeRecurrence(recurrence("FREQ=WEEKLY;COUNT=6"), {
        startsAt: "2026-08-14T09:00:00.000Z",
        dateConfig: { timeZone: "UTC", locale: "en" },
      }),
    ).toBe("Repeats every Friday at 09:00 for 6 occurrences");
  });

  test("omits the time for all-day events", () => {
    expect(
      summarizeRecurrence(recurrence("FREQ=MONTHLY;INTERVAL=2"), {
        startsAt: "2026-08-14T00:00:00.000Z",
        allDay: true,
        dateConfig: { timeZone: "UTC", locale: "en" },
      }),
    ).toBe("Repeats every 2 months on day 14");
  });
});
