import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { weatherService } from "@k2b/cloud/services";
import app from ".";

afterEach(() => mock.restore());

describe("Weather API locale", () => {
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
});
