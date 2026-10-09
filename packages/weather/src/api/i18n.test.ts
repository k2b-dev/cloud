import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { weatherService } from "@k2b/cloud/services";
import { fail } from "@k2b/stdlib";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import app from ".";

afterEach(() => mock.restore());

// These API contracts exercise the real services behind the routes, so they need the test database.
const suite = databaseSuite();

suite("Weather API locale", () => {
  test("localizes human-facing failures from the request without changing the status", async () => {
    spyOn(weatherService.forecast, "get").mockResolvedValue(null);

    const german = await app.request("http://weather.test/?lat=48&lon=9", {
      headers: { "Accept-Language": "de-CH,de;q=0.9" },
    });
    const english = await app.request("http://weather.test/?lat=48&lon=9", {
      headers: { "Accept-Language": "en" },
    });

    expect(german.status).toBe(500);
    expect(await german.json()).toMatchObject({ message: "Die Wetterdaten konnten nicht abgerufen werden" });
    expect(english.status).toBe(500);
    expect(await english.json()).toMatchObject({ message: "Failed to fetch weather data" });
  }, 15_000);

  test("localizes request validation errors", async () => {
    const coordinates = await app.request("http://weather.test/?lat=invalid", {
      headers: { "Accept-Language": "de" },
    });
    const city = await app.request("http://weather.test/forecast/by-city?q=", {
      headers: { "Accept-Language": "de" },
    });

    expect(coordinates.status).toBe(400);
    expect(await coordinates.json()).toEqual({ message: "Gib gültige Koordinaten ein" });
    expect(city.status).toBe(400);
    expect(await city.json()).toEqual({ message: "Gib einen gültigen Suchbegriff ein" });
  });
  // The services below supply the route results; the suite provides rate-limit storage.
  describe("city search error presentation", () => {
    for (const [locale, notConfigured, geoFailure, forecastFailure] of [
      [
        "en",
        "City search is not set up. An administrator can set the Geo API URL in the Weather settings.",
        "Location search is unavailable",
        "Failed to fetch weather data",
      ],
      [
        "de",
        "Die Städtesuche ist nicht eingerichtet. Ein Administrator kann die URL der Geo-API in den Wetter-Einstellungen festlegen.",
        "Die Ortssuche ist nicht verfügbar",
        "Die Wetterdaten konnten nicht abgerufen werden",
      ],
    ] as const) {
      test(`keeps city search failures human-facing in ${locale}`, async () => {
        for (const code of ["WEATHER_CITY_SEARCH_NOT_CONFIGURED", "WEATHER_CITY_SEARCH_UNAVAILABLE"] as const) {
          const failure = fail({ code, status: 500, message: 'private details: source.kind = "coordinates"' });
          spyOn(weatherService.location.city, "list").mockResolvedValue(failure);
          spyOn(weatherService.forecast, "getByCityName").mockResolvedValue(failure);
          for (const [path, unavailable] of [
            ["/geo/search?q=Ulm", geoFailure],
            ["/forecast/by-city?q=Ulm", forecastFailure],
          ]) {
            const response = await app.request(`http://weather.test${path}`, { headers: { "Accept-Language": locale } });
            expect(response.status).toBe(500);
            expect(await response.json()).toEqual({
              code,
              message: code === "WEATHER_CITY_SEARCH_NOT_CONFIGURED" ? notConfigured : unavailable,
            });
          }
        }
      });
    }
  });
});
