import { expect, test } from "bun:test";
import { mapOpeningHours } from "./map-opening-hours";

test("today uses the reader's current local day, with unknown and unsupported hours preserved", () => {
  const weekly = "Mo 10:00-17:00; Tu-Su off";
  expect(mapOpeningHours(weekly, "2026-10-19T14:31:00.000Z", "Europe/Berlin", "de")).toBe("heute 10:00–17:00 Uhr");
  expect(mapOpeningHours(weekly, "2026-10-22T14:31:00.000Z", "Europe/Berlin", "de")).toBe("heute geschlossen");
  expect(mapOpeningHours(weekly, "2026-10-18T23:30:00.000Z", "Europe/Berlin", "en")).toBe("today 10:00–17:00");
  expect(mapOpeningHours(undefined, "2026-10-22T14:31:00.000Z", "Europe/Berlin", "de")).toBe("Öffnungszeiten unbekannt");
  for (const hours of ["Mo-Su sunrise-sunset", "Mo-Su 25:00-26:99", "Mo-Su 24:00-24:00", "PH off"])
    expect(mapOpeningHours(hours, "2026-10-22T14:31:00.000Z", "Europe/Berlin", "de")).toBe(hours);
});
