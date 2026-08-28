import { describe, expect, test } from "bun:test";
import { weatherHelp } from ".";

describe("weatherHelp", () => {
  test("owns the existing Weather help as Markdown", () => {
    expect(weatherHelp.documents.map((document) => document.id)).toEqual(["weather-start", "weather-read", "weather-troubleshooting"]);

    expect(weatherHelp.getMarkdown("weather-start")).toContain("Weather tracks saved locations");
    expect(weatherHelp.getMarkdown("weather-start")).toContain("location search is limited to German cities");
    const startHtml = weatherHelp.documents.find((document) => document.id === "weather-start")?.html;
    expect(startHtml).toContain('<h2 id="use-weather" class="help-section-title"');
    expect(startHtml).toContain("<span>Use Weather</span>");
    expect(weatherHelp.getMarkdown("weather-read")).toContain("Choose the forecast section");
    expect(weatherHelp.getMarkdown("weather-troubleshooting")).toContain("Search currently covers German cities");
  });

  test("ships matching German help and resolves regional fallbacks", () => {
    const english = weatherHelp.documentsByLocale?.en ?? [];
    const german = weatherHelp.documentsByLocale?.de ?? [];

    expect(german.map((document) => document.id)).toEqual(english.map((document) => document.id));
    for (const document of german) {
      const base = english.find((candidate) => candidate.id === document.id);
      expect(base).toBeDefined();
      expect(document.icon).toBe(base!.icon!);
      expect(document.order).toBe(base!.order);
    }

    expect(weatherHelp.getMarkdown("weather-start", "de")).toContain("Wetter verwaltet gespeicherte Orte");
    expect(weatherHelp.getMarkdown("weather-read", "de-CH")).toBe(weatherHelp.getMarkdown("weather-read", "de")!);
    expect(weatherHelp.getMarkdown("weather-troubleshooting", "fr")).toBe(weatherHelp.getMarkdown("weather-troubleshooting")!);
  });
});
