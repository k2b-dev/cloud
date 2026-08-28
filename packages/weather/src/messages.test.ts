import { describe, expect, test } from "bun:test";
import { weatherWidgetEmptyBody, weatherWidgetUnavailableBody } from "./api/widgets";
import { weatherConditionLabel, weatherMessages } from "./messages";

describe("Weather internationalization", () => {
  test("ships a complete German catalog", () => {
    expect(weatherMessages.check()).toEqual([]);
  });

  test("resolves German regional tags and unknown-locale fallback", () => {
    const swissGerman = weatherMessages.resolve(["de-CH"]);
    expect(swissGerman.locale).toBe("de");
    expect(swissGerman.t.weatherUnavailable).toBe("Wetterdaten nicht verfügbar");
    expect(weatherMessages.resolve(["fr"]).t.weatherUnavailable).toBe("Weather data unavailable");
  });

  test("localizes meteorological condition labels and widget states", () => {
    const german = weatherMessages.resolve(["de-CH"]).t;
    expect(weatherConditionLabel("sleet", german)).toBe("Schneeregen");
    expect(weatherConditionLabel("unknown-provider-code", german)).toBe("bewölkt");
    expect(weatherWidgetEmptyBody("de-CH")).toMatchObject({
      title: "Wetter",
      blocks: [{ title: "Noch keine Orte gespeichert" }],
    });
    expect(weatherWidgetUnavailableBody("de-CH")).toMatchObject({
      title: "Wetter",
      blocks: [{ title: "Wetter nicht verfügbar", message: "Gespeicherte Orte konnten nicht geladen werden." }],
    });
  });
});
