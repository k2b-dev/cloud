import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { fail } from "@k2b/stdlib";
import { geoService } from "../../server";
import * as settings from "../settings";
import { weatherCityService } from "./geo";

afterEach(() => mock.restore());

test("city search reports missing Geo configuration without calling the backend", async () => {
  spyOn(settings, "get").mockResolvedValue("  ");
  const list = spyOn(geoService.place, "list");
  const result = await weatherCityService.list({ filter: { query: "Ulm" } });
  expect(result).toMatchObject({ ok: false, error: { code: "WEATHER_CITY_SEARCH_NOT_CONFIGURED", status: 500 } });
  if (result.ok) throw new Error("Expected configuration failure");
  expect(result.error.message).toBe("Geo API URL is not configured. Set weather.geo_url.");
  expect(list).not.toHaveBeenCalled();
});

test("Geo backend failures return a neutral message without exposing backend details", async () => {
  spyOn(settings, "get").mockResolvedValue("http://geo.invalid");
  spyOn(geoService.place, "list").mockResolvedValue(fail({ code: "INTERNAL", status: 500, message: "private backend body" }));
  const result = await weatherCityService.list({ filter: { query: "Ulm" } });
  expect(result).toMatchObject({ ok: false, error: { code: "WEATHER_CITY_SEARCH_UNAVAILABLE", status: 500 } });
  if (result.ok) throw new Error("Expected backend failure");
  expect(result.error.message).toBe("Weather city search is unavailable");
  expect(result.error.message).not.toContain("private backend body");
});
