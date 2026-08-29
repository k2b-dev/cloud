import { describe, expect, test } from "bun:test";
import { venueMessages } from "./messages";
import { getVenueTemplate, listVenueTemplates } from "./templates";

describe("Venue internationalization", () => {
  test("ships a complete German catalog", () => {
    expect(venueMessages.check()).toEqual([]);
  });

  test("resolves regional German tags and falls back to English", () => {
    expect(venueMessages.resolve(["de-CH"]).t.appName).toBe("Standorte");
    expect(venueMessages.resolve(["fr"]).t.appName).toBe("Venues");
  });

  test("localizes built-in templates without changing their stable IDs", () => {
    expect(listVenueTemplates("de-DE").map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "service-desk", name: "Serviceschalter" },
      { id: "cafe-counter", name: "Café-Theke" },
    ]);
    expect(getVenueTemplate("service-desk", "de")?.sections[0]?.title).toBe("Vor deinem Besuch");
  });
});
