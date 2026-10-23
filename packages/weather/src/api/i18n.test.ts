import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { weatherService } from "@k2b/cloud/services";
import { session } from "@k2b/cloud/services/session";
import { buildProjectedUser } from "@k2b/cloud/services/session/user";
import { fail } from "@k2b/stdlib";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import app from ".";

afterEach(() => mock.restore());

// These API contracts exercise the real services behind the routes, so they need the test database.
const suite = databaseSuite();

suite("Weather API locale", () => {
  beforeEach(() => {
    const user = buildProjectedUser({
      id: "11111111-1111-4111-8111-111111111111",
      uid: "weather-fixture",
      provider: "local",
      profile: "user",
    });
    spyOn(session, "authenticateRequest").mockResolvedValue({
      user,
      data: { userId: user.id, sid: "fixture", authEpoch: 0, kind: "web", expiresAt: "2099-01-01T00:00:00Z" },
    });
  });
  test("localizes human-facing failures from the request without changing the status", async () => {
    spyOn(weatherService.forecast, "get").mockResolvedValue(null);

    const german = await app.request("http://weather.test/?lat=48&lon=9", {
      headers: { Cookie: "session_token=fixture", "Accept-Language": "de-CH,de;q=0.9" },
    });
    const english = await app.request("http://weather.test/?lat=48&lon=9", {
      headers: { Cookie: "session_token=fixture", "Accept-Language": "en" },
    });

    expect(german.status).toBe(500);
    expect(await german.json()).toMatchObject({ message: "Die Wetterdaten konnten nicht abgerufen werden" });
    expect(english.status).toBe(500);
    expect(await english.json()).toMatchObject({ message: "Failed to fetch weather data" });
  }, 15_000);

  test("localizes request validation errors", async () => {
    const coordinates = await app.request("http://weather.test/?lat=invalid", {
      headers: { Cookie: "session_token=fixture", "Accept-Language": "de" },
    });
    const city = await app.request("http://weather.test/forecast/by-city?q=", {
      headers: { Cookie: "session_token=fixture", "Accept-Language": "de" },
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
        "City search is not set up. An administrator can configure Places and maps in Core.",
        "Location search is unavailable",
        "Failed to fetch weather data",
      ],
      [
        "de",
        "Die Städtesuche ist nicht eingerichtet. Ein Administrator kann Orte und Karten in Core einrichten.",
        "Die Ortssuche ist nicht verfügbar",
        "Die Wetterdaten konnten nicht abgerufen werden",
      ],
    ] as const) {
      test(`keeps city search failures human-facing in ${locale}`, async () => {
        for (const code of ["GEO_NOT_CONFIGURED", "GEO_PROVIDER_FAILED"] as const) {
          const failure = fail({ code, status: 500, message: 'private details: source.kind = "coordinates"' });
          spyOn(weatherService.location.city, "list").mockResolvedValue(failure);
          spyOn(weatherService.forecast, "getByCityName").mockResolvedValue(failure);
          for (const [path, unavailable] of [
            ["/geo/search?q=Ulm", geoFailure],
            ["/forecast/by-city?q=Ulm", forecastFailure],
          ]) {
            const response = await app.request(`http://weather.test${path}`, {
              headers: { Cookie: "session_token=fixture", "Accept-Language": locale },
            });
            expect(response.status).toBe(500);
            expect(await response.json()).toMatchObject({
              code,
              message: code === "GEO_NOT_CONFIGURED" ? notConfigured : unavailable,
            });
          }
        }
      });
    }
  });
});

suite("Weather geo authority and recovery", () => {
  test("anonymous city lookups never reach the paid adapter", async () => {
    spyOn(session, "authenticateRequest").mockResolvedValue(null);
    const search = spyOn(weatherService.location.city, "list");
    for (const path of ["/geo/search?q=Ulm", "/forecast/by-city?q=Ulm"]) {
      expect((await app.request(`http://weather.test${path}`)).status).toBe(401);
    }
    expect(search).not.toHaveBeenCalled();
  });
});
