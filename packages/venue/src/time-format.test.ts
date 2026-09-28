import { afterEach, describe, expect, test } from "bun:test";
import { formatDateKey, formatVenueDateTime, formatVenueSpan, formatVenueTime, timeZoneName } from "./time-format";

// A Berlin shift from 14:00 to 18:00 local time (CEST, UTC+2).
const startsAt = "2026-09-28T12:00:00.000Z";
const endsAt = "2026-09-28T16:00:00.000Z";
const originalTimeZone = process.env.TZ;

afterEach(() => {
  process.env.TZ = originalTimeZone;
});

describe("Venue time formatting", () => {
  test("shows the Venue's wall-clock time on a 24-hour clock in every locale", () => {
    expect(formatVenueSpan(startsAt, endsAt, "Europe/Berlin", "en")).toBe("Mon, Sep 28 · 14:00–18:00");
    expect(formatVenueSpan(startsAt, endsAt, "Europe/Berlin", "de")).toBe("Mo., 28. Sept. · 14:00–18:00");
    expect(formatVenueTime(startsAt, "Europe/Berlin", "en-US")).toBe("14:00");
    expect(formatVenueDateTime(startsAt, "Europe/Berlin", "de")).toBe("Mo., 28. Sept., 14:00");
  });

  test("does not depend on the time zone of the device that renders it", () => {
    for (const deviceZone of ["UTC", "Pacific/Auckland", "America/Los_Angeles"]) {
      process.env.TZ = deviceZone;
      expect({ deviceZone, text: formatVenueSpan(startsAt, endsAt, "Europe/Berlin", "en") }).toEqual({
        deviceZone,
        text: "Mon, Sep 28 · 14:00–18:00",
      });
      expect({ deviceZone, day: formatDateKey("2026-10-11", "de", { weekday: "short", day: "numeric", month: "short" }) }).toEqual({
        deviceZone,
        day: "So., 11. Okt.",
      });
    }
  });

  test("names the time zone in the reader's language", () => {
    expect(timeZoneName("Europe/Berlin", "en", new Date(startsAt))).toBe("Central European Time");
    expect(timeZoneName("Europe/Berlin", "de", new Date(startsAt))).toBe("Mitteleuropäische Zeit");
  });
});
