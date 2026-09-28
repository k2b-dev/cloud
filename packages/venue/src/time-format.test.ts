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

  test("names the time zone as it applies to the times shown, in the reader's language", () => {
    expect(timeZoneName("Europe/Berlin", "en", [startsAt, endsAt])).toBe("Central European Summer Time");
    expect(timeZoneName("Europe/Berlin", "de", [startsAt, endsAt])).toBe("Mitteleuropäische Sommerzeit");
    expect(timeZoneName("Europe/Berlin", "de", ["2026-12-07T09:00:00.000Z"])).toBe("Mitteleuropäische Normalzeit");
    // Berlin leaves summer time on 2026-10-25, so a week around it shows times in both.
    expect(timeZoneName("Europe/Berlin", "de", ["2026-10-22T09:00:00.000Z", "2026-10-28T10:00:00.000Z"])).toBe(
      "Mitteleuropäische Sommerzeit und Mitteleuropäische Normalzeit",
    );
    expect(timeZoneName("Asia/Tokyo", "en", [startsAt])).toBe("Japan Standard Time");
  });
});
