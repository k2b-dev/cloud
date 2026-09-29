import { describe, expect, test } from "bun:test";
import { venueCapabilityPresentation } from "./capability-presentation";
import { venueMessages } from "./messages";
import { getVenueTemplate, listVenueTemplates } from "./templates";

describe("Venue internationalization", () => {
  test("ships a complete German catalog", () => {
    expect(venueMessages.check()).toEqual([]);
  });

  test("keeps interface texts plain, without Markdown code marks that fields would show as is", () => {
    for (const locale of ["en", "de"]) {
      const texts = Object.entries(venueMessages.resolve([locale]).t).filter(([, value]) => typeof value === "string");
      expect({ locale, marked: texts.filter(([, value]) => String(value).includes("`")).map(([key]) => key) }).toEqual({
        locale,
        marked: [],
      });
    }
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
    expect([en.signUp, en.leave, en.openSpots, en.exceptions]).toEqual(["Take shift", "Leave", "Free spots", "Exceptions"]);
    expect([de.signUp, de.leave, de.openSpots, de.exceptions]).toEqual(["Schicht übernehmen", "Austreten", "Freie Plätze", "Ausnahmen"]);
    expect(Object.values(de).filter((value) => typeof value === "string" && /\banmelden\b/i.test(value))).toEqual([]);
  });

  test("lets the assistant confirm shift work in the workspace's words", () => {
    const de = venueMessages.resolve(["de"]).t;
    const shift = { title: "Theke", venue: "Café am Markt" };
    expect([
      de.capabilitySignupReview(shift),
      de.capabilitySignedUp(shift),
      de.capabilityFreeReview(shift),
      de.capabilityFreeSignedUp(shift),
      de.capabilityCancelReview(shift),
      de.capabilityCancelled(shift),
    ]).toEqual([
      "Schicht „Theke“ bei Café am Markt übernehmen.",
      "Schicht „Theke“ bei Café am Markt übernommen.",
      "Freie Schicht bei Café am Markt hinzufügen.",
      "Freie Schicht bei Café am Markt hinzugefügt.",
      "Aus deiner Schicht bei Café am Markt austreten.",
      "Du bist aus deiner Schicht bei Café am Markt ausgetreten.",
    ]);
  });

  test("describes assistant capabilities in German the way the workspace speaks: du and Standort", () => {
    const texts = (value: unknown): string[] =>
      typeof value === "string" ? [value] : typeof value === "object" && value ? Object.values(value).flatMap(texts) : [];
    const german = texts(venueCapabilityPresentation.translations.de);
    expect(german.length).toBeGreaterThan(50);
    expect(german.filter((text) => /\b(Sie|Ihre?[mnrs]?)\b|\bVenues?\b/.test(text))).toEqual([]);
  });

  test("localizes built-in templates without changing their stable IDs", () => {
    expect(listVenueTemplates("de-DE").map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "service-desk", name: "Serviceschalter" },
      { id: "cafe-counter", name: "Café-Theke" },
    ]);
    expect(getVenueTemplate("service-desk", "de")?.sections[0]?.title).toBe("Vor deinem Besuch");
  });
});
