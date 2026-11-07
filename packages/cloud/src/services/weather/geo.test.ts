import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { geoClient } from "../../capabilities/geo-client";
import { geoProvenance } from "../geo/geoapify";
import { weatherCityService } from "./geo";

afterEach(() => mock.restore());
const caller = { cookie: "synthetic-session", locale: "de", signal: new AbortController().signal };
const provenance = geoProvenance(new Date("2026-10-20T12:00:00Z"));

test("city search forwards the caller, cancellation and German city filter to Core", async () => {
  const autocomplete = spyOn(geoClient, "autocomplete").mockResolvedValue({
    ok: true,
    data: {
      data: {
        suggestions: [
          {
            line1: "",
            postalCode: "",
            city: "Ulm",
            stateRegion: "Baden-Württemberg",
            countryCode: "DE",
            point: { lat: 48.4, lon: 9.99 },
            formatted: "Ulm, Deutschland",
            confidence: 1,
            buildingConfidence: null,
            provenance,
          },
        ],
        provenance,
      },
    },
  });
  const result = await weatherCityService.list({ caller, filter: { query: " Ulm " }, pagination: { page: 1, perPage: 25 } });
  expect(autocomplete).toHaveBeenCalledWith({ text: "Ulm", countryCode: "DE", type: "city", limit: 5 }, caller);
  expect(result).toEqual({
    ok: true,
    data: {
      items: [{ name: "Ulm", lat: 48.4, lon: 9.99, country: "DE", state: "Baden-Württemberg", provenance }],
      page: 1,
      perPage: 5,
      total: 1,
      hasNext: false,
    },
  });
});

test("short queries, later pages and unsupported countries do not consume credits", async () => {
  const autocomplete = spyOn(geoClient, "autocomplete");
  expect(await weatherCityService.list({ caller, filter: { query: "Ul" } })).toMatchObject({ ok: true, data: { items: [] } });
  expect(await weatherCityService.list({ caller, filter: { query: "Ulm" }, pagination: { page: 2, perPage: 5 } })).toMatchObject({
    ok: true,
    data: { items: [] },
  });
  expect(await weatherCityService.list({ caller, filter: { query: "Paris", country: "FR" } })).toMatchObject({
    ok: false,
    error: { code: "BAD_INPUT" },
  });
  expect(autocomplete).not.toHaveBeenCalled();
});

test("Core configuration, budget and recovery details survive the Weather adapter", async () => {
  const error = {
    code: "GEO_BUDGET_EXHAUSTED",
    message: "Budget exhausted",
    status: 429 as const,
    details: { scope: "person", resetsAt: "2026-10-21T00:00:00Z" },
  };
  spyOn(geoClient, "autocomplete").mockResolvedValue({ ok: false, error });
  expect(await weatherCityService.list({ caller, filter: { query: "Ulm" } })).toEqual({ ok: false, error });
});
