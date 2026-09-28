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

  test("says how many people are missing in the singular and the plural", () => {
    const de = venueMessages.resolve(["de"]).t;
    const en = venueMessages.resolve(["en"]).t;
    expect([de.missing({ count: 1 }), de.missing({ count: 2 })]).toEqual(["1 fehlt", "2 fehlen"]);
    expect([en.missing({ count: 1 }), en.missing({ count: 2 })]).toEqual(["1 missing", "2 missing"]);
    expect(de.staffed({ assigned: 0, target: "1–3" })).toBe("0 von 1–3 besetzt");
    expect(en.staffed({ assigned: 0, target: "1–3" })).toBe("0 of 1–3 staffed");
  });

  test("words shift work so it does not read as signing in", () => {
    const de = venueMessages.resolve(["de"]).t;
    const en = venueMessages.resolve(["en"]).t;
    expect([en.signUp, en.leave, en.openSpots, en.closedDays]).toEqual(["Take shift", "Leave", "Free spots", "Exceptions"]);
    expect([de.signUp, de.leave, de.openSpots, de.closedDays]).toEqual(["Schicht übernehmen", "Austreten", "Freie Plätze", "Ausnahmen"]);
    expect(Object.values(de).filter((value) => typeof value === "string" && /\banmelden\b/i.test(value))).toEqual([]);
  });

  test("localizes built-in templates without changing their stable IDs", () => {
    expect(listVenueTemplates("de-DE").map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "service-desk", name: "Serviceschalter" },
      { id: "cafe-counter", name: "Café-Theke" },
    ]);
    expect(getVenueTemplate("service-desk", "de")?.sections[0]?.title).toBe("Vor deinem Besuch");
  });
});
